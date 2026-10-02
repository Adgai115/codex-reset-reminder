import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { requestPushplus } from './pushplus-http.mjs';
import { safeDeliveryFailure } from './delivery-results.mjs';

const directory = mkdtempSync(join(tmpdir(), 'codex-pushplus-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const store = await import('./store.mjs');
const { buildPushplusReminder, sendPushplusReminder, sendPushplusTest } = await import('./pushplus.mjs');
const { sendWechatReminder, buildWechatTemplate } = await import('./wechat.mjs');
const { runReminders } = await import('../legacy/node/remind.mjs');
after(() => rmSync(directory, { recursive: true, force: true }));

const token = 'a'.repeat(32);
const config = { desktop: { enabled: false }, feishu: { enabled: false },
  wechat: { enabled: true, provider: 'pushplus', credentialId: 'test-credential' } };
const now = Math.floor(Date.now() / 1000);
const expiresAt = now + 7 * 86400;
const card = (id) => ({ id, creditId: 'official-ABCDEF', source: 'codex',
  title: '官方重置卡', status: 'available', expiresAt });
const response = (data, ok = true) => ({ ok, text: async () => JSON.stringify(data) });
const accepted = (id = 'mock_receipt_001') => response({ code: 200, data: id });
const options = (fetchImpl) => ({ token, fetchImpl, accountDisplay: '工作账号', currentAvailableCount: 2 });
function rows() {
  const db = store.openStore();
  try { return db.prepare('SELECT * FROM pushplus_submissions').all(); } finally { db.close(); }
}
function result(id) {
  const db = store.openStore();
  try { return store.listReminderResults(db, id)[0]; } finally { db.close(); }
}
function seed(id, scopeId = null) {
  const db = store.openStore();
  try { store.saveCodexSnapshot(db, { availableCount: 1, credits: [card(id)] }, now - 60, scopeId); }
  finally { db.close(); }
}

test('纯 HTTPS transport 仅发送给自己，HTTP 200 和业务 code 200 都不能冒充微信送达', async () => {
  const payload = buildPushplusReminder(card('payload'), 7, options());
  assert.match(payload.title, /工作账号/);
  assert.match(payload.content, /#ABCDEF/);
  assert.match(payload.content, /到期前 7 天/);
  assert.match(payload.content, /最近同步可用卡：2 张/);
  assert.match(payload.content, /官方到期时间/);
  const sent = await requestPushplus(payload, options(async (url, request) => {
    assert.equal(url, 'https://www.pushplus.plus/send');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    const body = JSON.parse(request.body);
    assert.deepEqual(Object.keys(body).sort(), ['channel', 'content', 'template', 'title', 'token']);
    assert.equal(body.token, token);
    assert.equal(body.channel, 'wechat');
    assert.equal(body.template, 'txt');
    return accepted();
  }));
  assert.deepEqual(sent, { ok: true, confirmation: 'accepted', messageId: 'mock_receipt_001' });
  assert.equal(sent.delivered, undefined);
  await assert.rejects(requestPushplus(payload, options(async () =>
    response({ code: 903, msg: `token=${token}` }))), { code: 'PUSHPLUS_REJECTED' });
  for (const invalid of [response({ code: 200 }), response({ code: 200, data: {} }),
    response({ code: 200, data: token }), response({ code: '200', data: 'mock' }),
    response({ code: 777, data: null }),
    response({ code: 200, data: 'mock' }, false)])
    await assert.rejects(requestPushplus(payload, options(async () => invalid)), { code: 'PUSHPLUS_UNKNOWN' });
});

test('配置缺失不请求网络；异常内容与服务端消息不会进入错误文本', async () => {
  const payload = buildPushplusReminder(card('configuration'), 3);
  let calls = 0;
  await assert.rejects(requestPushplus(payload, { fetchImpl: async () => { calls++; } }),
    { code: 'PUSHPLUS_CONFIGURATION' });
  assert.equal(calls, 0);
  try {
    await requestPushplus(payload, options(async () => { throw new Error(`secret=${token}`); }));
    assert.fail('should reject');
  } catch (error) {
    assert.equal(error.code, 'PUSHPLUS_UNKNOWN');
    assert.doesNotMatch(error.message, /secret=|a{32}/);
    const safe = safeDeliveryFailure(error, 'wechat');
    assert.equal(safe.retryable, false);
    assert.equal(safe.code, 'pushplus_unknown');
  }
});

test('同一账号节点在新数据库连接和重启后复用已提交流水号，发送期间不持有数据库事务', async () => {
  let calls = 0; let openHandles = 0;
  const openDb = () => {
    const db = store.openStore(); openHandles++;
    const close = db.close.bind(db);
    db.close = () => { openHandles--; close(); };
    return db;
  };
  const opts = { ...options(async () => { calls++; assert.equal(openHandles, 0); return accepted('persistent_id'); }), openDb };
  const first = await sendPushplusReminder(config, card('persistent'), 7, opts);
  const second = await sendPushplusReminder(config, card('persistent'), 7, opts);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  assert.equal(openHandles, 0);
  const row = rows().find((item) => item.card_id === 'persistent');
  assert.equal(row.state, 'accepted');
  assert.equal(row.message_id, 'persistent_id');
  assert.doesNotMatch(JSON.stringify(row), /a{32}/);
});

test('不同账号的相同官方卡号、不同节点和不同微信连接均独立去重', async () => {
  let calls = 0;
  const opts = options(async () => accepted(`scope_id_${++calls}`));
  const first = card('scope-A:official-ABCDEF');
  const second = card('scope-B:official-ABCDEF');
  await sendPushplusReminder(config, first, 7, opts);
  await sendPushplusReminder(config, second, 7, opts);
  await sendPushplusReminder(config, first, 3, opts);
  await sendPushplusReminder(config, first, 7, { ...opts, nodeKind: 'snooze', nodeAt: now + 60 });
  await sendPushplusReminder(config, first, 7, { ...opts, credentialId: 'another-credential' });
  await sendPushplusReminder(config, second, 7, opts);
  assert.equal(calls, 5);
});

test('确定业务拒绝可重新尝试，超时、坏响应、崩溃占位及并发未知均不会再次 POST', async () => {
  let rejectedCalls = 0;
  const rejectedOptions = options(async () => ++rejectedCalls === 1
    ? response({ code: 903, msg: token }) : accepted('retry_success'));
  await assert.rejects(sendPushplusReminder(config, card('retry-rejection'), 7, rejectedOptions),
    { code: 'PUSHPLUS_REJECTED' });
  assert.equal(rows().find((item) => item.card_id === 'retry-rejection').state, 'rejected');
  await sendPushplusReminder(config, card('retry-rejection'), 7, rejectedOptions);
  assert.equal(rejectedCalls, 2);
  for (const [id, fetchImpl] of [
    ['timeout', async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error(token)), { once: true });
    })],
    ['bad-body', async () => ({ ok: true, text: async () => `invalid=${token}` })],
    ['missing-shortcode', async () => response({ code: 200, data: null })],
  ]) {
    let calls = 0;
    const opts = { ...options(async (...args) => { calls++; return fetchImpl(...args); }), timeoutMs: 5 };
    await assert.rejects(sendPushplusReminder(config, card(id), 7, opts), { code: 'PUSHPLUS_UNKNOWN' });
    await assert.rejects(sendPushplusReminder(config, card(id), 7, opts), { code: 'PUSHPLUS_UNKNOWN' });
    assert.equal(calls, 1);
    assert.equal(rows().find((item) => item.card_id === id).state, 'unknown');
  }
  let release; let entered;
  const arrival = new Promise((resolve) => { entered = resolve; });
  const opts = options(async () => { entered(); await new Promise((resolve) => { release = resolve; }); return accepted('parallel_id'); });
  const first = sendPushplusReminder(config, card('parallel'), 7, opts);
  await arrival;
  await assert.rejects(sendPushplusReminder(config, card('parallel'), 7, opts), { code: 'PUSHPLUS_UNKNOWN' });
  release(); await first;
  assert.equal((await sendPushplusReminder(config, card('parallel'), 7, opts)).messageId, 'parallel_id');
  // A persisted in-flight row is treated the same way after process restart.
  const db = store.openStore();
  try { db.prepare("UPDATE pushplus_submissions SET state = 'unknown' WHERE card_id = 'parallel'").run(); }
  finally { db.close(); }
  await assert.rejects(sendPushplusReminder(config, card('parallel'), 7,
    options(async () => assert.fail('must not send after crash'))), { code: 'PUSHPLUS_UNKNOWN' });
});

