import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-sync-test-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const { getCard, getFeishuMessage, openStore, recordFeishuMessage,
  reportCardUsed, saveCodexSnapshot, setFeishuMessageStatus } = await import('./store.mjs');
const { syncCards } = await import('./sync.mjs');
const configPath = join(directory, 'config.json');
writeFileSync(configPath, JSON.stringify({ codexScript: 'fake-codex', feishu: { enabled: true } }));

test('complete sync confirms reported use and retries a failed Feishu card update', async () => {
  const expiry = Math.floor(Date.now() / 1000) + 8 * 86400;
  const db = openStore();
  try {
    saveCodexSnapshot(db, { availableCount: 1, credits: [
      { id: 'credit-test', status: 'available', title: '测试卡', expiresAt: expiry },
    ] });
    recordFeishuMessage(db, { messageId: 'om_sync_test', cardId: 'credit-test',
      expiresAt: expiry, thresholdDays: 7, recipientOpenId: 'ou_owner' });
    reportCardUsed(db, 'credit-test');
    setFeishuMessageStatus(db, 'om_sync_test', 'pending_verification');
  } finally { db.close(); }

  const appServer = async (_script, method) => {
    assert.equal(method, 'account/rateLimits/read');
    return { rateLimitResetCredits: { availableCount: 0, credits: [] } };
  };
  const failed = await syncCards(configPath, {
    appServer, patchCard: async () => { throw new Error('offline'); },
  });
  assert.equal(failed.countDelta, -1);
  assert.deepEqual(failed.newlyUsed, ['credit-test']);
  assert.deepEqual(failed.cardUpdateFailures, ['om_sync_test']);
  const midway = openStore();
  try {
    assert.equal(getCard(midway, 'credit-test').status, 'used');
    assert.equal(getFeishuMessage(midway, 'om_sync_test').actionStatus, 'pending_verification');
  } finally { midway.close(); }

  let patchCalls = 0;
  const retried = await syncCards(configPath, {
    appServer, patchCard: async (_config, messageId, _card, _days, state) => {
      assert.equal(messageId, 'om_sync_test');
      assert.equal(state, 'used');
      patchCalls++;
    },
  });
  assert.deepEqual(retried.cardUpdateFailures, []);
  assert.equal(patchCalls, 1);
  const finalDb = openStore();
  try { assert.equal(getFeishuMessage(finalDb, 'om_sync_test').actionStatus, 'used'); }
  finally { finalDb.close(); }
});

test('delayed complete sync keeps a still-available card active and restores its Feishu reminder', async () => {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 9 * 86400;
  const credit = { id: 'still-available', status: 'available', title: '仍可用', expiresAt: expiry };
  const db = openStore();
  try {
    saveCodexSnapshot(db, { availableCount: 1, credits: [credit] }, now - 700);
    recordFeishuMessage(db, { messageId: 'om_still_available', cardId: credit.id,
      expiresAt: expiry, thresholdDays: 7, recipientOpenId: 'ou_owner' });
    reportCardUsed(db, credit.id, now - 601);
    setFeishuMessageStatus(db, 'om_still_available', 'pending_verification');
  } finally { db.close(); }
  const patches = [];
  const result = await syncCards(configPath, {
    appServer: async () => ({ rateLimitResetCredits: { availableCount: 1, credits: [credit] } }),
    patchCard: async (_config, messageId, _card, _days, state, _next, notice) => {
      patches.push({ messageId, state, notice });
    },
  });
  assert.equal(result.complete, true);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].state, 'available');
  assert.match(patches[0].notice, /后续提前提醒会保留/);
  const after = openStore();
  try {
    assert.equal(getCard(after, credit.id).status, 'available');
    assert.equal(getFeishuMessage(after, 'om_still_available').actionStatus, 'available');
  } finally { after.close(); }
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
