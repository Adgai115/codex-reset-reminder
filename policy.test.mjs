import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireListenerLease } from './listener-lease.mjs';
import { deliveryTime, enabledChannels, quietHours } from './reminder-policy.mjs';

const directory = mkdtempSync(join(tmpdir(), 'codex-reminder-policy-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const { openStore, saveCodexSnapshot } = await import('./store.mjs');
const { planNextCheck } = await import('./plan-next.mjs');
const { preflightSync } = await import('./preflight-sync.mjs');
const { runReminders } = await import('./remind.mjs');

test('channel switches and quiet hours share one schedule and do not pass expiry', async () => {
  const config = { desktop: { enabled: true }, feishu: { enabled: false },
    reminders: { quietHours: { enabled: true, start: '22:00', end: '09:00' } } };
  assert.deepEqual(enabledChannels(config), ['desktop']);
  const quiet = quietHours(config);
  const nodeAt = Math.floor(new Date(2026, 8, 28, 6, 48, 0).getTime() / 1000);
  const deferred = Math.floor(new Date(2026, 8, 28, 9, 0, 0).getTime() / 1000);
  assert.equal(deliveryTime(nodeAt, nodeAt + 7 * 86400, quiet), deferred);
  assert.equal(deliveryTime(nodeAt, nodeAt + 3600, quiet), nodeAt);

  const db = openStore();
  try {
    saveCodexSnapshot(db, { availableCount: 1, credits: [
      { id: 'quiet-credit', status: 'available', title: '安静时段卡', expiresAt: nodeAt + 7 * 86400 },
    ] }, nodeAt - 3600);
    assert.equal(planNextCheck(db, { channels: enabledChannels(config), quiet,
      nowSeconds: nodeAt - 3600 }).nextAt, deferred);
    assert.equal(planNextCheck(db, { channels: [], quiet,
      nowSeconds: nodeAt - 3600 }).nextAt, null);
  } finally { db.close(); }
  const configPath = join(directory, 'quiet-config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const shown = [];
  await runReminders({ configPath, nowSeconds: nodeAt, desktop: async (item) => shown.push(item) });
  assert.equal(shown.length, 0);
  await runReminders({ configPath, nowSeconds: deferred, desktop: async (item) => shown.push(item) });
  assert.equal(shown.length, 1);
});

test('preflight reads Codex only for an unsent due card and offline fallback still alerts', async () => {
  const now = Math.floor(Date.now() / 1000);
  const db = openStore();
  try {
    db.exec('DELETE FROM reminder_deliveries; DELETE FROM sync_history; DELETE FROM cards;');
    saveCodexSnapshot(db, { availableCount: 1, credits: [
      { id: 'offline-preflight', status: 'available', title: '离线卡', expiresAt: now + 7 * 86400 },
    ] }, now - 7200);
  } finally { db.close(); }
  const configPath = join(directory, 'preflight-config.json');
  writeFileSync(configPath, JSON.stringify({ desktop: { enabled: true }, feishu: { enabled: false } }));
  let calls = 0;
  const result = await preflightSync({ configPath, nowSeconds: now, sync: async () => {
    calls++;
    throw new Error('offline');
  } });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  const shown = [];
  await runReminders({ configPath, nowSeconds: now, desktop: async (item) => shown.push(item) });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].creditId, 'offline-preflight');
  assert.equal((await preflightSync({ configPath, nowSeconds: now, sync: async () => {
    calls++;
  } })).reason, 'nothing_due');
  assert.equal(calls, 1);
});

test('a successful preflight removes a no-longer-available card before delivery', async () => {
  const now = Math.floor(Date.now() / 1000);
  const db = openStore();
  try {
    db.exec('DELETE FROM reminder_deliveries; DELETE FROM sync_history; DELETE FROM cards;');
    saveCodexSnapshot(db, { availableCount: 1, credits: [
      { id: 'used-before-alert', status: 'available', title: '已不在用量页', expiresAt: now + 3 * 86400 },
    ] }, now - 7200);
  } finally { db.close(); }
  const configPath = join(directory, 'preflight-config.json');
  const result = await preflightSync({ configPath, nowSeconds: now, sync: async () => {
    const store = openStore();
    try { return saveCodexSnapshot(store, { availableCount: 0, credits: [] }, now); }
    finally { store.close(); }
  } });
  assert.equal(result.ok, true);
  const shown = [];
  await runReminders({ configPath, nowSeconds: now, desktop: async (item) => shown.push(item) });
  assert.equal(shown.length, 0);
});

test('only one Feishu listener can own the local lease', async () => {
  const identity = join(directory, 'one-listener');
  const first = await acquireListenerLease(identity);
  assert.ok(first);
  try {
    assert.equal(await acquireListenerLease(identity), null);
  } finally {
    await new Promise((resolve) => first.close(resolve));
  }
  const next = await acquireListenerLease(identity);
  assert.ok(next);
  await new Promise((resolve) => next.close(resolve));
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
