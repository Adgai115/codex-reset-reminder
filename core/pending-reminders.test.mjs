import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import { pendingReminder } from './pending-reminders.mjs';

const directory = mkdtempSync(join(tmpdir(), 'codex-pending-reminders-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const store = await import('./store.mjs');
after(() => rmSync(directory, { recursive: true, force: true }));
const now = 1_800_000_000;
const expiresAt = now + 2 * 86400;
const card = { id: 'official-pending', title: '官方卡', source: 'codex', status: 'available', expiresAt };
const node = { cardId: card.id, expiresAt, nodeKind: 'fixed', nodeAt: expiresAt - 3 * 86400, thresholdDays: 3 };
const sent = { ...node, channel: 'desktop', state: 'sent', attemptedAt: now - 10, succeededAt: now - 10 };

test('待处理在重开数据库后保留，各渠道合并为一项，旧版记录可直接读取', () => {
  let db = store.openStore();
  try {
    store.saveCodexSnapshot(db, { availableCount: 1, credits: [card] }, now);
    store.recordDelivery(db, card.id, expiresAt, 3, 'desktop');
    assert.ok(pendingReminder(card, null, store.listReminderResults(db, card.id), now));
    store.recordReminderResult(db, node, 'desktop', { state: 'sent', attemptedAt: now });
    store.recordReminderResult(db, node, 'feishu', { state: 'sent', attemptedAt: now });
  } finally { db.close(); }
  db = store.openStore();
  try {
    const results = store.listReminderResults(db, card.id);
    assert.equal(results.length, 2);
    assert.deepEqual(pendingReminder(store.getCard(db, card.id), null, results, now), {
      nodeKind: 'fixed', nodeAt: node.nodeAt, thresholdDays: 3, notifiedAt: now,
    });
    assert.equal(store.deliveryExists(db, card.id, expiresAt, 3, 'desktop'), true);
  } finally { db.close(); }
});

test('未发送、发送失败、旧有效期、已使用、已过期及手动卡不产生待处理', () => {
  for (const state of ['failed', 'sending'])
    assert.equal(pendingReminder(card, null, [{ ...sent, state }], now), null);
  assert.equal(pendingReminder(card, null, [], now), null);
  assert.equal(pendingReminder(card, null, [{ ...sent, expiresAt: expiresAt - 1 }], now), null);
  assert.equal(pendingReminder(card, null, [{ ...sent, nodeAt: now + 1 }], now), null);
  for (const override of [{ status: 'used' }, { status: 'not_available' }, { source: 'manual' }])
    assert.equal(pendingReminder({ ...card, ...override }, null, [sent], now), null);
  assert.equal(pendingReminder(card, null, [sent], expiresAt), null);
  // 本地使用反馈尚未被官方确认，不能自行消除提醒。
  assert.ok(pendingReminder({ ...card, reportedUsedAt: now }, null, [sent], now));
});

test('延期隐藏旧提醒，送达后重新出现，新的固定节点自动接管', () => {
  const snooze = { expiresAt, targetAt: now + 60, desktopDeliveredAt: null };
  assert.equal(pendingReminder(card, snooze, [sent], now), null);
  // 到达延期时间还不算送达，也不能恢复旧的待处理。
  assert.equal(pendingReminder(card, snooze, [sent], now + 60), null);
  const snoozed = { ...sent, nodeKind: 'snooze', nodeAt: snooze.targetAt, thresholdDays: 0, attemptedAt: now + 60 };
  assert.equal(pendingReminder(card, snooze, [sent, snoozed], now + 60), null);
  const delivered = { ...snooze, desktopDeliveredAt: now + 60 };
  assert.equal(pendingReminder(card, delivered, [sent, snoozed], now + 60).nodeKind, 'snooze');
  assert.equal(pendingReminder(card, { ...delivered, targetAt: now + 120 }, [sent, snoozed], now + 60), null);
  const next = { ...sent, nodeAt: expiresAt - 86400, thresholdDays: 1 };
  assert.equal(pendingReminder(card, delivered, [sent, snoozed, next], next.nodeAt).thresholdDays, 1);
  assert.ok(pendingReminder(card, null, [sent], now), '取消延期恢复原待处理');
});
