import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-desktop-batch-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const store = await import('./core/store.mjs');
const { runReminders } = await import('./remind.mjs');
after(() => rmSync(directory, { recursive: true, force: true }));
const configPath = join(directory, 'config.json');
const now = Math.floor(Date.now() / 1000) + 120;
const cards = [2, 6, 8].map((days, i) => ({ id: `batch-${i}`, title: '同名官方卡', status: 'available', expiresAt: now + days * 86400 }));
const sendOptions = { configPath, nowSeconds: now, trackAttempts: true, batchDesktop: true };
function seed(config = {}) {
  writeFileSync(configPath, JSON.stringify({ desktop: { enabled: true }, feishu: { enabled: true }, ...config }));
  const db = store.openStore();
  try {
    db.exec('DELETE FROM reminder_attempts; DELETE FROM reminder_deliveries; DELETE FROM snoozes; DELETE FROM sync_history; DELETE FROM cards;');
    store.saveCodexSnapshot(db, { availableCount: cards.length, credits: cards }, now);
    store.scheduleSnooze(db, cards[2].id, cards[2].expiresAt, now - 10);
  } finally { db.close(); }
}
function results(id) {
  const db = store.openStore();
  try { return store.listReminderResults(db, id); } finally { db.close(); }
}

test('固定与延期节点同轮只创建一个桌面批次，各卡各渠道仍独立记账', async () => {
  seed(); let batches = 0; let feishu = 0;
  const sends = { ...sendOptions, desktop: async (payload) => {
    batches++; assert.equal(payload.cards.length, 3);
    assert.deepEqual(new Set(payload.cards.map((card) => card.nodeKind)), new Set(['fixed', 'snooze']));
  }, feishu: async () => { feishu++; } };
  await runReminders(sends);
  for (const card of cards) {
    assert.equal(results(card.id).length, 2);
    assert.ok(results(card.id).every((result) => result.state === 'sent' && result.attempts === 1));
  }
  await runReminders(sends);
  assert.equal(batches, 1); assert.equal(feishu, 3);
});

test('合并弹窗失败只补发桌面，延期的卡自动退出失败批次', async () => {
  seed(); let feishu = 0;
  await runReminders({ ...sendOptions, desktop: async () => { throw new Error('window unavailable'); },
    feishu: async () => { feishu++; } });
  const db = store.openStore();
  try { store.scheduleSnooze(db, cards[0].id, cards[0].expiresAt, now + 3600); } finally { db.close(); }
  let ids;
  await runReminders({ ...sendOptions, nowSeconds: now + 60,
    desktop: async ({ cards }) => { ids = cards.map((card) => card.creditId); },
    feishu: async () => { feishu++; } });
  assert.deepEqual(ids, ['batch-1', 'batch-2']);
  assert.equal(feishu, 3);
  assert.equal(results('batch-0').find((result) => result.channel === 'desktop').attempts, 1);
  assert.ok(results('batch-1').some((result) => result.channel === 'desktop' && result.state === 'sent' && result.attempts === 2));
});

test('并发检查不会在批次显示前重复占用同一渠道', async () => {
  seed({ feishu: { enabled: false } });
  let release; let arrived;
  const started = new Promise((resolve) => { arrived = resolve; });
  const first = runReminders({ ...sendOptions, desktop: async () => {
    arrived(); await new Promise((resolve) => { release = resolve; });
  } });
  await started;
  try { await runReminders({ ...sendOptions, desktop: async () => assert.fail('不应重复创建批次') }); }
  finally { release(); await first; }
  assert.ok(cards.every((card) => results(card.id)[0].attempts === 1));
});

test('模拟执行、渠道关闭、账号未核实和免打扰不会创建批次', async () => {
  const desktop = async () => assert.fail('不应创建弹窗');
  seed({ feishu: { enabled: false } });
  await runReminders({ ...sendOptions, dryRun: true, desktop });
  assert.equal(results(cards[0].id).length, 0);
  await runReminders({ ...sendOptions, allowCodex: false, desktop });
  seed({ desktop: { enabled: false }, feishu: { enabled: false } });
  await runReminders({ ...sendOptions, desktop });
  const clock = new Date(now * 1000);
  const at = (offset) => {
    const date = new Date(clock); date.setMinutes(date.getMinutes() + offset);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };
  seed({ feishu: { enabled: false }, reminders: { quietHours: { enabled: true, start: at(-1), end: at(60) } } });
  await runReminders({ ...sendOptions, desktop });
  assert.ok(cards.every((card) => results(card.id).length === 0));
});

test('等待其他渠道期间的用卡、延期和关闭渠道，在弹窗提交前重新核对', async () => {
  seed(); let calls = 0; let shown;
  await runReminders({ ...sendOptions, desktop: async ({ cards }) => { shown = cards.map((card) => card.creditId); },
    feishu: async () => {
      if (++calls !== 2) return;
      const db = store.openStore();
      try {
        store.scheduleSnooze(db, cards[0].id, cards[0].expiresAt, now + 3600);
        store.markCardUsed(db, cards[1].id);
      } finally { db.close(); }
    } });
  assert.deepEqual(shown, ['batch-2']);
  assert.ok(!results('batch-0').some((result) => result.channel === 'desktop'));
  assert.ok(!results('batch-1').some((result) => result.channel === 'desktop'));
  seed();
  await runReminders({ ...sendOptions, desktop: async () => assert.fail('已关闭桌面渠道'),
    feishu: async () => { writeFileSync(configPath, JSON.stringify({ desktop: { enabled: false } })); } });
  assert.ok(cards.every((card) => !results(card.id).some((result) => result.channel === 'desktop')));
});
