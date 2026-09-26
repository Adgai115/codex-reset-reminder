import { accountDescription, cardState, deliveryNodeLabel, deliveryResultLabel,
  formatTime, nextReminder, syncDescription } from './view-model.mjs';

const $ = (id) => document.getElementById(id);
let snapshot = null;
let editing = null;
let snoozing = null;
let busy = false;
let loading = false;
let reloadPending = false;
let history = false;
const hasDialog = () => Boolean(document.querySelector('dialog[open]'));
const text = (parent, tag, content, className = '') => {
  const element = document.createElement(tag);
  element.textContent = content;
  element.className = className;
  parent.appendChild(element);
  return element;
};
function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}
function controls() {
  document.querySelectorAll('button, dialog input, dialog select').forEach((element) => {
    element.disabled = busy || element.dataset.unavailable === 'true'
      || (snapshot?.retrying === true && element.dataset.retry === 'true');
  });
  $('sync').disabled = busy || snapshot?.syncing === true;
  $('sync').textContent = snapshot?.syncing ? '同步中…' : '立即同步 Codex';
}
function button(parent, label, callback, unavailable = false) {
  const element = text(parent, 'button', label);
  element.dataset.unavailable = String(unavailable);
  element.addEventListener('click', callback);
  return element;
}
function renderDelivery(parent, card) {
  if (!card.deliveryResults?.length) {
    text(parent, 'span', '尚无发送记录', 'sub');
    return;
  }
  const nodes = new Map();
  for (const result of card.deliveryResults) {
    const key = `${result.expiresAt}:${result.nodeKind}:${result.nodeAt}`;
    if (!nodes.has(key)) nodes.set(key, []);
    nodes.get(key).push(result);
  }
  for (const results of nodes.values()) {
    const group = text(parent, 'div', '', 'delivery-node');
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
    if (results.some((result) => result.retryable)) {
      const first = results[0];
      const retry = button(group, '重试失败渠道', () => retryNode(first));
      retry.dataset.retry = 'true';
    }
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
  $('sync-status').textContent = syncDescription(snapshot);
  $('account-status').textContent = accountDescription(snapshot.account);
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
    text(name, 'div', card.title, 'card-name');
    const identity = text(name, 'small', `${card.source === 'manual' ? '手动' : 'Codex'} · ${card.id}`, 'sub identity');
    identity.title = card.id;
    text(name, 'div', nextReminder(card, snapshot.channels), 'sub');
    text(row, 'td', formatTime(card.expiresAt), 'time');
    const status = text(row, 'td', '');
    text(status, 'span', state.label, `badge ${state.tone}`);
    if (state.active && card.reportedUsedAt) text(status, 'div', '读取 Codex 后核验；不会直接扣减卡片。', 'sub');
    renderDelivery(text(row, 'td', ''), card);
    const actions = text(text(row, 'td', ''), 'div', '', 'actions');
    if (!state.active) { text(actions, 'span', '无需处理', 'sub'); continue; }
    const codexBlocked = card.source === 'codex' && snapshot.account?.state !== 'verified';
    const later = button(actions, '稍后提醒', () => openSnooze(card),
      !card.snoozeOptions.length || codexBlocked);
    if (!card.snoozeOptions.length) later.title = '三个固定延期时间均已超过到期时间';
    if (codexBlocked) later.title = '先重新核对 Codex 账号';
    if (card.snooze?.expiresAt === card.expiresAt) button(actions, '取消延期',
      () => action('clearSnooze', { cardId: card.id }, '已取消延期，恢复固定提醒节点'), codexBlocked);
    if (card.source === 'manual') {
      button(actions, '编辑', () => openCardDialog(card));
      button(actions, '标记已使用', () => {
        if (confirm(`将“${card.title}”标记为已使用？\n这只更新手动卡，并停止它的后续提醒。`))
          action('markManualUsed', { cardId: card.id }, '手动卡已标记为已使用');
      });
    } else if (!card.reportedUsedAt) {
      button(actions, '我已使用', () => {
        if (confirm('已在 Codex 中使用过这张卡？\n此操作只记录反馈，下一次同步会核验；不会在这里使用重置卡。'))
          action('reportCardUsed', { cardId: card.id }, '已记录反馈，等待 Codex 核验');
      }, codexBlocked);
    }
  }
  $('cards').hidden = cards.length === 0;
  $('empty').hidden = cards.length > 0;
  $('empty').textContent = history ? '还没有已使用、过期或失效的卡片。' : snapshot.latest?.outcome === 'failed'
    ? '暂无可用的本地卡片。Codex 同步失败，请重试或在提醒设置中检查连接。'
    : '暂无可用卡片。可以同步 Codex，或新增一张手动卡。';
  controls();
}
async function load(force = false) {
  if (loading || (!force && (busy || hasDialog()))) { reloadPending = true; return; }
  loading = true;
  reloadPending = false;
  try { snapshot = await window.api.core('manageSnapshot'); render(); }
  catch (error) { notice(`读取失败：${error.message}`, true); $('sync-status').textContent = '本地数据读取失败，可重试同步'; }
  finally {
    loading = false;
    if (reloadPending && !busy && !hasDialog()) queueMicrotask(() => load());
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
function openCardDialog(card = null) {
  editing = card;
  $('dialog-title').textContent = card ? '编辑手动卡' : '新增手动卡';
  $('card-title').value = card?.title ?? '';
  $('card-error').textContent = '';
  const localDate = (seconds) => {
    const date = new Date(seconds * 1000);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  $('card-expiry').value = card ? localDate(card.expiresAt) : '';
  $('card-dialog').showModal();
}
function openSnooze(card) {
  snoozing = card;
  $('snooze-title').textContent = `${card.title} · ${formatTime(card.expiresAt)} 到期`;
  $('snooze-error').textContent = '';
  $('snooze-option').replaceChildren();
  for (const choice of card.snoozeOptions) {
    const option = text($('snooze-option'), 'option', `${choice.label} · ${formatTime(choice.targetAt)}`);
    option.value = choice.option;
  }
  $('snooze-dialog').showModal();
}
for (const id of ['card', 'snooze']) {
  $(`cancel-${id}`).addEventListener('click', () => $(`${id}-dialog`).close());
  $(`${id}-dialog`).addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  $(`${id}-dialog`).addEventListener('close', () => load());
}
$('add').addEventListener('click', () => openCardDialog());
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
$('card-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const expiresAt = Math.floor(new Date($('card-expiry').value).getTime() / 1000);
  if (!$('card-title').value.trim()) { $('card-error').textContent = '请输入卡片名称'; return; }
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000) {
    $('card-error').textContent = '到期时间必须晚于现在'; return;
  }
  const result = await action(editing ? 'updateManualCard' : 'addManualCard',
    { cardId: editing?.id, title: $('card-title').value, expiresAt },
    editing ? '手动卡已更新' : '手动卡已添加', 'card-error');
  if (result) $('card-dialog').close();
});
$('snooze-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await action('scheduleSnooze', { cardId: snoozing.id, option: $('snooze-option').value },
    '已安排稍后提醒，到期时间不变', 'snooze-error');
  if (result) $('snooze-dialog').close();
});
$('sync').addEventListener('click', async () => {
  if (busy || snapshot?.syncing) return;
  busy = true; controls(); $('sync').textContent = '同步中…';
  notice('正在读取 Codex Usage，可能需要几十秒…');
  try {
    const result = await window.api.core('syncCards');
    notice(result.complete ? `同步完成：Codex 可用 ${result.availableCount} 张` : '同步详情不完整，保留上次确认的卡片，请稍后重试', !result.complete);
  } catch (error) { notice(`同步失败：${error.message}。请查看账号状态和连接设置。`, true); }
  finally { busy = false; await load(true); controls(); }
});
window.api.onStateChanged(() => load());
window.addEventListener('focus', () => load());
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
// 仅刷新本地时间和状态，不会轮询 Codex。
setInterval(() => { if (!document.hidden) load(); }, 60_000);
load();
