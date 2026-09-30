import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createScheduler } from './scheduler.mjs';

test('manual retries coalesce while in flight and keep the original node', async () => {
  const calls = [];
  const scheduler = createScheduler({ powerMonitor: new EventEmitter(), coreRequest: async (op, args) => {
    if (op === 'syncAllAccounts') return { complete: true, nextSyncAt: Math.floor(Date.now() / 1000) + 900 };
    if (op === 'planNextCheck') return { nextAt: null };
    if (op === 'checkReminders') { if (args.manualRetry) calls.push(args.manualRetry); return { due: [] }; }
    throw new Error(`unexpected ${op}`);
  } });
  try {
    scheduler.start();
    await scheduler.check('test');
    const node = { cardId: 'fixture-card', expiresAt: 2000000000, nodeKind: 'fixed', nodeAt: 1999000000 };
    const first = scheduler.retry(node);
    const duplicate = scheduler.retry(node);
    assert.equal(first, duplicate);
    await first;
    assert.deepEqual(calls, [node]);
  } finally { scheduler.stop(); }
});
