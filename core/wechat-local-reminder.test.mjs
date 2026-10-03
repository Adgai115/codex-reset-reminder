import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'codex-local-wechat-reminders-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const { buildLocalWechatReminder } = await import('./wechat-local-reminder.mjs');
const { sendWechatReminder } = await import('./wechat.mjs');
const store = await import('./store.mjs');
const { runReminders } = await import('../legacy/node/remind.mjs');
const { mayAttemptReminder } = await import('./delivery-retry.mjs');
after(() => rmSync(directory, { recursive: true, force: true }));
const now = Math.floor(Date.now() / 1000), expiresAt = now + 7 * 86400;
const config = { desktop: { enabled: false }, feishu: { enabled: false },
  wechat: { enabled: true, provider: 'local-gateway', gatewayClientFile: join(directory, 'constructed-client.bin') } };
const card = (id, accountScopeId = 'account-a') => ({ id, accountScopeId, creditId: 'constructed-official-ABCDEF',
  title: '官方重置卡', source: 'codex', status: 'available', expiresAt });
const options = { accountDisplay: '工作账号', currentAvailableCount: 2, nowSeconds: now };

test('local payload limits data to account label, card suffix and official expiry', () => {
  const payload = buildLocalWechatReminder(config, card('internal-id'), 7, options);
  assert.deepEqual(Object.keys(payload).sort(), ['id', 'text', 'title']);
  assert.match(payload.id, /^reset-[a-f0-9]{64}$/);
  assert.match(payload.text, /工作账号/);
  assert.match(payload.text, /#ABCDEF/);
  assert.match(payload.text, /官方到期时间/);
  assert.match(payload.text, /2 张/);
  assert.doesNotMatch(JSON.stringify(payload), /internal-id|constructed-official|account-a|constructed-client/);
});

test('notification id isolates account, card, expiry, node and local client; retries retain it', () => {
  const id = buildLocalWechatReminder(config, card('same-card'), 7, options).id;
  assert.equal(buildLocalWechatReminder(config, card('same-card'), 7, { ...options, nowSeconds: now + 60 }).id, id);
  const variants = [
    buildLocalWechatReminder(config, card('same-card', 'account-b'), 7, options),
    buildLocalWechatReminder(config, card('other-card'), 7, options),
    buildLocalWechatReminder(config, { ...card('same-card'), expiresAt: expiresAt + 1 }, 7, options),
    buildLocalWechatReminder(config, card('same-card'), 3, options),
    buildLocalWechatReminder(config, card('same-card'), 7, { ...options, nodeKind: 'snooze', nodeAt: now + 60 }),
    buildLocalWechatReminder({ ...config, wechat: { ...config.wechat, gatewayClientFile: join(directory, 'other.bin') } }, card('same-card'), 7, options),
  ];
  assert.equal(new Set([id, ...variants.map((item) => item.id)]).size, 7);
});

test('official local provider uses injected transport and only reports submission acceptance', async () => {
  let calls = 0;
  const result = await sendWechatReminder(config, card('transport'), 7, { ...options,
    transport: async (actual, payload) => {
      calls++; assert.equal(actual, config); assert.equal(payload.token, undefined);
      return { ok: true, confirmation: 'accepted', messageId: payload.id };
    } });
  assert.equal(calls, 1); assert.equal(result.confirmation, 'accepted'); assert.equal(result.delivered, undefined);
  await assert.rejects(sendWechatReminder(config, card('invalid'), 7, { ...options, transport: async () => ({ ok: true }) }), { code: 'WECHAT_UNKNOWN' });
  await assert.rejects(sendWechatReminder(config, card('network'), 7, { ...options, transport: async () => { throw new Error('sensitive raw transport exception'); } }),
    { code: 'WECHAT_UNKNOWN', message: '微信发送结果未知，已停止补发，请到手机核对。' });
});

test('proved-unsent retry retains initial text and id even after account/count/day changes', async () => {
  const payloads = [];
  const transport = async (_cfg, payload) => {
    payloads.push(payload);
    return payloads.length === 1 ? { state: 'unsent', code: 'WECHAT_LOCAL_OFFLINE', unsent: true }
      : { state: 'accepted', code: 'WECHAT_ACCEPTED', id: payload.id };
  };
  await assert.rejects(sendWechatReminder(config, card('frozen-text'), 7, { ...options, transport }), { code: 'WECHAT_LOCAL_OFFLINE' });
  const result = await sendWechatReminder(config, card('frozen-text'), 7, { ...options, transport,
    accountDisplay: '已更名', currentAvailableCount: 10, nowSeconds: now + 86400 });
  assert.equal(result.confirmation, 'accepted'); assert.deepEqual(payloads[1], payloads[0]);
});

test('unknown official WeChat submissions stop automatic and manual reminder retries', async () => {
  const configPath = join(directory, 'config.json'); writeFileSync(configPath, JSON.stringify(config));
  const seeded = card('unknown-integration', null);
  let db = store.openStore();
  try { store.saveCodexSnapshot(db, { availableCount: 1, credits: [seeded] }, now - 60); } finally { db.close(); }
  let calls = 0;
  const sender = (cfg, item, days, opts) => sendWechatReminder(cfg, item, days, { ...opts, transport: async () => {
    calls++; throw Object.assign(new Error('constructed secret must not enter ledger'), { code: 'WECHAT_UNKNOWN' });
  } });
  await runReminders({ configPath, nowSeconds: now, trackAttempts: true, wechat: sender });
  db = store.openStore();
  let failure;
  try { failure = store.listReminderResults(db, seeded.id)[0]; } finally { db.close(); }
  assert.equal(failure.errorCode, 'wechat_unknown'); assert.equal(failure.nextRetryAt, null);
  assert.doesNotMatch(JSON.stringify(failure), /constructed secret/);
  assert.equal(mayAttemptReminder(failure, now + 3600, true), false);
  await runReminders({ configPath, nowSeconds: now + 3600, trackAttempts: true, wechat: sender });
  await runReminders({ configPath, nowSeconds: now + 3600, trackAttempts: true, wechat: sender,
    manualRetry: { cardId: seeded.id, expiresAt, nodeKind: 'fixed', nodeAt: now } });
  assert.equal(calls, 1);
});
