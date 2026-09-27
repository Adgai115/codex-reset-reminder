import { accountDescription, accountSummary, automationSummary, cardState, deliveryGroups,
  deliveryNodeLabel, deliveryResultLabel, formatShortTime, formatTime,
  nextReminder, syncDescription, syncSummary } from './view-model.mjs';

const $ = (id) => document.getElementById(id);
let snapshot = null;
let busy = false;
let loading = false;
let reloadPending = false;
let history = false;
const expandedCards = new Set();
const interacting = () => document.activeElement?.tagName === 'SELECT';
const text = (parent, tag, content, className = '') => {
  const element = document.createElement(tag);
  element.textContent = content;
  element.className = className;
  parent.appendChild(element);
  return element;
};
function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').title = message;
  $('notice-detail').textContent = message;
  $('notice-box').hidden = !message;
  $('notice').classList.toggle('error', error);
}
function controls() {
  document.querySelectorAll('button, select').forEach((element) => {
    element.disabled = busy || element.dataset.unavailable === 'true'
      || (snapshot?.retrying === true && element.dataset.retry === 'true');
  });
  $('sync').disabled = busy || snapshot?.syncing === true;
  $('sync').textContent = snapshot?.syncing ? '同步中…' : '刷新';
}
function button(parent, label, callback, unavailable = false) {
  const element = text(parent, 'button', label);
  element.dataset.unavailable = String(unavailable);
  element.addEventListener('click', callback);
  return element;
}
function renderDelivery(parent, card) {
  const nodes = deliveryGroups(card);
  if (!nodes.length) text(parent, 'span', '尚无发送记录', 'sub');
  for (const result of nodes[0] || []) {
    const compact = text(parent, 'div', '', 'delivery-compact');
    const line = text(compact, 'div', '', 'delivery-summary');
    text(line, 'span', deliveryResultLabel(result), result.state === 'failed' ? 'error' : '');
    const time = text(line, 'span', formatShortTime(result.attemptedAt), 'time');
    time.title = `${deliveryNodeLabel(result)} · ${formatTime(result.attemptedAt)}`;
    if (result.errorText) {
      const error = text(compact, 'div', result.errorText, 'delivery-error single-line');
      error.title = result.errorText;
    }
    if (result.autoPending) text(compact, 'div', `自动补发 ${formatShortTime(result.nextRetryAt)} · 已尝试 ${result.attempts}/4`, 'sub single-line');
    else if (result.suspendedReason) {
      const reason = text(compact, 'div', result.suspendedReason, 'sub single-line');
      reason.title = result.suspendedReason;
    } else if (result.state === 'failed' && result.attempts >= 4)
      text(compact, 'div', '已达 4 次尝试上限，查看渠道设置', 'sub single-line');
  }
  const details = text(parent, 'details', '', 'delivery-details');
  details.open = expandedCards.has(card.id);
  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    if (details.open) expandedCards.add(card.id); else expandedCards.delete(card.id);
  });
  text(details, 'summary', nodes.length ? `发送详情 · ${nodes.length} 个节点` : '卡片详情');
  text(details, 'div', card.title, 'delivery-line');
  text(details, 'div', `编号：${card.id}`, 'delivery-line');
  text(details, 'div', `到期：${formatTime(card.expiresAt)}`, 'delivery-line');
  for (const results of nodes) {
    const group = text(details, 'div', '', 'delivery-node');
    text(group, 'div', deliveryNodeLabel(results[0]), 'delivery-title');
    for (const result of results) {
      const line = text(group, 'div', deliveryResultLabel(result),
        `delivery-line ${result.state === 'failed' ? 'failed' : ''}`);
      text(line, 'span', `${result.state === 'sent' ? '发送' : '尝试'}：${formatTime(result.attemptedAt)}`, 'sub');
      if (result.errorText) text(line, 'span', result.errorText, 'sub');
      if (result.autoPending) text(line, 'span', `第 ${result.attempts}/4 次尝试 · 下次补发 ${formatTime(result.nextRetryAt)}`, 'sub');
      else if (result.suspendedReason) text(line, 'span', result.suspendedReason, 'sub');
      else if (result.state === 'failed') text(line, 'span', result.attempts >= 4
        ? '自动补发已达上限；检查渠道设置后等待下一提醒节点。'
        : '自动补发已停止；可检查渠道设置并手动重试。', 'sub');
      if (result.state === 'failed') button(line, '检查渠道设置',
        () => window.api.openSettings().catch((error) => notice(error.message, true)));
    }
  }
  for (const results of nodes.filter((rows) => rows.some((result) => result.retryable))) {
    const retry = button(parent, '重试失败渠道', () => retryNode(results[0]));
    retry.dataset.retry = 'true';
    retry.className = 'retry-button';
  }
}

