import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountDisplayLabels } from './account-labels.mjs';

test('unique account labels stay short; duplicate masked emails and nicknames remain distinguishable', () => {
  const scopes = [
    { scopeId: 'alpha-123456', displayName: 'a***@example.invalid' },
    { scopeId: 'beta-123456', displayName: 'a***@example.invalid' },
    { scopeId: 'gamma-654321', nickname: '工作号', displayName: 'g***@example.invalid' },
    { scopeId: 'delta-111111', nickname: '工作号', displayName: 'd***@example.invalid' },
    { scopeId: 'only-333333', displayName: 'o***@example.invalid' },
  ];
  const labels = accountDisplayLabels(scopes);
  assert.equal(labels.get('only-333333'), 'o***@example.invalid');
  assert.notEqual(labels.get('alpha-123456'), labels.get('beta-123456'), 'short tail collisions expand');
  assert.notEqual(labels.get('gamma-654321'), labels.get('delta-111111'));
  assert.equal(new Set(labels.values()).size, scopes.length);
  assert.deepEqual(accountDisplayLabels([...scopes].reverse()), labels, 'order does not change account labels');
  assert.equal(scopes[2].nickname, '工作号', 'editable nickname is preserved');
});
