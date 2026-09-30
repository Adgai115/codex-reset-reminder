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
const { getActiveAccountScope, getCard, listAccountScopes, latestCompleteSync,
  openStore, saveCodexSnapshot,
  recordFeishuMessage } = await import('../legacy/node/store.mjs');
const { checkAccount, requireAccount, requireCardInScope } = await import('./account-guard.mjs');
const { runCoreOperation } = await import('./core-operations.mjs');
const { syncCards } = await import('../legacy/node/sync.mjs');
const { runReminders } = await import('../legacy/node/remind.mjs');
const { consumeCredit, refreshCreditStatus } = await import('../legacy/node/consume.mjs');
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

test('switching accounts keeps cards and sync history isolated; returning restores the first account', async () => {
  const scope = await requireAccount(configPath, { appServer: account('old@example.com') });
  const switched = await checkAccount(configPath, { appServer: account('new@example.com') });
  assert.equal(switched.state, 'verified');
  assert.notEqual(switched.scopeId, scope);
  const hidden = await runCoreOperation('manageSnapshot');
  assert.equal(hidden.account.currentDisplay, 'n***@example.com');
  assert.deepEqual(hidden.cards, []);
  assert.deepEqual(await runCoreOperation('listCards'), []);
  assert.equal(await runCoreOperation('getCard', { cardId: 'old-card' }), null);
  const synced = await syncCards(configPath, {
    accountGuard: () => requireAccount(configPath, { appServer: account('new@example.com') }),
    appServer: async () => ({ rateLimitResetCredits: { availableCount: 1, credits: [
      { id: 'new-card', status: 'available', title: '新账号卡', expiresAt: expiry },
    ] } }),
  });
  assert.equal(synced.complete, true);
  assert.deepEqual((await runCoreOperation('listCards')).map((card) => card.id), ['new-card']);
  const checkAt = expiry - 7 * 86400;
  assert.deepEqual((await runReminders({ configPath, nowSeconds: checkAt, dryRun: true,
    accountScopeId: switched.scopeId })).due.map((row) => row.id), ['new-card']);
  assert.deepEqual((await runReminders({ configPath, nowSeconds: checkAt, dryRun: true,
    accountScopeId: scope })).due.map((row) => row.id), ['old-card']);
  const afterSync = openStore();
  try {
    assert.equal(getCard(afterSync, 'old-card').accountScopeId, scope);
    assert.equal(getCard(afterSync, 'new-card').accountScopeId, switched.scopeId);
    assert.equal(latestCompleteSync(afterSync, switched.scopeId).availableCount, 1);
    assert.equal(listAccountScopes(afterSync).length, 2);
  } finally { afterSync.close(); }
  let consumeCalls = 0;
  await assert.rejects(consumeCredit('old-card', 'test-key', {
    verifyAccount: () => requireAccount(configPath, { appServer: account('new@example.com') }),
    verifyCard: requireCardInScope,
    appServer: async () => { consumeCalls++; return { outcome: 'reset' }; },
  }), /不属于当前绑定账号/);
  assert.equal(consumeCalls, 0);
  const offline = await checkAccount(configPath, { appServer: async () => { throw new Error('offline'); } });
  assert.equal(offline.state, 'unavailable');
  assert.equal(offline.boundDisplay, 'n***@example.com');
  const restored = await checkAccount(configPath, { appServer: account('old@example.com') });
  assert.equal(restored.state, 'verified');
  assert.equal(restored.scopeId, scope);
  assert.deepEqual((await runCoreOperation('manageSnapshot')).cards.map((card) => card.id), ['old-card']);
});

