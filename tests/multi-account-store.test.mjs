import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const directory = mkdtempSync(join(tmpdir(), 'codex-multi-account-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const old = new DatabaseSync(join(directory, 'data.db'));
old.exec(`CREATE TABLE account_scopes (slot INTEGER PRIMARY KEY CHECK (slot = 1),
  scope_id TEXT NOT NULL UNIQUE, email_hash TEXT, workspace_hash TEXT,
  display_name TEXT NOT NULL, bound_at INTEGER NOT NULL, verified_at INTEGER NOT NULL);
  INSERT INTO account_scopes VALUES (1, 'scope-old', 'hash-old', NULL, 'o***@example.com', 1, 1);
  CREATE TABLE sync_history (id INTEGER PRIMARY KEY AUTOINCREMENT, checked_at INTEGER NOT NULL,
    outcome TEXT NOT NULL, available_count INTEGER, detailed_count INTEGER, message TEXT);
  INSERT INTO sync_history (checked_at, outcome, available_count, detailed_count)
    VALUES (100, 'complete', 2, 2);`);
old.close();

const { activateAccountScope, bindAccountScope, getActiveAccountScope,
  latestCompleteSync, listAccountScopes, listDueUsageVerifications,
  openStore, reportCardUsed, saveCodexSnapshot, listCards } = await import('../core/store.mjs');

test('v2.0.3 single-account database migrates once and keeps per-account history', () => {
  const db = openStore();
  const expiry = Math.floor(Date.now() / 1000) + 8 * 86400;
  try {
    assert.equal(getActiveAccountScope(db).scopeId, 'scope-old');
    assert.equal(latestCompleteSync(db, 'scope-old').availableCount, 2);
    saveCodexSnapshot(db, { availableCount: 1, credits: [
      { id: 'old-credit', status: 'available', expiresAt: expiry },
    ] }, 200, 'scope-old');
    reportCardUsed(db, 'old-credit', 300);
    bindAccountScope(db, { scopeId: 'scope-new', emailHash: 'hash-new',
      workspaceHash: null, displayName: 'n***@example.com', nowSeconds: 400 });
    saveCodexSnapshot(db, { availableCount: 1, credits: [
      { id: 'new-credit', status: 'available', expiresAt: expiry },
    ] }, 1000, 'scope-new');
    saveCodexSnapshot(db, { availableCount: 2, credits: [
      { id: 'old-credit', status: 'available', expiresAt: expiry },
      { id: 'new-credit', status: 'available', expiresAt: expiry },
    ] }, 1100, 'scope-new');
    const collisions = listCards(db, true).filter((card) => card.creditId === 'old-credit');
    assert.equal(collisions.length, 2);
    assert.notEqual(collisions[0].id, collisions[1].id);
    assert.equal(new Set(collisions.map((card) => card.accountScopeId)).size, 2);
    assert.equal(latestCompleteSync(db, 'scope-old').checkedAt, 200);
    assert.equal(latestCompleteSync(db, 'scope-new').checkedAt, 1100);
    assert.deepEqual(listDueUsageVerifications(db, 1000, 600, 'scope-old')
      .map((row) => row.id), ['old-credit']);
    assert.deepEqual(listDueUsageVerifications(db, 1000, 600, 'scope-new'), []);
    assert.equal(listAccountScopes(db).length, 2);
    activateAccountScope(db, 'scope-old');
  } finally { db.close(); }
  const reopened = openStore();
  try {
    assert.equal(getActiveAccountScope(reopened).scopeId, 'scope-old');
    assert.equal(listAccountScopes(reopened).length, 2);
  } finally { reopened.close(); }
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
