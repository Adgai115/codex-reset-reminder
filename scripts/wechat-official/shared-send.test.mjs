import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WechatProbe } from './controller.mjs';
import { createSharedWechatSender } from './shared-send.mjs';

function fixture(sendText = async () => ({ confirmation: 'accepted' })) {
  let now = 100000;
  const persisted = [], statuses = [];
  const probe = new WechatProbe({ client: { sendText }, renderQr: () => '', now: () => now,
    storage: { async write(value) { persisted.push(structuredClone(value)); }, async writeStatus(status) { statuses.push(structuredClone(status)); } },
  });
  probe.session = { token: 'synthetic-token', userId: 'synthetic-peer', baseUrl: 'https://ilinkai.weixin.qq.com' };
  probe.phase = 'bound';
  return { probe, persisted, statuses, send: createSharedWechatSender(probe), advance: () => { now += 15000; } };
}

test('shared sends stay out of probe persistence and reuse context only in main transport', async () => {
  let input;
  const f = fixture(async (_session, value) => { input = value; return { confirmation: 'accepted' }; });
  f.probe.contextToken = 'private-context';
  assert.deepEqual(await f.send('agent-private-notification', { clientId: 'synthetic-request-id' }), { confirmation: 'accepted' });
  assert.equal(input.text, 'agent-private-notification');
  assert.equal(input.contextToken, 'private-context');
  assert.equal(input.clientId, 'synthetic-request-id');
  assert.equal(f.probe.tests.length, 0);
  assert.equal(f.persisted.length, 0);
  assert.ok(!JSON.stringify(f.statuses).includes('agent-private-notification'));
  assert.equal(f.probe.busy, false);
});

test('shared transport reserves lock before await and blocks synthetic sends and cooldown', async () => {
  let release;
  const f = fixture(async () => { await new Promise((resolve) => { release = resolve; }); return { confirmation: 'accepted' }; });
  const sending = f.send('synthetic shared notification');
  assert.equal(f.probe.busy, true);
  await assert.rejects(f.probe.send({ omitContext: true }), /操作进行中/);
  await new Promise((resolve) => setImmediate(resolve));
  release(); await sending;
  await assert.rejects(f.send('synthetic second notification'), (error) => error.unsent && error.code === 'GATEWAY_BUSY');
});

test('contextless shared sends are explicit experiment and unavailable states never reach transport', async () => {
  const sends = [];
  const f = fixture(async (_session, input) => { sends.push(input); return { confirmation: 'accepted' }; });
  await f.send('synthetic contextless notification');
  assert.equal(sends[0].contextToken, undefined);
  f.advance(); f.probe.phase = 'expired';
  await assert.rejects(f.send('synthetic notification'), (error) => error.unsent === true);
  assert.equal(sends.length, 1);
});

test('transport unknown and stale session cannot auto retry or leak original error', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw Object.assign(new Error('private provider error'), { code: 'WECHAT_TIMEOUT' }); });
  await assert.rejects(f.send('private notification'), (error) => error.code === 'WECHAT_UNKNOWN' && !error.message.includes('private provider error'));
  assert.equal(calls, 1);
  assert.equal(f.probe.tests.length, 0);
  const stale = fixture(async () => { stale.probe.generation++; return { confirmation: 'accepted' }; });
  await assert.rejects(stale.send('synthetic notification'), (error) => error.code === 'WECHAT_UNKNOWN');
});

test('abort bridge cancels shared transport and expired credential updates probe', async () => {
  const upstream = new AbortController();
  const f = fixture(async (_session, input) => {
    await new Promise((resolve) => input.signal.addEventListener('abort', resolve, { once: true }));
    throw Object.assign(new Error('cancelled'), { code: 'WECHAT_CANCELLED' });
  });
  const sending = f.send('synthetic notification', { signal: upstream.signal });
  await new Promise((resolve) => setImmediate(resolve));
  upstream.abort();
  await assert.rejects(sending, (error) => error.code === 'WECHAT_UNKNOWN');
  assert.equal(f.probe.busy, false);
  const expired = fixture(async () => { throw Object.assign(new Error('private'), { code: 'WECHAT_SESSION_EXPIRED' }); });
  await assert.rejects(expired.send('synthetic notification'), (error) => error.code === 'WECHAT_SESSION_EXPIRED');
  assert.equal(expired.probe.phase, 'expired');
});

test('pre-abort, confirmation dialog and failed status write clearly remain unsent', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { confirmation: 'accepted' }; });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.send('synthetic notification', { signal: abort.signal }), (error) => error.unsent === true);
  await assert.rejects(createSharedWechatSender(f.probe, { canSend: () => false })('synthetic notification'), (error) => error.unsent === true);
  f.probe.storage.writeStatus = async () => { throw new Error('disk'); };
  await assert.rejects(f.send('synthetic notification'), (error) => error.unsent === true);
  assert.equal(calls, 0);
  assert.equal(f.probe.lastSendAt, -Infinity);
});
