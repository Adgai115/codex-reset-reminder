import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-desktop-reset-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const { openStore, saveCodexSnapshot } = await import('../core/store.mjs');
const { resetCardFromReminder } = await import('./reset-card.mjs');
const expiresAt = Math.floor(Date.now() / 1000) + 86400;
const args = { cardId: 'card-one', expectedExpiresAt: expiresAt };
const db = openStore();
try {
  saveCodexSnapshot(db, { availableCount: 1, credits: [
    { id: args.cardId, title: '官方卡', status: 'available', expiresAt },
  ] }, Math.floor(Date.now() / 1000), 'scope-one');
} finally { db.close(); }

test('桌面确认后的用卡只使用当前账号的原卡，并复用未确认请求的幂等键', async () => {
  const keys = [];
  const options = { verifyAccount: async () => 'scope-one', newKey: () => `key-${keys.length + 1}`,
    consume: async (_id, key) => { keys.push(key); throw new Error('网络中断'); } };
  await assert.rejects(resetCardFromReminder(args, options), /网络中断/);
  await assert.rejects(resetCardFromReminder(args, options), /网络中断/);
  assert.deepEqual(keys, ['key-1', 'key-1']);
  let called = 0;
  await assert.rejects(resetCardFromReminder(args, {
    ...options, verifyAccount: async () => 'other-scope',
    consume: async () => { called++; },
  }), /卡已变化/);
  assert.equal(called, 0);
  await assert.rejects(resetCardFromReminder({ ...args, expectedExpiresAt: expiresAt + 1 }, {
    ...options, consume: async () => { called++; },
  }), /卡已变化/);
  assert.equal(called, 0);
  const result = await resetCardFromReminder(args, { ...options,
    consume: async (_id, key) => { keys.push(key); return { outcome: 'nothingToReset' }; },
  });
  assert.equal(result.outcome, 'nothingToReset');
  await resetCardFromReminder(args, { ...options,
    consume: async (_id, key) => { keys.push(key); return { outcome: 'nothingToReset' }; },
  });
  assert.deepEqual(keys, ['key-1', 'key-1', 'key-1', 'key-4']);
});

test('并发点击合并为一次正式请求', async () => {
  let calls = 0;
  const options = { verifyAccount: async () => 'scope-one',
    consume: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 20));
      return { outcome: 'nothingToReset' }; } };
  const [first, second] = await Promise.all([
    resetCardFromReminder(args, options), resetCardFromReminder(args, options),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
