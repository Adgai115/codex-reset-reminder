import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-account-guard-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
process.env.CODEX_RESET_MONITOR_CONFIG_PATH = join(directory, 'config.json');
writeFileSync(process.env.CODEX_RESET_MONITOR_CONFIG_PATH,
  JSON.stringify({ codexScript: 'fake-codex', feishu: { enabled: false } }));
const { getActiveAccountScope, getCard, openStore, saveCodexSnapshot,
  recordFeishuMessage } = await import('../store.mjs');
const { checkAccount, requireAccount, requireCardInScope } = await import('./account-guard.mjs');
const { syncCards } = await import('../sync.mjs');
const { consumeCredit, refreshCreditStatus } = await import('../consume.mjs');
const { handleCardAction } = await import('../core/card-actions.mjs');
const configPath = process.env.CODEX_RESET_MONITOR_CONFIG_PATH;
const account = (email) => async (_script, method, params) => {
  assert.equal(method, 'account/read');
  assert.deepEqual(params, {});
  return { account: { type: 'chatgpt', email, planType: 'plus' }, requiresOpenaiAuth: true };
};
const expiry = Math.floor(Date.now() / 1000) + 8 * 86400;

test('old cards require explicit first binding to the rechecked candidate', async () => {
  const db = openStore();
  try { saveCodexSnapshot(db, { availableCount: 1, credits: [
    { id: 'old-card', status: 'available', title: '旧卡', expiresAt: expiry },
  ] }); } finally { db.close(); }
  const first = await checkAccount(configPath, { appServer: account('old@example.com') });
  assert.equal(first.state, 'needsBinding');
  assert.equal(first.currentDisplay, 'o***@example.com');
  await assert.rejects(requireAccount(configPath, { appServer: account('old@example.com') }),
    /现有 Codex 卡尚未绑定账号/);
  const changed = await checkAccount(configPath, { appServer: account('other@example.com'),
    confirmLegacy: true, expectedCandidateToken: first.candidateToken });
  assert.equal(changed.state, 'needsBinding');
  const bound = await checkAccount(configPath, { appServer: account('old@example.com'),
    confirmLegacy: true, expectedCandidateToken: first.candidateToken });
  assert.equal(bound.state, 'verified');
  const after = openStore();
  try {
    assert.equal(getCard(after, 'old-card').accountScopeId, bound.scopeId);
    const stored = getActiveAccountScope(after);
    assert.equal(stored.displayName, 'o***@example.com');
    assert.doesNotMatch(JSON.stringify(stored), /old@example.com/);
  } finally { after.close(); }
});

test('switch and network failure remain distinct and block merge or official use', async () => {
  const scope = await requireAccount(configPath, { appServer: account('old@example.com') });
  const switched = await checkAccount(configPath, { appServer: account('new@example.com') });
  assert.equal(switched.state, 'mismatch');
  let rateLimitCalls = 0;
  await assert.rejects(syncCards(configPath, {
    accountGuard: () => requireAccount(configPath, { appServer: account('new@example.com') }),
    appServer: async () => { rateLimitCalls++; return {}; },
  }), /账号不一致/);
  assert.equal(rateLimitCalls, 0);
  let consumeCalls = 0;
  await assert.rejects(consumeCredit('old-card', 'test-key', {
    verifyAccount: () => requireAccount(configPath, { appServer: account('new@example.com') }),
    verifyCard: requireCardInScope,
    appServer: async () => { consumeCalls++; return { outcome: 'reset' }; },
  }), /账号不一致/);
  assert.equal(consumeCalls, 0);
  const offline = await checkAccount(configPath, { appServer: async () => { throw new Error('offline'); } });
  assert.equal(offline.state, 'unavailable');
  assert.equal(offline.boundDisplay, 'o***@example.com');
  const restored = await checkAccount(configPath, { appServer: account('old@example.com') });
  assert.equal(restored.state, 'verified');
  assert.equal(restored.scopeId, scope);
});

