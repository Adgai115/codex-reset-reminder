import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feishuReminderIdempotencyKey } from './feishu.mjs';

test('Feishu retries reuse a node key and new nodes get another key', () => {
  const card = { id: 'fake-credit', expiresAt: 2_000_000_000 };
  const first = feishuReminderIdempotencyKey(card, 7);
  assert.equal(feishuReminderIdempotencyKey(card, 7), first);
  assert.notEqual(feishuReminderIdempotencyKey(card, 3), first);
  const snooze = feishuReminderIdempotencyKey(card, 7, 1_999_999_000);
  assert.equal(feishuReminderIdempotencyKey(card, 6, 1_999_999_000), snooze);
  assert.notEqual(snooze, first);
});
