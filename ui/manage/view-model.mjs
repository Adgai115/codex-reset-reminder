// 这里只整理显示状态，提醒时间始终来自核心的 planCardNextCheck。
export const formatTime = (seconds) => seconds ? new Date(seconds * 1000).toLocaleString('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}) : '尚无记录';

export function cardState(card, now = Date.now() / 1000) {
  if (card.status === 'used') return { active: false, label: '已使用', tone: 'muted' };
  if (card.expiresAt <= now) return { active: false, label: '已过期', tone: 'muted' };
  if (card.status !== 'available') return { active: false, label: '已失效', tone: 'muted' };
  if (card.reportedUsedAt) return { active: true, label: '等待使用核验', tone: 'pending' };
  const hours = Math.ceil((card.expiresAt - now) / 3600);
  const remaining = hours < 24 ? (hours <= 1 ? '不足 1 小时' : `剩余 ${hours} 小时`) : `剩余 ${Math.ceil(hours / 24)} 天`;
  return { active: true, label: remaining, tone: hours <= 72 ? 'urgent' : 'normal' };
}

const kindLabel = (kind) => ({ '7d': '提前 7 天', '3d': '提前 3 天', '1d': '提前 1 天',
  snooze: '延期提醒', verify: '使用核验' })[kind] || '提醒';

export function nextReminder(card, channels, now = Date.now() / 1000) {
  if (!cardState(card, now).active) return '不再提醒';
  const plan = card.plan || {};
  if (plan.dueAt) return `${kindLabel(plan.dueKind)}待补查`;
  if (plan.nextAt) return `${kindLabel(plan.nextKind)} · ${formatTime(plan.nextAt)}`;
  if (!channels.length) return '提醒渠道已关闭';
  return '本轮提醒已完成';
}

export function syncDescription(snapshot, now = Date.now() / 1000) {
  if (snapshot.syncing) return '正在同步 Codex Usage，可继续查看本地卡片…';
  const { latest, confirmed } = snapshot;
  if (!latest) return '尚未同步 Codex；手动卡可独立提醒。';
  const checked = confirmed ? `上次完整核对 ${formatTime(confirmed.checkedAt)}` : '尚无完整核对记录';
  if (latest.outcome !== 'complete') return `${latest.outcome === 'failed' ? '同步失败' : '同步详情不完整'} · ${checked}。已保存的卡片继续提醒。`;
  const stale = now - latest.checkedAt > 86400 ? ' · 超过 24 小时未核对，建议立即同步' : '';
  return `上次核对 ${formatTime(latest.checkedAt)} · Codex 可用 ${latest.availableCount} 张${stale}`;
}
