import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-delivery-results-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const { listReminderResults, openStore, saveCodexSnapshot } = await import('./store.mjs');
const { runReminders } = await import('./remind.mjs');
const configPath = join(directory, 'config.json');
writeFileSync(configPath, JSON.stringify({ desktop: { enabled: true }, feishu: { enabled: true },
  wechat: { enabled: false, }, }));

test('each channel result survives restart without storing external error details', async () => {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 7 * 86400;
  const db = openStore();
  try {
    saveCodexSnapshot(db, { availableCount: 1, credits: [
      { id: 'result-card', status: 'available', title: '结果测试卡', expiresAt },
    ] }, now - 60);
  } finally { db.close(); }
  const sent = await runReminders({ configPath, nowSeconds: now, trackAttempts: true,
    desktop: async () => {}, feishu: async () => { throw new Error('secret=do-not-store'); } });
  assert.equal(sent.due[0].desktop, 'shown');
  assert.match(sent.due[0].feishu, /failed:/);
  const reopened = openStore();
  try {
    const rows = listReminderResults(reopened, 'result-card');
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.channel === 'desktop').state, 'sent');
    assert.equal(rows.find((row) => row.channel === 'feishu').state, 'failed');
    assert.equal(rows.find((row) => row.channel === 'feishu').attemptedAt, now);
    assert.doesNotMatch(JSON.stringify(rows), /do-not-store/);
  } finally { reopened.close(); }
});

test('dry run does not become a real sending result', async () => {
  const db = openStore();
  const before = db.prepare('SELECT COUNT(*) AS count FROM reminder_attempts').get().count;
  db.close();
  await runReminders({ configPath, dryRun: true, trackAttempts: true });
  const after = openStore();
  try { assert.equal(after.prepare('SELECT COUNT(*) AS count FROM reminder_attempts').get().count, before); }
  finally { after.close(); }
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
