import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WechatProbe, SYNTHETIC_TEXT } from './controller.mjs';

const session = { token: 'synthetic-secret-not-real', userId: 'synthetic-user', baseUrl: 'https://ilinkai.weixin.qq.com' };
function fixture({ saved = null, sendError = null } = {}) {
  let time = Date.parse('2026-10-02T08:00:00Z');
  const writes = [], statuses = [], sends = [], timers = new Map();
  let nextTimer = 0;
  const client = {
    async notify() {},
    async getUpdates(_session, { signal }) {
      await new Promise(resolve => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', resolve, { once: true });
      });
      return { ret: 0, msgs: [] };
    },
    async sendText(connection, input) {
      sends.push({ connection, ...input });
      if (sendError) throw sendError;
      return { confirmation: 'accepted' };
    },
    async requestQr() { return { qrcode: 'synthetic-qr', qrcode_img_content: 'https://ilinkai.weixin.qq.com/mock' }; },
    async pollQr() { return { status: 'confirmed', bot_token: session.token, ilink_user_id: session.userId, baseurl: session.baseUrl }; },
  };
  const storage = {
    async read() { return saved; },
    async write(value) { writes.push(structuredClone(value)); },
    async remove() { writes.push('removed'); },
    async writeStatus() {},
  };
  const probe = new WechatProbe({ client, storage, renderQr: () => 'data:image/svg+xml;base64,bW9jaw==',
    publish: value => statuses.push(structuredClone(value)), now: () => time,
    setTimer: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimer: id => timers.delete(id),
  });
  function bind() { probe.session = { ...session }; probe.phase = 'bound'; probe.contextToken = 'original-context'; probe.contextAt = new Date(time).toISOString(); }
  return { probe, client, writes, statuses, sends, timers, bind,
    advance: milliseconds => { time += milliseconds; }, fire: async () => { const entry = [...timers.entries()][0]; timers.delete(entry[0]); await entry[1](); } };
}

test('probe public status excludes session credentials, context, cursor and inbound text', () => {
  const f = fixture(); f.bind(); f.probe.cursor = 'private-cursor';
  const publicState = JSON.stringify(f.probe.status());
  for (const secret of [session.token, session.userId, 'original-context', 'private-cursor']) assert.ok(!publicState.includes(secret));
});

test('probe persists pending before a fixed synthetic send and never claims receipt', async () => {
  const f = fixture(); f.bind();
  await f.probe.send();
  assert.equal(f.writes[0].tests[0].confirmation, 'pending');
  assert.equal(f.sends.length, 1);
  assert.ok(f.sends[0].text.startsWith(SYNTHETIC_TEXT));
  assert.ok(f.sends[0].text.includes(f.probe.tests[0].id.slice(0, 8)));
  assert.equal(f.sends[0].contextToken, 'original-context');
  assert.equal(f.probe.status().tests[0].confirmation, 'accepted');
  await f.probe.confirm(f.probe.tests[0].id);
  assert.equal(f.probe.status().tests[0].confirmation, 'received');
});

test('unknown send remains one attempt and private error text never escapes', async () => {
  const error = Object.assign(new Error('secret from request body'), { code: 'WECHAT_UNKNOWN' });
  const f = fixture({ sendError: error }); f.bind();
  await f.probe.send();
  assert.equal(f.sends.length, 1);
  assert.equal(f.probe.tests[0].confirmation, 'unknown');
  assert.ok(!f.probe.message.includes(error.message));
  await assert.rejects(f.probe.send(), /15 秒/);
  assert.equal(f.sends.length, 1);
});

test('omitting context is explicit and does not attach current conversation token', async () => {
  const f = fixture(); f.bind();
  await f.probe.send({ omitContext: true });
  assert.equal(f.sends[0].contextToken, undefined);
  assert.equal(f.probe.tests[0].contextAgeMinutes, undefined);
});

test('25 hour delay uses original context even if a new conversation arrives', async () => {
  const f = fixture(); f.bind();
  await f.probe.schedule(1500);
  f.advance(1500 * 60000);
  f.probe.contextToken = 'newer-context'; f.probe.contextAt = new Date().toISOString();
  await f.fire();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].contextToken, 'original-context');
  assert.equal(f.probe.tests[0].contextAgeMinutes, 1500);
  assert.equal(f.probe.scheduled, null);
});

test('cancelling or exiting removes scheduled sends and reopening cannot resume them', async () => {
  const f = fixture(); f.bind();
  await f.probe.schedule(5); await f.probe.cancelSchedule();
  assert.equal(f.timers.size, 0); assert.equal(f.sends.length, 0);
  await f.probe.schedule(1500); await f.probe.stop();
  assert.equal(f.timers.size, 0); assert.equal(f.sends.length, 0);
  assert.equal(f.probe.status().scheduled, null);
  assert.ok(f.writes.every(value => !value?.scheduled));
});

test('restart recovery converts interrupted pending attempts to unknown without resend', async () => {
  const f = fixture({ saved: { version: 1, session, contextToken: 'saved-context', contextAt: '2026-10-02T08:00:00Z',
    cursor: 'saved-cursor', tests: [{ id: 'test-before-crash', label: '即时测试', at: '2026-10-02T08:00:00Z', confirmation: 'pending' }] } });
  await f.probe.initialize();
  assert.equal(f.probe.tests[0].confirmation, 'unknown');
  assert.equal(f.sends.length, 0);
  assert.equal(f.probe.scheduled, null);
  await f.probe.stop();
});

test('a session expiry rejects a send and cancels any outstanding delayed experiment', async () => {
  const f = fixture({ sendError: Object.assign(new Error('raw secret'), { code: 'WECHAT_SESSION_EXPIRED' }) }); f.bind();
  await f.probe.schedule(1500); await f.probe.send();
  assert.equal(f.probe.phase, 'expired'); assert.equal(f.probe.tests[0].confirmation, 'rejected');
  assert.equal(f.timers.size, 0); assert.equal(f.probe.status().bound, false);
});

test('forgetting removes only the independent stored test connection and clears pending jobs', async () => {
  const f = fixture(); f.bind(); await f.probe.schedule(5);
  await f.probe.forget();
  assert.equal(f.writes.at(-1), 'removed'); assert.equal(f.probe.session, null);
  assert.equal(f.probe.phase, 'idle'); assert.equal(f.timers.size, 0);
});