test('a switch between Usage read and cache write cannot merge the new account', async () => {
  let identityReads = 0;
  let consumed = 0;
  const guard = () => requireAccount(configPath, { appServer: account(++identityReads === 1
    ? 'old@example.com' : 'new@example.com') });
  await assert.rejects(syncCards(configPath, { accountGuard: guard,
    appServer: async () => ({ rateLimitResetCredits: { availableCount: 1, credits: [
      { id: 'foreign-card', status: 'available', title: '另一账号卡', expiresAt: expiry },
    ] } }),
  }), /账号不一致/);
  const db = openStore();
  try { assert.equal(getCard(db, 'foreign-card'), null); } finally { db.close(); }
  await assert.rejects(refreshCreditStatus({
    verifyAccount: () => requireAccount(configPath, { appServer: account('new@example.com') }),
    appServer: async () => { consumed++; return {}; },
  }), /账号不一致/);
  assert.equal(consumed, 0);
});

test('Feishu callback for a Codex card is blocked before a consume or feedback mutation', async () => {
  const db = openStore();
  try { recordFeishuMessage(db, { messageId: 'om_account_guard', cardId: 'old-card',
    expiresAt: expiry, thresholdDays: 7, recipientOpenId: 'ou_owner' }); }
  finally { db.close(); }
  let consumeCalls = 0;
  const result = await handleCardAction({ type: 'card.action.trigger', action_tag: 'button',
    event_id: 'blocked-event', message_id: 'om_account_guard', operator_id: 'ou_owner',
    token: 'fake', action_value: JSON.stringify({ action: 'consume' }) },
  { feishu: { userId: 'ou_owner' } }, {
    verifyCardAction: async () => { await requireAccount(configPath, { appServer: account('new@example.com') }); },
    consume: async () => { consumeCalls++; }, update: async () => ({}),
  });
  assert.equal(result, 'account_blocked');
  assert.equal(consumeCalls, 0);
  const after = openStore();
  try { assert.equal(getCard(after, 'old-card').reportedUsedAt, null); }
  finally { after.close(); }
});

test('fresh install binds automatically; missing identity never uses card count as identity', async () => {
  const db = openStore();
  try {
    db.exec('DELETE FROM card_action_events; DELETE FROM feishu_messages; DELETE FROM reminder_attempts; DELETE FROM reminder_deliveries; DELETE FROM snoozes; DELETE FROM sync_history; DELETE FROM cards; DELETE FROM account_scopes;');
  } finally { db.close(); }
  const unknown = await checkAccount(configPath, { appServer: async () => ({
    account: { type: 'apiKey' }, requiresOpenaiAuth: false,
  }) });
  assert.equal(unknown.state, 'unidentified');
  const bound = await checkAccount(configPath, { appServer: account('fresh@example.com') });
  assert.equal(bound.state, 'verified');
  let reads = 0;
  const result = await syncCards(configPath, {
    accountGuard: () => requireAccount(configPath, { appServer: account('fresh@example.com') }),
    appServer: async () => { reads++; return { rateLimitResetCredits: { availableCount: 1, credits: [
      { id: 'fresh-card', status: 'available', title: '新卡', expiresAt: expiry },
    ] } }; },
  });
  assert.equal(reads, 1);
  assert.equal(result.complete, true);
  const after = openStore();
  try { assert.equal(getCard(after, 'fresh-card').accountScopeId, bound.scopeId); }
  finally { after.close(); }
});

test('workspace identity takes precedence when the protocol provides it', async () => {
  const read = (id) => async () => ({ account: { type: 'chatgpt', email: 'fresh@example.com',
    planType: 'plus' }, workspaceRouting: id ? { chatgptAccountId: id } : null });
  assert.equal((await checkAccount(configPath, { appServer: read('workspace-a') })).state, 'verified');
  assert.equal((await checkAccount(configPath, { appServer: read('workspace-b') })).state, 'mismatch');
  assert.equal((await checkAccount(configPath, { appServer: read(null) })).state, 'unidentified');
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
