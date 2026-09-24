import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-reset-test-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const { openStore, saveCodexSnapshot, listCards, addManualCard, latestSync,
  recordDelivery, scheduleSnooze } = await import('./store.mjs');
const { runReminders } = await import('./remind.mjs');
const { dueThreshold } = await import('./check.mjs');
const { getSnoozeOptions, planSnooze } = await import('./later.mjs');
const configPath = join(directory, 'config.json');
writeFileSync(configPath, JSON.stringify({ codexScript: 'missing-codex', feishu: { enabled: true } }));

test('reminder thresholds begin exactly 7, 3, and 1 days before expiry', () => {
  const expiry = Math.floor(Date.now() / 1000) + 10 * 86400;
  assert.equal(dueThreshold(expiry, expiry - 7 * 86400 - 1), null);
  assert.equal(dueThreshold(expiry, expiry - 7 * 86400), 7);
  assert.equal(dueThreshold(expiry, expiry - 3 * 86400), 3);
  assert.equal(dueThreshold(expiry, expiry - 86400), 1);
  assert.equal(dueThreshold(expiry, expiry), null);
});

test('three fixed snooze choices keep the original expiry and tomorrow means local 10:00', () => {
  const now = Math.floor(new Date(2026, 8, 23, 9, 0, 0).getTime() / 1000);
  const card = { id: 'choice-test', status: 'available', expiresAt: now + 5 * 86400 };
  assert.deepEqual(getSnoozeOptions(card, now).map((item) => item.option),
    ['1d', '3d', 'tomorrow10']);
  assert.equal(planSnooze(card, '1d', now).targetAt, now + 86400);
  assert.equal(planSnooze(card, '3d', now).targetAt, now + 3 * 86400);
  const tomorrow = new Date((now + 86400) * 1000);
  tomorrow.setHours(10, 0, 0, 0);
  assert.equal(planSnooze(card, 'tomorrow10', now).targetAt,
    Math.floor(tomorrow.getTime() / 1000));
  assert.equal(card.expiresAt, now + 5 * 86400);
});

test('cached cards remind offline once per channel and threshold; partial sync keeps prior cards', async () => {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 7 * 86400;
  const db = openStore();
  try {
    const snapshot = saveCodexSnapshot(db, { availableCount: 1, credits: [{ id: 'test-credit', status: 'available', title: '测试卡', expiresAt: expiry }] }, now);
    assert.equal(snapshot.complete, true);
    saveCodexSnapshot(db, { availableCount: 1, credits: [] }, now + 1);
    assert.equal(latestSync(db).outcome, 'partial');
    assert.equal(listCards(db).length, 1);
  } finally { db.close(); }

  const calls = [];
  const handlers = { configPath,
    desktop: async (card) => calls.push(`desktop:${card.creditId}:${card.days}`),
    feishu: async (_, card, days) => calls.push(`feishu:${card.id}:${days}`) };
  await runReminders({ ...handlers, nowSeconds: now });
  await runReminders({ ...handlers, nowSeconds: now });
  assert.deepEqual(calls, ['feishu:test-credit:7', 'desktop:test-credit:7']);
  await runReminders({ ...handlers, nowSeconds: now + 4 * 86400 });
  assert.deepEqual(calls.slice(2), ['feishu:test-credit:3', 'desktop:test-credit:3']);
  const snoozeDb = openStore();
  try {
    recordDelivery(snoozeDb, 'test-credit', expiry, 1, 'feishu');
    recordDelivery(snoozeDb, 'test-credit', expiry, 1, 'desktop');
    scheduleSnooze(snoozeDb, 'test-credit', expiry, now + 6 * 86400);
  } finally { snoozeDb.close(); }
  await runReminders({ ...handlers, nowSeconds: now + 6 * 86400 });
  assert.deepEqual(calls.slice(4), ['feishu:test-credit:1', 'desktop:test-credit:1']);
  await runReminders({ ...handlers, nowSeconds: now + 6 * 86400 });
  assert.deepEqual(calls.slice(4), ['feishu:test-credit:1', 'desktop:test-credit:1']);
  const db2 = openStore();
  try {
    saveCodexSnapshot(db2, { availableCount: 0, credits: [] }, now + 4 * 86400 + 1);
    assert.equal(listCards(db2).length, 0);
    addManualCard(db2, { title: '手动卡', expiresAt: Math.floor(Date.now() / 1000) + 86400 });
    assert.equal(listCards(db2).length, 1);
  } finally { db2.close(); }
});

test('a snooze covering the 3-day node sends once, then keeps the 1-day node', async () => {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 7 * 86400;
  const db = openStore();
  try {
    db.exec('DELETE FROM card_action_events; DELETE FROM feishu_messages; DELETE FROM snoozes; DELETE FROM reminder_deliveries; DELETE FROM sync_history; DELETE FROM cards;');
    saveCodexSnapshot(db, { availableCount: 1, credits: [
      { id: 'conflict-card', status: 'available', title: '冲突测试卡', expiresAt: expiry },
    ] }, now);
    for (const channel of ['desktop', 'feishu']) recordDelivery(db, 'conflict-card', expiry, 7, channel);
    scheduleSnooze(db, 'conflict-card', expiry, now + 5 * 86400);
  } finally { db.close(); }
  const calls = [];
  const handlers = { configPath,
    desktop: async (item) => calls.push(`desktop:${item.days}`),
    feishu: async (_config, _item, days) => calls.push(`feishu:${days}`) };
  await runReminders({ ...handlers, nowSeconds: now + 4 * 86400 });
  assert.deepEqual(calls, []);
  await runReminders({ ...handlers, nowSeconds: now + 5 * 86400 });
  assert.deepEqual(calls, ['feishu:2', 'desktop:2']);
  await runReminders({ ...handlers, nowSeconds: now + 5 * 86400 + 60 });
  assert.equal(calls.length, 2);
  await runReminders({ ...handlers, nowSeconds: now + 6 * 86400 });
  assert.deepEqual(calls.slice(2), ['feishu:1', 'desktop:1']);
  const check = openStore();
  try { assert.equal(listCards(check)[0].expiresAt, expiry); }
  finally { check.close(); }
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
