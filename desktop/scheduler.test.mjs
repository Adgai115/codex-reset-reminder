import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createScheduler } from './scheduler.mjs';

test('usage verification syncs each owning account; one failed account does not skip another', async () => {
  const calls = [];
  const scheduler = createScheduler({ powerMonitor: new EventEmitter(), coreRequest: async (op, args) => {
    if (op === 'syncAllAccounts') return { complete: true, nextSyncAt: Math.floor(Date.now() / 1000) + 900 };
    if (op === 'planNextCheck') return { nextAt: null };
    if (op === 'dueUsageVerifications') return [
      { id: 'first-card', accountScopeId: 'first' }, { id: 'another-first-card', accountScopeId: 'first' },
      { id: 'second-card', accountScopeId: 'second' },
    ];
    if (op === 'syncCards') { calls.push(args.scopeId); if (args.scopeId === 'first') throw new Error('模拟失败'); return {}; }
    if (op === 'preflightSync') return {};
    if (op === 'runReminders') return { due: [] };
    throw new Error(`unexpected ${op}`);
  } });
  try {
    scheduler.start();
    await scheduler.check('test');
    assert.deepEqual(calls, ['first', 'second']);
  } finally { scheduler.stop(); }
});
