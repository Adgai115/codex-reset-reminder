import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-reliability-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
process.env.CODEX_RESET_MONITOR_CONFIG_PATH = join(directory, 'config.json');
writeFileSync(process.env.CODEX_RESET_MONITOR_CONFIG_PATH, JSON.stringify({ codexScript: 'mock',
  desktop: { enabled: true }, feishu: { enabled: false }, quietHours: { enabled: false } }));
const { runCoreOperation } = await import('./core-operations.mjs');
const { openStore } = await import('../core/store.mjs');
const profiles = new Map();
const expiry = Math.floor(Date.now() / 1000) + 2 * 86400;
const profile = (workspace) => ({ identity: { account: { type: 'chatgpt', email: 'same@example.invalid' },
  workspaceRouting: { chatgptAccountId: workspace } }, usage: { rateLimitResetCredits: {
  availableCount: 1, credits: [{ id: `card-${workspace}`, status: 'available', title: workspace, expiresAt: expiry }] } } });
let current = profile('alpha');
let interceptor = async () => {};
let presenter = async () => {};
let profileChecks = 0;
const context = { desktop: (payload) => presenter(payload), accounts: async (action, args) => {
  if (action === 'has') { profileChecks++; return profiles.has(args.scopeId); }
  if (action === 'capture') { profiles.set(args.binding.scopeId, structuredClone(current)); return { saved: true }; }
  await interceptor(args);
  const selected = args.scopeId ? profiles.get(args.scopeId) : current;
  if (args.method === 'account/read') return selected.identity;
  if (args.method === 'account/rateLimits/read') return selected.usage;
  throw new Error('Unexpected simulated request');
} };
const run = (op, args) => runCoreOperation(op, args, context);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
let alpha; let beta;
test.before(async () => {
  alpha = (await run('checkAccount')).scopeId; await run('syncCards', { scopeId: alpha });
  current = profile('beta'); beta = (await run('checkAccount')).scopeId; await run('syncCards', { scopeId: beta });
});

test('slow preflight for one account does not delay delivery for another', { timeout: 5000 }, async () => {
  const gate = deferred(); const entered = deferred(); const delivered = deferred();
  const db = openStore(); try { db.exec('UPDATE sync_history SET checked_at = 1'); } finally { db.close(); }
  interceptor = async (args) => { if (args.scopeId === alpha && args.method === 'account/rateLimits/read') {
    entered.resolve(); await gate.promise;
  } };
  presenter = async (payload) => { if (payload.cards[0].accountScopeId === beta) delivered.resolve(payload); };
  const checking = run('checkReminders');
  try {
    await entered.promise;
    const fast = await Promise.race([delivered.promise, new Promise((_, reject) =>
      setTimeout(() => reject(new Error('the slow account blocked another account')), 1500))]);
    assert.equal(fast.cards[0].accountScopeId, beta);
  } finally { gate.resolve(); await checking; interceptor = async () => {}; }
});

test('all-account snapshots check each protected profile once and use matching unique labels', async () => {
  profileChecks = 0;
  const snapshot = await run('allAccountsSnapshot');
  assert.equal(profileChecks, 2, 'two accounts must not cause four profile reads');
  assert.equal(new Set(snapshot.accounts.map((account) => account.displayLabel)).size, 2);
  for (const card of snapshot.cards) assert.equal(card.accountDisplay,
    snapshot.accounts.find((account) => account.scopeId === card.accountScopeId).displayLabel);
});

test('a slow current-CLI discovery does not postpone known-account synchronization', { timeout: 5000 }, async () => {
  const gate = deferred(); const discovered = deferred(); const synchronized = deferred();
  interceptor = async (args) => {
    if (!args.scopeId && args.method === 'account/read') { discovered.resolve(); await gate.promise; }
    if (args.scopeId === alpha && args.method === 'account/rateLimits/read') synchronized.resolve();
  };
  const syncing = run('syncAllAccounts', { force: true });
  try {
    await discovered.promise;
    await Promise.race([synchronized.promise, new Promise((_, reject) =>
      setTimeout(() => reject(new Error('CLI discovery blocked an independent account')), 1500))]);
  } finally { gate.resolve(); await syncing; interceptor = async () => {}; }
});
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
