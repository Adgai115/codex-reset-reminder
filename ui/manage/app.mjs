import { accountDescription, accountSummary, automationSummary, cardShortId, cardState, deliveryGroups,
  deliveryNodeLabel, deliveryResultLabel, formatShortTime, formatTime,
  nextReminder, syncDescription, syncSummary } from './view-model.mjs';

const $ = (id) => document.getElementById(id);
let snapshot = null;
let busy = false;
let loading = false;
let reloadPending = false;
let filter = 'active';
let noticeTimer;
let lastFocusCheckAt = Date.now();
const expandedCards = new Set();
const interacting = () => document.activeElement?.tagName === 'SELECT';
const text = (parent, tag, content, className = '') => {
  const element = document.createElement(tag);
  element.textContent = content;
  element.className = className;
  parent.appendChild(element);
  return element;
};
function notice(message, error = false, detail = message) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').title = detail;
  $('notice-detail').textContent = detail;
  $('notice-box').hidden = !message;
  $('notice').classList.toggle('error', error);
  if (message) {
    const hide = () => {
      if (busy) { noticeTimer = setTimeout(hide, 1000); return; }
      $('notice-box').hidden = true;
    };
    noticeTimer = setTimeout(hide, error ? 12000 : 6000);
  }
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
  if (card.pendingReminder) {
    const pending = button(parent, '查看提醒', async () => {
      if (busy) return;
      busy = true; controls();
      try {
        const count = await window.api.openPendingReminders(card.id);
        if (!count) notice('暂无已提醒卡片');
      } catch (error) { notice('暂时无法查看提醒', true, error.message); }
      finally { busy = false; await load(true); controls(); }
    }, snapshot.account?.state !== 'verified');
    pending.className = 'pending-reminder';
    pending.title = '重新查看提醒';
  }
  const nodes = deliveryGroups(card);
  if (!nodes.length) text(parent, 'span', cardState(card).active && snapshot.channels.length
    ? nextReminder(card, snapshot.channels) : '—', 'sub single-line');
  for (const result of nodes[0] || []) {
    const compact = text(parent, 'div', '', 'delivery-compact');
    const line = text(compact, 'div', '', 'delivery-summary');
    text(line, 'span', deliveryResultLabel(result), result.state === 'failed' ? 'error' : '');
    const time = text(line, 'span', formatShortTime(result.attemptedAt), 'time');
    time.title = `${deliveryNodeLabel(result)} · ${formatTime(result.attemptedAt)}`;
    line.title = result.errorText || result.suspendedReason || '';
    if (result.autoPending) text(compact, 'div', `重试 ${formatShortTime(result.nextRetryAt)}`, 'sub single-line');
  }
  const details = text(parent, 'details', '', 'delivery-details');
  details.open = expandedCards.has(card.id);
  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    if (details.open) expandedCards.add(card.id); else expandedCards.delete(card.id);
  });
  text(details, 'summary', '详情').title = '卡片信息与发送记录';
  text(details, 'div', card.title, 'delivery-line');
  text(details, 'div', `编号：${card.id}`, 'delivery-line');
  text(details, 'div', `到期：${formatTime(card.expiresAt)}`, 'delivery-line');
  text(details, 'div', nextReminder(card, snapshot.channels), 'delivery-line');
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
  notice('正在补发…');
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
    notice(sent || failed ? `补发完成 · 成功 ${sent} / 失败 ${failed}`
      : '暂无可重试渠道', failed > 0);
  } catch (error) { notice('补发失败', true, error.message); }
  finally { busy = false; await load(true); controls(); }
}
function render() {
  if (!snapshot) return;
  $('sync-status').textContent = syncSummary(snapshot);
  $('sync-status').title = syncDescription(snapshot);
  $('sync-detail').textContent = syncDescription(snapshot);
  $('automation-status').textContent = automationSummary(snapshot);
  $('account-status').textContent = accountSummary(snapshot.account);
  $('account-info').dataset.state = snapshot.account?.state || 'checking';
  $('account-detail').textContent = accountDescription(snapshot.account);
  $('account-status').classList.toggle('warning', snapshot.account?.state !== 'verified');
  $('bind-account').hidden = snapshot.account?.state !== 'needsBinding';
  $('channel-status').hidden = snapshot.channels.length > 0;
  const active = snapshot.cards.filter((card) => cardState(card).active);
  const pending = active.filter((card) => card.pendingReminder);
  $('active-filter').textContent = `可用卡 ${active.length}`;
  $('history-filter').textContent = `已结束 ${snapshot.cards.length - active.length}`;
  $('pending-filter').textContent = `已提醒 ${pending.length}`;
  $('pending-filter').hidden = !pending.length && filter !== 'pending';
  for (const name of ['active', 'history', 'pending'])
    $(`${name}-filter`).setAttribute('aria-pressed', String(filter === name));
  const cards = filter === 'pending' ? pending
    : snapshot.cards.filter((card) => cardState(card).active === (filter === 'active'));
  const tbody = document.querySelector('#cards tbody');
  tbody.replaceChildren();
  for (const card of cards) {
    const state = cardState(card);
    const row = text(tbody, 'tr', '');
    const name = text(row, 'td', '');
    const label = text(name, 'div', '', 'card-label');
    text(label, 'span', card.title, 'card-name single-line').title = card.title;
    text(label, 'span', cardShortId(card.id), 'card-key').title = card.id;
    text(row, 'td', formatShortTime(card.expiresAt), 'time').title = formatTime(card.expiresAt);
    const status = text(row, 'td', '');
    const badge = text(status, 'span', state.label, `badge ${state.tone}`);
    if (state.active && card.reportedUsedAt) badge.title = '后台自动读取 Codex 核验；不会直接扣减卡片。';
    renderDelivery(text(row, 'td', ''), card);
    const actions = text(text(row, 'td', ''), 'div', '', 'actions');
    if (!state.active) { text(actions, 'span', '—', 'sub'); continue; }
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
        option === 'clear' ? '已取消延期' : '已延期');
    });
  }
  $('cards').hidden = cards.length === 0;
  $('empty').hidden = cards.length > 0;
  $('empty').textContent = snapshot.account?.state === 'mismatch'
    ? '当前账号未绑定，原账号卡已隐藏' : filter === 'pending' ? '暂无已提醒卡片'
    : filter === 'history' ? '暂无已结束卡片' : '暂无可用卡片';
  controls();
}
async function load(force = false) {
  if (loading || (!force && (busy || interacting()))) { reloadPending = true; return; }
  loading = true;
  reloadPending = false;
  try { snapshot = await window.api.core('manageSnapshot'); render(); }
  catch (error) { notice('读取失败', true, error.message); $('sync-status').textContent = '读取失败'; }
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
    else notice('操作失败', true, error.message);
    return null;
  } finally {
    busy = false; controls();
    if (reloadPending) load();
  }
}
for (const name of ['active', 'history', 'pending'])
  $(`${name}-filter`).addEventListener('click', () => { filter = name; render(); });
