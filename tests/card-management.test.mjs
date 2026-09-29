import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-card-management-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
process.env.CODEX_RESET_MONITOR_CONFIG_PATH = join(directory, 'config.json');
writeFileSync(process.env.CODEX_RESET_MONITOR_CONFIG_PATH,
  JSON.stringify({ codexScript: 'missing-codex', desktop: { enabled: true }, feishu: { enabled: false } }));
const { addManualCard, getCard, getSnooze, listCards, openStore, recordDelivery,
  saveCodexSnapshot, scheduleSnooze } = await import('../legacy/node/store.mjs');
const { planCardNextCheck } = await import('../legacy/node/plan-next.mjs');
const { runCardsCommand } = await import('../legacy/node/cards.mjs');
const { runCoreOperation } = await import('../desktop/core-operations.mjs');
const { runReminders } = await import('../legacy/node/remind.mjs');

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

test('official cards are read-only; legacy local records stay stored but cannot be managed or sent', async () => {
  const now = Math.floor(Date.now() / 1000);
  const db = openStore();
  let legacyId;
  let before;
  try {
    legacyId = addManualCard(db, { title: '旧本地记录', expiresAt: now + 86400 });
    before = getCard(db, 'management-credit');
    assert.deepEqual(planCardNextCheck(db, getCard(db, legacyId), { nowSeconds: now }),
      { nextAt: null, nextKind: null, dueAt: null, dueKind: null });
  } finally { db.close(); }
  for (const op of ['addManualCard', 'updateManualCard', 'markManualUsed']) {
    await assert.rejects(runCoreOperation(op, { cardId: before.id, title: '改写官方卡', expiresAt: now + 86400 }), /未知操作/);
  }
  for (const command of ['add', 'edit', 'used']) {
    assert.throws(() => runCardsCommand([command, before.id, '改写官方卡', '2030-01-01T10:00']), /功能已移除/);
  }
  for (const op of ['scheduleSnooze', 'clearSnooze']) {
    await assert.rejects(runCoreOperation(op, { cardId: legacyId, option: '1d' }), /官方重置卡/);
  }
  assert.equal(await runCoreOperation('getCard', { cardId: legacyId }), null);
  for (const cards of [(await runCoreOperation('manageSnapshot')).cards,
    await runCoreOperation('listCards'), runCardsCommand(['list']).cards]) {
    assert.deepEqual(cards.map(card => card.id), [before.id]);
  }
  const shown = [];
  await runReminders({ configPath: process.env.CODEX_RESET_MONITOR_CONFIG_PATH, nowSeconds: now,
    desktop: async (payload) => shown.push(payload.creditId) });
  assert.deepEqual(shown, []);
  const after = openStore();
  try {
    assert.equal(listCards(after, true).length, 2);
    assert.ok(getCard(after, legacyId));
    assert.equal(getCard(after, before.id).title, before.title);
    assert.equal(getCard(after, before.id).expiresAt, before.expiresAt);
  } finally { after.close(); }
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