test('a switch between Usage read and cache write cannot merge the new account', async () => {
  let identityReads = 0;
  let statusReads = 0;
  const guard = () => requireAccount(configPath, { appServer: account(++identityReads === 1
    ? 'old@example.com' : 'new@example.com') });
  await assert.rejects(syncCards(configPath, { accountGuard: guard,
    appServer: async () => ({ rateLimitResetCredits: { availableCount: 1, credits: [
      { id: 'foreign-card', status: 'available', title: '另一账号卡', expiresAt: expiry },
    ] } }),
  }), /账号在同步期间发生变化/);
  const db = openStore();
  try { assert.equal(getCard(db, 'foreign-card'), null); } finally { db.close(); }
  let statusIdentityReads = 0;
  await assert.rejects(refreshCreditStatus({
    verifyAccount: () => requireAccount(configPath, { appServer: account(++statusIdentityReads === 1
      ? 'old@example.com' : 'new@example.com') }),
    appServer: async () => { statusReads++; return {}; },
  }), /账号在读取期间发生变化/);
  assert.equal(statusReads, 1);
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
    verifyCardAction: async (card) => requireCardInScope(card.id,
      await requireAccount(configPath, { appServer: account('new@example.com') })),
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
  const first = await checkAccount(configPath, { appServer: read('workspace-a') });
  assert.equal(first.state, 'verified');
  const second = await checkAccount(configPath, { appServer: read('workspace-b') });
  assert.equal(second.state, 'verified');
  assert.notEqual(second.scopeId, first.scopeId);
  assert.equal((await checkAccount(configPath, { appServer: read(null) })).state, 'unidentified');
  assert.equal((await checkAccount(configPath, { appServer: read('workspace-a') })).scopeId, first.scopeId);
});

test('failed or cancelled session saving cannot register an account or change an existing binding', async () => {
  const snapshot = () => { const db = openStore(); try { return listAccountScopes(db); } finally { db.close(); } };
  const before = snapshot();
  let prepared;
  await assert.rejects(checkAccount(configPath, { appServer: account('cancelled@example.invalid'),
    beforeConfirm: async (binding) => { prepared = binding;
      assert.ok(binding.scopeId); assert.ok(binding.emailHash);
      assert.equal(snapshot().some((scope) => scope.scopeId === binding.scopeId), false,
        'an identity is not registered until its session is saved');
      throw new Error('登录会话已结束');
    } }), /登录会话已结束/);
  assert.equal(prepared.displayName, 'c***@example.invalid');
  assert.deepEqual(snapshot(), before);
  const original = before.find((scope) => scope.active);
  await assert.rejects(checkAccount(configPath, { expectedScopeId: original.scopeId, activate: false,
    appServer: async () => ({ account: { type: 'chatgpt', email: 'fresh@example.com' },
      workspaceRouting: { chatgptAccountId: 'workspace-a' } }),
    beforeConfirm: async (binding) => {
      assert.equal(binding.scopeId, original.scopeId);
      assert.equal(binding.workspaceHash, original.workspaceHash);
      throw new Error('模拟会话保存失败');
    } }), /模拟会话保存失败/);
  assert.deepEqual(snapshot(), before);
});

test('successful session saving is followed by registering the same scoped identity', async () => {
  let prepared;
  const result = await checkAccount(configPath, { appServer: account('saved@example.invalid'),
    beforeConfirm: async (binding) => { prepared = { ...binding }; } });
  assert.equal(result.state, 'verified'); assert.equal(result.scopeId, prepared.scopeId);
  const db = openStore();
  try {
    const saved = getActiveAccountScope(db);
    assert.equal(saved.scopeId, prepared.scopeId);
    assert.equal(saved.emailHash, prepared.emailHash);
    assert.equal(saved.displayName, prepared.displayName);
  } finally { db.close(); }
});

test('a newly unscoped Codex row cannot be silently merged into the bound scope', () => {
  const db = openStore();
  try {
    const scopeId = getActiveAccountScope(db).scopeId;
    db.prepare(`INSERT INTO cards (id, source, title, expires_at, status, updated_at)
      VALUES (?, 'codex', ?, ?, 'available', ?)`).run('foreign-unscoped', '未归属卡', expiry, 1);
    assert.throws(() => saveCodexSnapshot(db, { availableCount: 1, credits: [
      { id: 'foreign-unscoped', status: 'available', title: '未归属卡', expiresAt: expiry },
    ] }, Math.floor(Date.now() / 1000), scopeId), /归属账号不一致/);
    assert.equal(getCard(db, 'foreign-unscoped').accountScopeId, null);
  } finally { db.close(); }
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