test('主进程 transport 可注入且不将凭据传入 payload；测试消息不写正式去重或卡片数据', async () => {
  let calls = 0;
  const transport = async (actualConfig, payload) => {
    calls++;
    assert.equal(actualConfig, config);
    assert.equal(payload.token, undefined);
    return { ok: true, confirmation: 'accepted', messageId: `transport_${calls}` };
  };
  const sent = await sendWechatReminder(config, card('transport'), 7, { transport });
  assert.equal(sent.confirmation, 'accepted');
  const before = rows().length;
  await sendPushplusTest(config, { transport: async (_config, payload) => {
    assert.match(payload.title, /测试/);
    assert.doesNotMatch(payload.content, /official-ABCDEF|工作账号/);
    return { ok: true, confirmation: 'accepted', messageId: 'test_message' };
  } });
  assert.equal(rows().length, before);
  const legacyConfig = { wechat: { enabled: true, openId: 'receiver', templateId: 'template',
    fieldMap: { thing1: 'cardName' } } };
  assert.equal(buildWechatTemplate(legacyConfig, card('legacy'), 3).data.thing1.value, '官方重置卡');
});

test('固定和延期提醒持久化 accepted 确认，未知结果停止补发且不暴露外部详情', async () => {
  const configPath = join(directory, 'integration-config.json');
  writeFileSync(configPath, JSON.stringify(config));
  seed('integration-fixed');
  const calls = [];
  const sender = async (actualConfig, actualCard, days, opts) => {
    calls.push({ id: actualCard.id, opts });
    return sendWechatReminder(actualConfig, actualCard, days, { ...opts, token,
      fetchImpl: async () => accepted(`integration_${calls.length}`) });
  };
  const first = await runReminders({ configPath, nowSeconds: now, trackAttempts: true, wechat: sender });
  assert.equal(first.due[0].wechat, 'submitted');
  assert.equal(result('integration-fixed').confirmation, 'accepted');
  assert.equal(result('integration-fixed').state, 'sent');
  assert.equal(calls[0].opts.nodeKind, 'fixed');
  const db = store.openStore();
  try { store.scheduleSnooze(db, 'integration-fixed', expiresAt, now + 86400); }
  finally { db.close(); }
  await runReminders({ configPath, nowSeconds: now + 86400, trackAttempts: true, wechat: sender });
  assert.equal(result('integration-fixed').nodeKind, 'snooze');
  assert.equal(result('integration-fixed').confirmation, 'accepted');
  assert.equal(calls[1].opts.nodeKind, 'snooze');
  seed('integration-unknown');
  let unknownCalls = 0;
  const unknownSender = (actualConfig, actualCard, days, opts) =>
    sendWechatReminder(actualConfig, actualCard, days, { ...opts, token,
      fetchImpl: async () => { unknownCalls++; throw new Error(`secret=${token}`); } });
  await runReminders({ configPath, nowSeconds: now, trackAttempts: true, wechat: unknownSender });
  const failure = result('integration-unknown');
  assert.equal(failure.errorCode, 'pushplus_unknown');
  assert.equal(failure.nextRetryAt, null);
  assert.equal(failure.confirmation, null);
  assert.doesNotMatch(JSON.stringify(failure), /secret=|a{32}/);
  await runReminders({ configPath, nowSeconds: now + 3600, trackAttempts: true, wechat: unknownSender });
  await runReminders({ configPath, nowSeconds: now + 3600, trackAttempts: true, wechat: unknownSender,
    manualRetry: { cardId: 'integration-unknown', expiresAt, nodeKind: 'fixed', nodeAt: now } });
  assert.equal(unknownCalls, 1);
});