$('settings').addEventListener('click', () => window.api.openSettings().catch((error) => notice(error.message, true)));
$('channel-status').addEventListener('click', () => $('settings').click());
$('check-account').addEventListener('click', async () => {
  if (busy) return;
  busy = true; controls(); notice('核对账号…');
  try {
    const result = await window.api.core('checkAccount');
    const sync = result.syncResult;
    notice(result.state !== 'verified' ? accountSummary(result)
      : result.syncError ? '账号已核实 · 卡片同步暂不可用'
        : sync?.complete ? `账号与 ${sync.availableCount} 张卡片已核对`
          : `账号已核实 · 官方仅提供 ${sync?.availableCount ?? 0} 张卡的部分详情`,
    result.state !== 'verified' || Boolean(result.syncError) || Boolean(sync && !sync.complete),
    result.syncError || sync?.detailMessage || accountDescription(result));
  } catch (error) { notice('账号核对失败', true, error.message); }
  finally { busy = false; await load(true); controls(); }
});
$('bind-account').addEventListener('click', async () => {
  if (busy || snapshot?.account?.state !== 'needsBinding') return;
  const candidate = snapshot.account;
  if (!confirm(`确认 ${candidate.currentDisplay} 是现有卡片的原账号？\n绑定后将同步并提醒这些卡片。`)) return;
  busy = true; controls(); notice('确认账号中…');
  try {
    const result = await window.api.core('confirmLegacyBinding', {
      expectedCandidateToken: candidate.candidateToken });
    notice(result.state !== 'verified' ? accountSummary(result)
      : result.syncResult?.complete ? '账号与卡片已核对' : '账号已确认 · 卡片详情待获取',
    result.state !== 'verified' || !result.syncResult?.complete,
    result.syncError || result.syncResult?.detailMessage || accountDescription(result));
  } catch (error) { notice('绑定失败', true, error.message); }
  finally { busy = false; await load(true); controls(); }
});
$('sync').addEventListener('click', async () => {
  if (busy || snapshot?.syncing) return;
  busy = true; controls(); $('sync').textContent = '同步中…';
  notice('同步中…');
  try {
    const result = await window.api.core('syncCards');
    notice(result.complete ? `已核对 · ${result.availableCount} 张可用`
      : `已连接 · ${result.availableCount} 张可用，详情待获取`, !result.complete,
    result.detailMessage || '逐卡到期详情已核对');
  } catch (error) { notice('刷新暂不可用 · 自动重试', true, error.message); }
  finally { busy = false; await load(true); controls(); }
});
window.api.onStateChanged(() => load());
window.addEventListener('focus', () => {
  load();
  if (busy || Date.now() - lastFocusCheckAt < 30_000) return;
  lastFocusCheckAt = Date.now();
  window.api.core('checkAccount').then(() => load(true))
    .catch((error) => notice('账号核对失败', true, error.message));
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
// 仅刷新本地时间和状态，不会轮询 Codex。
setInterval(() => { if (!document.hidden) load(); }, 60_000);
load();
