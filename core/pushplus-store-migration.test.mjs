import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-pushplus-migration-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
after(() => rmSync(directory, { recursive: true, force: true }));
const old = new DatabaseSync(join(directory, 'data.db'));
old.exec(`CREATE TABLE reminder_attempts (
  card_id TEXT NOT NULL, expires_at INTEGER NOT NULL, node_kind TEXT NOT NULL,
  node_at INTEGER NOT NULL, threshold_days INTEGER NOT NULL, channel TEXT NOT NULL,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, attempted_at INTEGER,
  succeeded_at INTEGER, next_retry_at INTEGER, error_code TEXT, error_text TEXT,
  PRIMARY KEY (card_id, expires_at, node_kind, node_at, channel));
  INSERT INTO reminder_attempts VALUES ('existing-card', 1800000000, 'fixed', 1799395200,
    7, 'wechat', 'failed', 3, 1799395200, NULL, 1799395500, 'network', '旧发送记录');`);
old.close();
const store = await import('./store.mjs');

test('旧版发送记录 ALTER 迁移后字段和计数保留，再次打开不重复迁移', () => {
  for (let opened = 0; opened < 2; opened++) {
    const db = store.openStore();
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      const rows = db.prepare('SELECT * FROM reminder_attempts').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].card_id, 'existing-card');
      assert.equal(rows[0].state, 'failed');
      assert.equal(rows[0].attempts, 3);
      assert.equal(rows[0].next_retry_at, 1799395500);
      assert.equal(rows[0].error_text, '旧发送记录');
      assert.equal(rows[0].confirmation, null);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pushplus_submissions').get().count, 0);
    } finally { db.close(); }
  }
});
