import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-delivery-retry-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const { getReminderAttempt, markCardUsed, openStore, saveCodexSnapshot,
  scheduleSnooze } = await import('./store.mjs');
const { planNextCheck } = await import('./plan-next.mjs');
const { runReminders } = await import('./remind.mjs');
const configPath = join(directory, 'config.json');
const now = Math.floor(Date.now() / 1000);
const cardId = 'retry-card';
const expiry = now + 7 * 86400;
const node = { cardId, expiresAt: expiry, nodeKind: 'fixed', nodeAt: now, thresholdDays: 7 };

function config(changes = {}) {
  writeFileSync(configPath, JSON.stringify({ desktop: { enabled: false },
    feishu: { enabled: true }, wechat: { enabled: false }, ...changes }));
}
function seed() {
  const db = openStore();
  try {
    db.exec('DELETE FROM reminder_attempts; DELETE FROM reminder_deliveries; DELETE FROM snoozes; DELETE FROM sync_history; DELETE FROM cards;');
    saveCodexSnapshot(db, { availableCount: 1, credits: [
      { id: cardId, status: 'available', title: '补发卡', expiresAt: expiry },
    ] }, now - 60);
  } finally { db.close(); }
}
function attempt() {
  const db = openStore();
  try { return getReminderAttempt(db, { ...node, channel: 'feishu' }); }
  finally { db.close(); }
}

test('only the failed channel is retried after restart; success stays deduplicated', async () => {
  seed(); config({ desktop: { enabled: true } });
  let desktop = 0;
  let feishu = 0;
  const send = { configPath, trackAttempts: true,
    desktop: async () => { desktop++; },
    feishu: async () => { feishu++; if (feishu === 1) throw new Error('offline'); } };
  await runReminders({ ...send, nowSeconds: now });
  assert.equal(desktop, 1);
  assert.equal(feishu, 1);
  assert.equal(attempt().nextRetryAt, now + 60);
  const reopened = openStore();
  try { assert.equal(planNextCheck(reopened, { channels: ['desktop', 'feishu'],
    nowSeconds: now }).nextAt, now + 60); }
  finally { reopened.close(); }
  await runReminders({ ...send, nowSeconds: now + 59 });
  assert.equal(feishu, 1);
  await runReminders({ ...send, nowSeconds: now + 60 });
  assert.equal(desktop, 1);
  assert.equal(feishu, 2);
  assert.equal(attempt().state, 'sent');
  assert.equal(attempt().attempts, 2);
});

test('retry gaps are 1, 5, 15 minutes, then automatic sending stops', async () => {
  seed(); config();
  let calls = 0;
  const send = { configPath, trackAttempts: true,
    feishu: async () => { calls++; throw new Error('timeout'); } };
  for (const [at, next] of [[now, now + 60], [now + 60, now + 360],
    [now + 360, now + 1260], [now + 1260, null]]) {
    await runReminders({ ...send, nowSeconds: at });
    assert.equal(attempt().nextRetryAt, next);
  }
  assert.equal(attempt().attempts, 4);
  assert.equal(attempt().state, 'failed');
  await runReminders({ ...send, nowSeconds: now + 3600 });
  await runReminders({ ...send, nowSeconds: now + 3600, manualRetry: node });
  assert.equal(calls, 4);
});

test('manual retry is limited to an existing failed node; snooze supersedes it', async () => {
  seed(); config();
  let calls = 0;
  const send = { configPath, trackAttempts: true,
    feishu: async () => { calls++; throw new Error('offline'); } };
  await runReminders({ ...send, nowSeconds: now, manualRetry: node });
  assert.equal(calls, 0);
  await runReminders({ ...send, nowSeconds: now });
  const db = openStore();
  try { scheduleSnooze(db, cardId, expiry, now + 3600); }
  finally { db.close(); }
  await runReminders({ ...send, nowSeconds: now + 60, manualRetry: node });
  assert.equal(calls, 1);
  await runReminders({ ...send, nowSeconds: now + 3600 });
  assert.equal(calls, 2);
});

test('new 3-day node, disabled channel, and used card never revive an old retry', async () => {
  seed(); config();
  let calls = 0;
  const send = { configPath, trackAttempts: true,
    feishu: async () => { calls++; if (calls === 1) throw new Error('offline'); } };
  await runReminders({ ...send, nowSeconds: now });
  config({ feishu: { enabled: false } });
  await runReminders({ ...send, nowSeconds: now + 60 });
  assert.equal(calls, 1);
  config();
  await runReminders({ ...send, nowSeconds: now + 4 * 86400 });
  assert.equal(calls, 2);
  assert.equal(attempt().attempts, 1);
  const db = openStore();
  try { markCardUsed(db, cardId); } finally { db.close(); }
  await runReminders({ ...send, nowSeconds: now + 4 * 86400 + 60 });
  assert.equal(calls, 2);
});

test('quiet hours defer failed-channel retry and manual retry', async () => {
  seed();
  const date = new Date();
  date.setHours(21, 59, 0, 0);
  const at = Math.floor(date.getTime() / 1000);
  const quietExpiry = at + 7 * 86400;
  const db = openStore();
  try {
    db.prepare('UPDATE cards SET expires_at = ? WHERE id = ?').run(quietExpiry, cardId);
  } finally { db.close(); }
  config({ reminders: { quietHours: { enabled: true, start: '22:00', end: '09:00' } } });
  let calls = 0;
  const send = { configPath, trackAttempts: true,
    feishu: async () => { calls++; throw new Error('offline'); } };
  await runReminders({ ...send, nowSeconds: at });
  assert.equal(calls, 1);
  await runReminders({ ...send, nowSeconds: at + 120,
    manualRetry: { ...node, expiresAt: quietExpiry, nodeAt: at } });
  assert.equal(calls, 1);
  const morning = new Date(date); morning.setDate(morning.getDate() + 1); morning.setHours(9, 0, 0, 0);
  await runReminders({ ...send, nowSeconds: Math.floor(morning.getTime() / 1000) });
  assert.equal(calls, 2);
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
