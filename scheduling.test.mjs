import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-scheduling-test-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const { getCard, listDueUsageVerifications, openStore, recordDelivery, reportCardUsed,
  saveCodexSnapshot, scheduleSnooze } = await import('./store.mjs');
const { planNextCheck } = await import('./plan-next.mjs');
const { verifyPendingUsage } = await import('./verify-pending.mjs');

test('the next exact trigger follows fixed nodes, snooze, and a delayed usage check', async () => {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 8 * 86400;
  const db = openStore();
  try {
    saveCodexSnapshot(db, { availableCount: 1, credits: [
      { id: 'scheduled-credit', status: 'available', title: '计划卡', expiresAt: expiry },
    ] }, now);
    assert.equal(planNextCheck(db, { feishuEnabled: true, nowSeconds: now }).nextAt, expiry - 7 * 86400);
    for (const channel of ['desktop', 'feishu']) recordDelivery(db, 'scheduled-credit', expiry, 7, channel);
    assert.equal(planNextCheck(db, { feishuEnabled: true, nowSeconds: now }).nextAt, expiry - 3 * 86400);
    scheduleSnooze(db, 'scheduled-credit', expiry, now + 6 * 86400);
    assert.equal(planNextCheck(db, { feishuEnabled: true, nowSeconds: now }).nextAt, now + 6 * 86400);
    reportCardUsed(db, 'scheduled-credit', now);
    assert.equal(planNextCheck(db, { feishuEnabled: true, nowSeconds: now }).nextAt, now + 600);
    assert.deepEqual(listDueUsageVerifications(db, now + 599), []);
    assert.equal(listDueUsageVerifications(db, now + 600)[0].id, 'scheduled-credit');
  } finally { db.close(); }

  let calls = 0;
  assert.equal((await verifyPendingUsage({ nowSeconds: now + 599, sync: async () => { calls++; } })).checked, false);
  const verified = await verifyPendingUsage({ nowSeconds: now + 600, sync: async () => {
    calls++;
    const store = openStore();
    try { return saveCodexSnapshot(store, { availableCount: 1, credits: [
      { id: 'scheduled-credit', status: 'available', title: '计划卡', expiresAt: expiry },
    ] }, now + 600); } finally { store.close(); }
  } });
  assert.equal(verified.checked, true);
  assert.equal(calls, 1);
  const after = openStore();
  try {
    assert.equal(getCard(after, 'scheduled-credit').status, 'available');
    assert.deepEqual(listDueUsageVerifications(after, now + 3600), []);
    assert.equal(planNextCheck(after, { feishuEnabled: true, nowSeconds: now + 600 }).nextAt, now + 6 * 86400);
  } finally { after.close(); }
});

test('a delayed complete sync confirms disappearance and cancels future triggers', async () => {
  const now = Math.floor(Date.now() / 1000);
  const db = openStore();
  try {
    saveCodexSnapshot(db, { availableCount: 0, credits: [] }, now + 601);
    assert.equal(getCard(db, 'scheduled-credit').status, 'used');
    assert.equal(planNextCheck(db, { feishuEnabled: true, nowSeconds: now + 601 }).nextAt, null);
  } finally { db.close(); }
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
