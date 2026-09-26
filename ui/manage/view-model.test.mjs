import test from 'node:test';
import assert from 'node:assert/strict';
import { cardState, nextReminder, syncDescription } from './view-model.mjs';

test('离线过期卡不再显示可用，已使用卡保留使用结果', () => {
  assert.equal(cardState({ status: 'available', expiresAt: 100 }, 100).active, false);
  assert.equal(cardState({ status: 'used', expiresAt: 100 }, 101).label, '已使用');
  assert.equal(cardState({ status: 'available', expiresAt: 200, reportedUsedAt: 50 }, 100).label, '等待使用核验');
  assert.equal(cardState({ status: 'available', expiresAt: 200 }, 100).label, '不足 1 小时');
});

test('提醒说明使用核心的延期或补查结果，停用渠道时明确提示', () => {
  const card = { status: 'available', expiresAt: 10000, plan: { dueAt: 50, dueKind: 'snooze' } };
  assert.match(nextReminder(card, ['desktop'], 100), /延期提醒待补查/);
  assert.equal(nextReminder({ ...card, plan: {} }, [], 100), '提醒渠道已关闭');
  assert.equal(nextReminder(card, ['desktop'], 10001), '不再提醒');
});

test('同步失败保留完整核对时间，旧数据和同步中的状态可区分', () => {
  assert.match(syncDescription({ latest: { outcome: 'failed' }, confirmed: { checkedAt: 100 } }), /已保存的卡片继续提醒/);
  assert.match(syncDescription({ latest: { outcome: 'complete', checkedAt: 100, availableCount: 2 } }, 86501), /超过 24 小时/);
  assert.match(syncDescription({ syncing: true }), /正在同步/);
});