test('已确认拒绝沿用 4 次上限；900 账号受限停止自动补发，恢复后可手动重试', async () => {
  const configPath = join(directory, 'limited-config.json');
  writeFileSync(configPath, JSON.stringify(config));
  seed('integration-cap');
  let calls = 0;
  const sender = (actualConfig, actualCard, days, opts) => sendWechatReminder(actualConfig,
    actualCard, days, { ...opts, token, fetchImpl: async () => {
      calls++; return response({ code: 600, msg: token });
    } });
  for (const offset of [0, 60, 360, 1260, 3600])
    await runReminders({ configPath, nowSeconds: now + offset, trackAttempts: true, wechat: sender });
  assert.equal(calls, 4);
  assert.equal(result('integration-cap').attempts, 4);
  assert.equal(result('integration-cap').nextRetryAt, null);
  seed('integration-limited');
  let limitedCalls = 0;
  const limitedSender = (actualConfig, actualCard, days, opts) => sendWechatReminder(actualConfig,
    actualCard, days, { ...opts, token, fetchImpl: async () => ++limitedCalls === 1
      ? response({ code: 900, msg: token }) : accepted('recovered_id') });
  await runReminders({ configPath, nowSeconds: now, trackAttempts: true, wechat: limitedSender });
  assert.equal(result('integration-limited').errorCode, 'pushplus_limited');
  assert.equal(result('integration-limited').nextRetryAt, null);
  await runReminders({ configPath, nowSeconds: now + 3600, trackAttempts: true, wechat: limitedSender });
  assert.equal(limitedCalls, 1);
  await runReminders({ configPath, nowSeconds: now + 3600, trackAttempts: true, wechat: limitedSender,
    manualRetry: { cardId: 'integration-limited', expiresAt, nodeKind: 'fixed', nodeAt: now } });
  assert.equal(limitedCalls, 2);
  assert.equal(result('integration-limited').confirmation, 'accepted');
});
