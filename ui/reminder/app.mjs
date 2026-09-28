const $ = (id) => document.getElementById(id);
let payload = null;
let deferred = null;
let busy = false;
const selecting = () => document.activeElement?.tagName === 'SELECT';
const text = (parent, tag, content, className = '') => {
  const element = document.createElement(tag);
  element.textContent = content; element.className = className; parent.appendChild(element);
  return element;
};

function controls() {
  document.querySelectorAll('button, select').forEach((element) => {
    element.disabled = busy || element.dataset.unavailable === 'true';
  });
}

function render(next) {
  payload = next;
  const cards = payload.cards;
  const single = cards.length === 1;
  const scrollTop = document.querySelector('main').scrollTop;
  document.body.className = single ? 'single' : 'multi';
  $('heading').textContent = payload.simulated ? 'Codex 测试提醒' : 'Codex 重置卡';
  $('total').hidden = single;
  $('total').textContent = `${cards.length} 张待处理`;
  $('items').replaceChildren(); $('single-option').replaceChildren(); $('identifiers').replaceChildren();
  for (const card of cards) {
    const row = text($('items'), 'article', '', 'reminder-item');
    row.dataset.cardId = card.creditId;
    const hours = Math.ceil((card.expiresAt * 1000 - Date.now()) / 3600000);
    const remaining = text(row, 'div', hours <= 0 ? '已到期' : hours < 24
      ? `不足 ${Math.max(1, hours)} 小时` : `${Math.ceil(hours / 24)} 天后到期`, 'remaining');
    const name = text(row, 'div', card.cardName, 'name');
    name.title = `${card.cardName}\n${card.creditId}`;
    const expiry = text(row, 'div', `到期 ${card.expiresLocal}`, 'expiry');
    if (single) { remaining.id = 'days'; name.id = 'name'; expiry.id = 'expiry'; }
    const select = text(single ? $('single-option') : text(row, 'div', '', 'item-actions'), 'select', '');
    if (single) select.id = 'option';
    select.setAttribute('aria-label', `${card.cardName} · 稍后提醒`);
    select.dataset.cardId = card.creditId;
    const placeholder = text(select, 'option', '稍后提醒');
    placeholder.value = ''; placeholder.disabled = true; placeholder.selected = true;
    for (const choice of card.snoozeOptions || []) text(select, 'option', choice.label).value = choice.option;
    select.dataset.unavailable = String(select.options.length < 2);
    if (select.options.length < 2) placeholder.textContent = '无法延期';
    select.title = select.options.length < 2 ? '可选时间均已超过到期时间' : '选择后立即生效';
    select.addEventListener('change', () => {
      const option = select.value;
      select.value = ''; select.blur();
      placeholder.textContent = '保存中…';
      act('snooze', { cardId: card.creditId, option });
    });
    text($('identifiers'), 'div', `${card.cardName} · ${card.creditId}`);
  }
  const latest = [...cards].sort((a, b) => (b.syncedAt || 0) - (a.syncedAt || 0))[0];
  $('count').textContent = Number.isInteger(latest?.currentAvailableCount) ? `最近可用：${latest.currentAvailableCount} 张` : '可用数量：尚未核对';
  $('sync').textContent = payload.simulated ? '演示数据' : latest?.syncedAt
    ? `上次核对：${new Date(latest.syncedAt * 1000).toLocaleString('zh-CN', { hour12: false })}` : '';
  document.querySelector('main').scrollTop = scrollTop;
  controls();
}

window.api.onReminderData((next) => {
  if (busy || selecting()) deferred = next;
  else render(next);
});
document.addEventListener('focusout', () => queueMicrotask(() => {
  if (!busy && !selecting() && deferred) { const next = deferred; deferred = null; render(next); }
}));

async function act(action, args) {
  if (busy) return;
  busy = true; controls(); $('error').textContent = '';
  try { await window.api.reminderAction(action, args); }
  catch (error) { $('error').textContent = error.message; }
  finally {
    busy = false;
    if (deferred) { const next = deferred; deferred = null; render(next); }
    else if (payload) render(payload);
    controls();
  }
}
$('close').addEventListener('click', () => act('dismiss'));
$('open').addEventListener('click', () => act('open'));
setInterval(() => { if (payload && !busy && !selecting()) render(payload); }, 30_000);
