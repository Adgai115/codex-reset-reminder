import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-consume-test-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
process.env.CODEX_RESET_MONITOR_CONFIG_PATH = join(directory, 'config.json');
writeFileSync(process.env.CODEX_RESET_MONITOR_CONFIG_PATH,
  JSON.stringify({ codexScript: join(directory, 'mock-codex.js') }));
const { openStore, getCard, saveCodexSnapshot } = await import('./store.mjs');
const { consumeCredit, refreshCreditStatus } = await import('./consume.mjs');
const expiry = Math.floor(Date.now() / 1000) + 86400;
const cardId = 'RateLimitResetCredit_test';
const db = openStore();
saveCodexSnapshot(db, { availableCount: 1, credits: [
  { id: cardId, status: 'available', title: '测试卡', expiresAt: expiry },
] });
db.close();

test('use result reads new limits and keeps the consumed card used even if a read is stale', async () => {
  const methods = [];
  const appServer = async (_script, method) => {
    methods.push(method);
    if (method === 'account/rateLimitResetCredit/consume') return { outcome: 'reset' };
    return { rateLimitResetCredits: { availableCount: 1, credits: [
      { id: cardId, status: 'available', title: '测试卡', expiresAt: expiry },
    ] }, rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300 },
      secondary: { usedPercent: 1, windowDurationMins: 10080 } } };
  };
  const result = await consumeCredit(cardId, 'once', { appServer });
  assert.deepEqual(methods, ['account/rateLimitResetCredit/consume', 'account/rateLimits/read']);
  assert.equal(result.outcome, 'reset');
  assert.equal(result.statusInfo.remaining, 1);
  assert.equal(result.statusInfo.primary.usedPercent, 5);
  const check = openStore();
  try { assert.equal(getCard(check, cardId).status, 'used'); }
  finally { check.close(); }
});

test('refresh only reads limits and updates the current count', async () => {
  const methods = [];
  const status = await refreshCreditStatus({ appServer: async (_script, method) => {
    methods.push(method);
    return { rateLimitResetCredits: { availableCount: 0, credits: [] } };
  } });
  assert.deepEqual(methods, ['account/rateLimits/read']);
  assert.equal(status.remaining, 0);
  const check = openStore();
  try { assert.equal(getCard(check, cardId).status, 'used'); }
  finally { check.close(); }
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
