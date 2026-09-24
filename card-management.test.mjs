import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-card-management-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const { getSnooze, openStore, recordDelivery, saveCodexSnapshot, scheduleSnooze } = await import('./store.mjs');
const { planCardNextCheck } = await import('./plan-next.mjs');
const { runCardsCommand } = await import('./cards.mjs');

test('card management shows the next node and cancelling a snooze restores it', () => {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 8 * 86400;
  const id = 'management-credit';
  const db = openStore();
  try {
    saveCodexSnapshot(db, { availableCount: 1, credits: [
      { id, status: 'available', title: '计划卡', expiresAt: expiry },
    ] }, now);
    for (const channel of ['desktop', 'feishu']) recordDelivery(db, id, expiry, 7, channel);
    const card = db.prepare('SELECT id, source, status, expires_at AS expiresAt, reported_used_at AS reportedUsedAt FROM cards WHERE id = ?').get(id);
    const normal = planCardNextCheck(db, card, { channels: ['desktop', 'feishu'], nowSeconds: now });
    assert.equal(normal.nextAt, expiry - 3 * 86400);
    assert.equal(normal.nextKind, '3d');

    scheduleSnooze(db, id, expiry, now + 6 * 86400);
    const delayed = planCardNextCheck(db, card, { channels: ['desktop', 'feishu'], nowSeconds: now });
    assert.equal(delayed.nextAt, now + 6 * 86400);
    assert.equal(delayed.nextKind, 'snooze');
    assert.equal(runCardsCommand(['unsnooze', id]).cleared, true);
    assert.equal(getSnooze(db, id), null);
    assert.equal(planCardNextCheck(db, card,
      { channels: ['desktop', 'feishu'], nowSeconds: now }).nextAt, normal.nextAt);
    assert.throws(() => runCardsCommand(['unsnooze', id]), /没有可取消的延期提醒/);
  } finally { db.close(); }
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
