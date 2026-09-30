// 这里只整理显示状态，提醒时间始终来自核心的 planCardNextCheck。
export const formatTime = (seconds) => seconds ? new Date(seconds * 1000).toLocaleString('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}) : '尚无记录';

export function formatShortTime(seconds, now = Date.now() / 1000) {
  if (!seconds) return '尚无记录';
  const date = new Date(seconds * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  const year = date.getFullYear() === new Date(now * 1000).getFullYear() ? '' : `${date.getFullYear()}-`;
  return `${year}${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function deliveryGroups(card) {
  const nodes = new Map();
  for (const result of card.deliveryResults || []) {
    const key = `${result.expiresAt}:${result.nodeKind}:${result.nodeAt}`;
    if (!nodes.has(key)) nodes.set(key, []);
    nodes.get(key).push(result);
  }
  return [...nodes.values()].sort((a, b) => Number(b[0].expiresAt === card.expiresAt)
    - Number(a[0].expiresAt === card.expiresAt) || b[0].nodeAt - a[0].nodeAt);
}

export function syncSummary(snapshot) {
  if (snapshot.syncing) return '同步中…';
  if (snapshot.account?.state === 'loginRequired') return '缓存 · 登录后同步';
  if (['mismatch', 'needsBinding', 'unavailable', 'unidentified'].includes(snapshot.account?.state))
    return '提醒已暂停';
  if (!snapshot.latest) return '等待同步';
  const stale = Date.now() / 1000 - snapshot.confirmed?.checkedAt > 86400 ? ' · 已超过 24 小时' : '';
  const checked = snapshot.confirmed ? `已同步 ${formatShortTime(snapshot.confirmed.checkedAt)}` : '尚未同步';
  if (snapshot.confirmed) return `${checked}${stale}`;
  return snapshot.latest.outcome === 'partial' ? '卡片详情待获取' : '连接待恢复';
}

export const cardShortId = (id) => `#${String(id || '').slice(-6)}`;

export function automationSummary(snapshot) {
  if (snapshot.account?.state === 'loginRequired') return '登录后恢复自动同步';
  if (snapshot.syncing) return '自动同步中 · 失败渠道按计划补发';
  const next = snapshot.nextSyncAt ? ` · 下次 ${formatShortTime(snapshot.nextSyncAt)}` : '';
  const paused = snapshot.account?.remindersEnabled === false ? ' · 此账号提醒已暂停' : '';
  return `${snapshot.recovering ? '正在自动恢复连接' : '每 15 分钟自动同步'}${next}${paused}`;
}

export function accountSummary(account) {
  if (account?.state === 'verified') return account.independent === undefined ? account.boundDisplay
    : account.remindersEnabled === false ? '已连接 · 提醒暂停' : '已连接';
  if (account?.state === 'needsBinding') return '待确认账号';
  if (account?.state === 'unidentified') return '账号无法辨认';
  if (account?.state === 'unavailable') return '账号暂不可用';
  if (account?.state === 'loginRequired' || account?.state === 'mismatch') return '此账号需要登录';
  return '核对账号…';
}

const channelLabels = { desktop: '桌面', feishu: '飞书', wechat: '公众号' };

export function deliveryNodeLabel(result) {
  return result.nodeKind === 'snooze'
    ? `延期提醒 · ${formatTime(result.nodeAt)}`
    : `提前 ${result.thresholdDays} 天 · ${formatTime(result.nodeAt)}`;
}

export function deliveryResultLabel(result) {
  const channel = channelLabels[result.channel] || '提醒';
  if (result.state === 'sent') return result.channel === 'desktop' ? '桌面已弹出' : `${channel}已发送`;
  if (result.state === 'sending') return `${channel}发送结果待核实`;
  if (result.autoPending) return `${channel}等待重试`;
  return `${channel}发送失败`;
}

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
  'retry-7d': '7 天提醒补发', 'retry-3d': '3 天提醒补发',
  'retry-1d': '1 天提醒补发', 'retry-snooze': '延期提醒补发',
  snooze: '延期提醒', verify: '使用核验' })[kind] || '提醒';

export function nextReminder(card, channels, now = Date.now() / 1000, account) {
  if (!cardState(card, now).active) return '不再提醒';
  if (account?.remindersEnabled === false) return '此账号提醒已暂停';
  if (account?.state === 'loginRequired') return '登录后恢复提醒';
  const plan = card.plan || {};
  if (plan.dueAt) return `${kindLabel(plan.dueKind)}待补查`;
  if (plan.nextAt) return `${kindLabel(plan.nextKind)} · ${formatShortTime(plan.nextAt)}`;
  if (!channels.length) return '提醒渠道已关闭';
  if (card.deliveryResults?.some((result) => result.expiresAt === card.expiresAt
    && result.state === 'failed' && !result.nextRetryAt)) return '部分渠道发送失败，已达补发上限';
  return '本轮提醒已完成';
}

export function syncDescription(snapshot, now = Date.now() / 1000) {
  if (snapshot.syncing) return '正在同步 Codex Usage，可继续查看本地卡片…';
  if (snapshot.account?.state === 'needsBinding') return '现有 Codex 卡等待绑定原账号；绑定前暂停同步和提醒。';
  if (snapshot.account?.state === 'loginRequired') return '显示此账号缓存；在“账号管理”中登录后自动同步，卡片与记录保留。';
  if (['unavailable', 'unidentified'].includes(snapshot.account?.state))
    return '暂时无法核实 Codex 账号；卡片同步和提醒已暂停，后台将自动重新核对。';
  const { latest, confirmed } = snapshot;
  if (!latest) return '尚未同步 Codex；应用会自动读取官方重置卡。';
  const checked = confirmed ? `上次完整核对 ${formatTime(confirmed.checkedAt)}` : '尚无完整核对记录';
  if (latest.outcome !== 'complete') return `${latest.message || (latest.outcome === 'failed' ? '同步暂不可用' : '逐卡到期详情未齐全')} · ${checked}。已有卡片保留，稍后自动重试。`;
  const stale = now - latest.checkedAt > 86400 ? ' · 超过 24 小时未核对，建议立即同步' : '';
  return `上次核对 ${formatTime(latest.checkedAt)} · Codex 可用 ${latest.availableCount} 张${stale}`;
}

export function accountDescription(account) {
  if (account?.state === 'loginRequired' || account?.state === 'mismatch') return '在“账号管理”中登录此账号即可恢复后台同步和提醒。卡片与记录仍可查看。';
  if (!account || account.state === 'checking') return 'Codex 账号待核对，Codex 卡操作暂不可用。';
  if (account.state === 'verified') return `当前账号 ${account.boundDisplay} · 最近核对 ${formatTime(account.verifiedAt)}`;
  if (account.state === 'needsBinding') return `发现现有 Codex 缓存。当前 CLI：${account.currentDisplay}。请确认这是原账号后绑定。`;
  if (account.state === 'unidentified') return 'Codex 未提供可辨认的账号身份；请检查 CLI 登录方式并重新核对。';
  return `暂时无法读取 Codex 账号身份。${account.boundDisplay ? `缓存绑定 ${account.boundDisplay}。` : ''}后台将自动重试，连接恢复后自动核对。`;
}