async function retryNode(result) {
  if (busy || snapshot?.retrying) return;
  busy = true; controls();
  notice('正在补发此节点的失败渠道，请稍候…');
  try {
    const response = await window.api.core('retryFailedChannels', {
      cardId: result.cardId, expiresAt: result.expiresAt,
      nodeKind: result.nodeKind, nodeAt: result.nodeAt,
    });
    const rows = response.due || [];
    const sent = rows.flatMap((row) => [row.desktop, row.feishu, row.wechat])
      .filter((state) => state === 'sent' || state === 'shown').length;
    const failed = rows.flatMap((row) => [row.desktop, row.feishu, row.wechat])
      .filter((state) => state?.startsWith('failed:')).length;
    notice(sent || failed ? `补发完成：成功 ${sent} 个渠道，失败 ${failed} 个渠道。`
      : '当前节点没有可补发的失败渠道；请查看发送状态和账号提示。', failed > 0);
  } catch (error) { notice(`补发失败：${error.message}`, true); }
  finally { busy = false; await load(true); controls(); }
}
function render() {
  if (!snapshot) return;
  $('sync-status').textContent = syncSummary(snapshot);
  $('sync-status').title = syncDescription(snapshot);
  $('automation-status').textContent = automationSummary(snapshot);
  $('account-status').textContent = accountSummary(snapshot.account);
  $('account-detail').textContent = accountDescription(snapshot.account);
  $('account-status').classList.toggle('warning', snapshot.account?.state !== 'verified');
  $('bind-account').hidden = snapshot.account?.state !== 'needsBinding';
  $('channel-status').textContent = snapshot.channels.length
    ? `提醒：${snapshot.channels.map((name) => ({ desktop: '桌面', feishu: '飞书' })[name] || name).join(' + ')}`
    : '所有提醒渠道已关闭，可在设置中开启';
  const active = snapshot.cards.filter((card) => cardState(card).active);
  $('active-filter').textContent = `可用卡 ${active.length}`;
  $('history-filter').textContent = `历史卡 ${snapshot.cards.length - active.length}`;
  $('active-filter').setAttribute('aria-pressed', String(!history));
  $('history-filter').setAttribute('aria-pressed', String(history));
  const cards = snapshot.cards.filter((card) => cardState(card).active !== history);
  const tbody = document.querySelector('#cards tbody');
  tbody.replaceChildren();
  for (const card of cards) {
    const state = cardState(card);
    const row = text(tbody, 'tr', '');
    const name = text(row, 'td', '');
    text(name, 'div', card.title, 'card-name single-line').title = card.title;
    const identity = text(name, 'small', `Codex · …${card.id.slice(-12)}`, 'sub single-line');
    identity.title = card.id;
    text(name, 'div', nextReminder(card, snapshot.channels), 'sub single-line').title = nextReminder(card, snapshot.channels);
    text(row, 'td', formatShortTime(card.expiresAt), 'time').title = formatTime(card.expiresAt);
    const status = text(row, 'td', '');
    const badge = text(status, 'span', state.label, `badge ${state.tone}`);
    if (state.active && card.reportedUsedAt) badge.title = '后台自动读取 Codex 核验；不会直接扣减卡片。';
    renderDelivery(text(row, 'td', ''), card);
    const actions = text(text(row, 'td', ''), 'div', '', 'actions');
    if (!state.active) { text(actions, 'span', '无需处理', 'sub'); continue; }
    const codexBlocked = snapshot.account?.state !== 'verified';
    const hasSnooze = card.snooze?.expiresAt === card.expiresAt;
    const later = text(actions, 'select', '');
    later.setAttribute('aria-label', `${card.title} · 稍后提醒`);
    later.title = '选择后立即生效，不改变官方到期时间';
    later.dataset.unavailable = String(codexBlocked || (!card.snoozeOptions.length && !hasSnooze));
    const placeholder = text(later, 'option', hasSnooze ? '已延期' : '稍后提醒');
    placeholder.value = ''; placeholder.disabled = true; placeholder.selected = true;
    for (const choice of card.snoozeOptions) text(later, 'option', `${choice.label} · ${formatShortTime(choice.targetAt)}`).value = choice.option;
    if (hasSnooze) text(later, 'option', '取消延期').value = 'clear';
    if (!card.snoozeOptions.length && !hasSnooze) later.title = '可选延期时间均已超过到期时间';
    if (codexBlocked) later.title = '账号核实后自动恢复此操作';
    later.addEventListener('change', () => {
      const option = later.value;
      later.value = ''; later.blur();
      action(option === 'clear' ? 'clearSnooze' : 'scheduleSnooze', { cardId: card.id, option },
        option === 'clear' ? '已取消延期，恢复固定提醒节点' : '已安排稍后提醒，可在“已延期”中取消');
    });
    if (!card.reportedUsedAt) {
      const more = text(actions, 'select', '', 'more-actions');
      more.setAttribute('aria-label', `${card.title} · 更多操作`);
      more.dataset.unavailable = String(codexBlocked);
      const option = text(more, 'option', '更多');
      option.value = ''; option.disabled = true; option.selected = true;
      text(more, 'option', '我已在 Codex 使用').value = 'report';
      more.addEventListener('change', () => {
        more.value = ''; more.blur();
        if (confirm('已在 Codex 中使用过这张卡？\n此操作只记录反馈，下一次同步会核验；不会在这里使用重置卡。'))
          action('reportCardUsed', { cardId: card.id }, '已记录反馈，等待 Codex 核验');
      });
    }
  }
  $('cards').hidden = cards.length === 0;
  $('empty').hidden = cards.length > 0;
  $('empty').textContent = history ? '还没有已使用、过期或失效的卡片。' : snapshot.latest?.outcome === 'failed'
    ? '暂无可用的本地卡片。正在自动重试连接；可在提醒设置中查看诊断。'
    : '暂无可用卡片。官方发放新卡后，自动同步会更新这里。';
  controls();
}
async function load(force = false) {
  if (loading || (!force && (busy || interacting()))) { reloadPending = true; return; }
  loading = true;
  reloadPending = false;
  try { snapshot = await window.api.core('manageSnapshot'); render(); }
  catch (error) { notice(`读取失败：${error.message}`, true); $('sync-status').textContent = '本地数据读取失败，可重试同步'; }
  finally {
    loading = false;
    if (reloadPending && !busy && !interacting()) queueMicrotask(() => load());
  }
}
async function action(op, args, success, errorId) {
  if (busy) return null;
  busy = true; controls();
  if (errorId) $(errorId).textContent = '正在保存…';
  try {
    const result = await window.api.core(op, args);
    await load(true);
    notice(success);
    return result;
  } catch (error) {
    if (errorId) $(errorId).textContent = error.message;
    else notice(error.message, true);
    return null;
  } finally {
    busy = false; controls();
    if (reloadPending) load();
  }
}
$('active-filter').addEventListener('click', () => { history = false; render(); });
$('history-filter').addEventListener('click', () => { history = true; render(); });
$('settings').addEventListener('click', () => window.api.openSettings().catch((error) => notice(error.message, true)));
$('check-account').addEventListener('click', async () => {
  if (busy) return;
  busy = true; controls(); notice('正在重新读取 Codex 账号身份…');
  try {
    const result = await window.api.core('checkAccount');
    notice(accountDescription(result), result.state !== 'verified');
  } catch (error) { notice(`账号核对失败：${error.message}`, true); }
  finally { busy = false; await load(true); controls(); }
});
$('bind-account').addEventListener('click', async () => {
  if (busy || snapshot?.account?.state !== 'needsBinding') return;
  const candidate = snapshot.account;
  if (!confirm(`确认 ${candidate.currentDisplay} 是这些现有 Codex 卡原来的 CLI 账号？\n绑定只保护本地缓存，不会使用重置卡。账号不确定时请先切回原账号。`)) return;
  busy = true; controls(); notice('正在核对账号并绑定现有缓存…');
  try {
    const result = await window.api.core('confirmLegacyBinding', {
      expectedCandidateToken: candidate.candidateToken });
    notice(accountDescription(result), result.state !== 'verified');
  } catch (error) { notice(`绑定失败：${error.message}`, true); }
  finally { busy = false; await load(true); controls(); }
});
$('sync').addEventListener('click', async () => {
  if (busy || snapshot?.syncing) return;
  busy = true; controls(); $('sync').textContent = '同步中…';
  notice('正在读取 Codex Usage，可能需要几十秒…');
  try {
    const result = await window.api.core('syncCards');
    notice(result.complete ? `同步完成：Codex 可用 ${result.availableCount} 张` : '同步详情不完整，保留已确认的卡片，将自动重试', !result.complete);
  } catch (error) { notice(`同步失败，将自动重试。${error.message}`, true); }
  finally { busy = false; await load(true); controls(); }
});
window.api.onStateChanged(() => load());
window.addEventListener('focus', () => load());
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
// 仅刷新本地时间和状态，不会轮询 Codex。
setInterval(() => { if (!document.hidden) load(); }, 60_000);
load();
