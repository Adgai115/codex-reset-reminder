import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-managed-accounts-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
process.env.CODEX_RESET_MONITOR_CONFIG_PATH = join(directory, 'config.json');
writeFileSync(process.env.CODEX_RESET_MONITOR_CONFIG_PATH, JSON.stringify({ codexScript: 'mock',
  desktop: { enabled: true }, feishu: { enabled: false }, quietHours: { enabled: false } }));
const { runCoreOperation } = await import('./core-operations.mjs');
const expiry = Math.floor(Date.now() / 1000) + 2 * 86400;
const profile = (email) => ({ identity: { account: { type: 'chatgpt', email } }, usage: {
  rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'shared-credit', title: email[0] + '号卡',
    status: 'available', expiresAt: expiry }] } } });
let current = profile('alpha@example.invalid');
const profiles = new Map();
const calls = [];
const shown = [];
const context = { desktop: async (payload) => { shown.push(payload); }, accounts: async (action, args) => {
  if (action === 'has') return profiles.has(args.scopeId);
  if (action === 'capture') { if (!profiles.has(args.binding.scopeId)) profiles.set(args.binding.scopeId, structuredClone(current)); return { saved: true }; }
  const selected = args.scopeId ? profiles.get(args.scopeId) : current;
  calls.push({ scopeId: args.scopeId, method: args.method, params: args.params });
  if (selected.fail) throw new Error('模拟会话过期');
  if (args.method === 'account/read') return selected.identity;
  if (args.method === 'account/rateLimits/read') return selected.usage;
  if (args.method === 'account/rateLimitResetCredit/consume') return { outcome: 'nothingToReset' };
  throw new Error('unexpected operation');
} };
const run = (op, args) => runCoreOperation(op, args, context);

test('all accounts continue synchronizing and reminding when CLI and displayed account change', async () => {
  const first = await run('checkAccount');
  await run('syncCards', { scopeId: first.scopeId });
  await run('runReminders');
  current = profile('beta@example.invalid');
  const second = await run('checkAccount');
  assert.notEqual(first.scopeId, second.scopeId);
  await run('syncAllAccounts', { force: true });
  await run('selectAccount', { scopeId: first.scopeId });
  const before = await run('manageSnapshot');
  assert.equal(before.account.scopeId, first.scopeId);
  assert.equal(before.cards[0].title, 'a号卡');
  assert.ok(before.syncHistory.length);
  assert.ok(before.cards[0].deliveryResults.length);
  assert.equal(before.accounts.length, 2);
  await run('runReminders');
  assert.equal(shown.length, 2, 'each account sends once; changing view does not resend');
  assert.equal(new Set(shown.map((batch) => batch.cards[0].accountScopeId)).size, 2);
  await run('selectAccount', { scopeId: second.scopeId });
  const other = await run('manageSnapshot');
  assert.equal(other.cards[0].creditId, before.cards[0].creditId);
  assert.notEqual(other.cards[0].id, before.cards[0].id, 'same official ID remains isolated');
  await run('resetCardFromReminder', { cardId: before.cards[0].id, expectedExpiresAt: expiry });
  const consume = calls.find((call) => call.method === 'account/rateLimitResetCredit/consume');
  assert.equal(consume.scopeId, first.scopeId, 'consume uses owning session although CLI and UI show second account');
  assert.equal(consume.params.creditId, 'shared-credit');
  await run('updateAccount', { scopeId: first.scopeId, nickname: '工作号', remindersEnabled: false });
  profiles.get(first.scopeId).fail = true;
  profiles.get(second.scopeId).usage.rateLimitResetCredits.credits.push({ id: 'next-credit',
    title: '第二账号新卡', status: 'available', expiresAt: expiry + 60 });
  profiles.get(second.scopeId).usage.rateLimitResetCredits.availableCount = 2;
  const refresh = await run('syncAllAccounts', { force: true });
  assert.equal(refresh.accounts.find((row) => row.scopeId === second.scopeId).complete, true);
  assert.equal(refresh.accounts.find((row) => row.scopeId === first.scopeId).complete, false);
  await run('runReminders');
  assert.equal(shown.length, 3);
  assert.equal(shown[2].cards[0].accountScopeId, second.scopeId);
  await run('selectAccount', { scopeId: first.scopeId });
  const offline = await run('manageSnapshot');
  assert.equal(offline.cards.length, 1);
  assert.equal(offline.account.nickname, '工作号');
  assert.equal(offline.syncHistory[0].outcome, 'failed');
  assert.equal(offline.cards[0].deliveryResults.length, 1);
  await run('scheduleSnooze', { cardId: offline.cards[0].id, scopeId: first.scopeId, option: '1d' });
  assert.ok((await run('manageSnapshot')).cards[0].snooze);
  assert.equal((await run('allAccountsSnapshot')).cards.length, 3);
});
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
