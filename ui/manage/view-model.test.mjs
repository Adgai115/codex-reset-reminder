import test from 'node:test';
import assert from 'node:assert/strict';
import { accountSummary, automationSummary, cardState, deliveryGroups, formatShortTime,
  nextReminder, syncDescription, syncSummary } from './view-model.mjs';

test('离线过期卡不再显示可用，已使用卡保留使用结果', () => {
  assert.equal(cardState({ status: 'available', expiresAt: 100 }, 100).active, false);
  assert.equal(cardState({ status: 'used', expiresAt: 100 }, 101).label, '已使用');
  assert.equal(cardState({ status: 'available', expiresAt: 200, reportedUsedAt: 50 }, 100).label, '等待使用核验');
  assert.equal(cardState({ status: 'available', expiresAt: 200 }, 100).label, '不足 1 小时');
});

test('紧凑时间跨年时保留年份，当前有效期的发送记录优先于旧有效期', () => {
  const now = new Date(2026, 8, 27, 9, 0).getTime() / 1000;
  assert.equal(formatShortTime(now, now), '09-27 09:00');
  assert.equal(formatShortTime(new Date(2027, 0, 3, 8, 5).getTime() / 1000, now), '2027-01-03 08:05');
  const current = { expiresAt: 100, nodeAt: 50, nodeKind: 'fixed', channel: 'desktop' };
  const recent = { ...current, nodeAt: 80 };
  const oldExpiry = { ...current, expiresAt: 200, nodeAt: 90 };
  const groups = deliveryGroups({ expiresAt: 100,
    deliveryResults: [oldExpiry, current, recent, { ...recent, channel: 'feishu' }] });
  assert.equal(groups[0].length, 2);
  assert.equal(groups[0][0], recent);
  assert.equal(groups[2][0], oldExpiry);
});

test('自动化状态不把未知账号或失败同步显示为已恢复', () => {
  assert.match(syncSummary({ account: { state: 'unavailable' } }), /暂停/);
  assert.equal(accountSummary({ state: 'verified', boundDisplay: 'n***@example.com' }), 'n***@example.com');
  assert.equal(accountSummary({ state: 'unidentified' }), '账号无法辨认');
  assert.match(automationSummary({ recovering: true, nextSyncAt: 100 }), /自动恢复连接.*下次/);
  assert.match(syncSummary({ latest: { outcome: 'failed' }, confirmed: { checkedAt: 100 } }), /已同步/);
  assert.equal(syncSummary({ latest: { outcome: 'partial' } }), '卡片详情待获取');
});

test('提醒说明使用核心的延期或补查结果，停用渠道时明确提示', () => {
  const card = { status: 'available', expiresAt: 10000, plan: { dueAt: 50, dueKind: 'snooze' } };
  assert.match(nextReminder(card, ['desktop'], 100), /延期提醒待补查/);
  assert.equal(nextReminder({ ...card, plan: {} }, [], 100), '提醒渠道已关闭');
  assert.equal(nextReminder(card, ['desktop'], 10001), '不再提醒');
});

test('同步失败保留完整核对时间，旧数据和同步中的状态可区分', () => {
  assert.match(syncDescription({ latest: { outcome: 'failed' }, confirmed: { checkedAt: 100 } }), /已有卡片保留/);
  assert.match(syncDescription({ latest: { outcome: 'complete', checkedAt: 100, availableCount: 2 } }, 86501), /超过 24 小时/);
  assert.match(syncDescription({ syncing: true }), /正在同步/);
});

test('需登录账号的缓存和暂停提醒不会显示为正在自动恢复或待发送', () => {
  const snapshot = { account: { state: 'loginRequired' },
    confirmed: { checkedAt: 100 }, latest: { outcome: 'complete', checkedAt: 100 } };
  assert.equal(syncSummary(snapshot), '缓存 · 登录后同步');
  assert.equal(automationSummary(snapshot), '登录后恢复自动同步');
  assert.match(syncDescription(snapshot), /显示此账号缓存/);
  const card = { status: 'available', expiresAt: 10000, plan: { dueAt: 50, dueKind: '1d' } };
  assert.equal(nextReminder(card, ['desktop'], 100, snapshot.account), '登录后恢复提醒');
  const paused = { state: 'verified', independent: true, remindersEnabled: false };
  assert.equal(nextReminder(card, ['desktop'], 100, paused), '此账号提醒已暂停');
  assert.equal(nextReminder(card, ['desktop'], 10001, paused), '不再提醒');
  assert.equal(accountSummary(paused), '已连接 · 提醒暂停');
  assert.match(automationSummary({ account: paused }), /自动同步.*提醒已暂停/);
});
