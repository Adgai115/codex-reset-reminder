import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeReminderItems, reminderStillActive } from './reminder-items.mjs';

test('合并按到期排序，相同卡和节点只保留一项，旧节点不能覆盖新节点', () => {
  const a = { creditId: 'a', expiresAt: 200, nodeAt: 70 };
  const b = { creditId: 'b', expiresAt: 180, nodeAt: 60 };
  const next = { ...a, nodeAt: 90 };
  assert.deepEqual(mergeReminderItems([a, b], [next, a, { creditId: 'expired', expiresAt: 100 }], 100), [b, next]);
  const changedExpiry = { ...a, expiresAt: 150 };
  assert.deepEqual(mergeReminderItems([a], [changedExpiry], 100), [changedExpiry]);
});

test('manual review keeps offline cached reminders scoped; automatic alerts still require a connected account', () => {
  const item = { creditId: 'a', accountScopeId: 'first', expiresAt: 200, nodeKind: 'fixed', nodeAt: 80 };
  const card = { id: 'a', accountScopeId: 'first', expiresAt: 200, status: 'available' };
  const snapshot = { account: { state: 'verified', scopeId: 'second' },
    accounts: [{ state: 'loginRequired', scopeId: 'first' }, { state: 'verified', scopeId: 'second' }], cards: [card] };
  assert.equal(reminderStillActive(item, snapshot, 100), false);
  assert.equal(reminderStillActive({ ...item, reviewOnly: true }, snapshot, 100), true);
  assert.equal(reminderStillActive({ ...item, reviewOnly: true, accountScopeId: 'second' }, snapshot, 100), false);
  assert.equal(reminderStillActive({ ...item, reviewOnly: true }, { ...snapshot, accounts: [] }, 100), false);
  assert.equal(reminderStillActive({ ...item, reviewOnly: true }, { ...snapshot, cards: [{ ...card, status: 'used' }] }, 100), false);
});

test('在途弹窗随账号、官方使用状态、有效期与单卡延期失效', () => {
  const item = { creditId: 'a', expiresAt: 200, nodeKind: 'fixed', nodeAt: 80 };
  const card = { id: 'a', expiresAt: 200, status: 'available' };
  const snapshot = (override = {}, state = 'verified') => ({ account: { state }, cards: [{ ...card, ...override }] });
  assert.equal(reminderStillActive(item, snapshot(), 100), true);
  for (const state of ['mismatch', 'unavailable', 'needsBinding'])
    assert.equal(reminderStillActive(item, snapshot({}, state), 100), false);
  for (const override of [{ status: 'used' }, { status: 'not_available' }, { expiresAt: 201 },
    { snooze: { expiresAt: 200, targetAt: 120 } }])
    assert.equal(reminderStillActive(item, snapshot(override), 100), false);
  assert.equal(reminderStillActive(item, snapshot(), 200), false);
  assert.equal(reminderStillActive({ ...item, nodeKind: 'snooze', nodeAt: 90 },
    snapshot({ snooze: { expiresAt: 200, targetAt: 90 } }), 100), true);
  assert.equal(reminderStillActive({ ...item, nodeKind: 'snooze', nodeAt: 90 }, snapshot(), 100), false);
});
