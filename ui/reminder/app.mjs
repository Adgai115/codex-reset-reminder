const $ = (id) => document.getElementById(id);
let payload = null;
let deferred = null;
let busy = false;
let selectedId = null;
const selecting = () => document.activeElement?.tagName === 'SELECT';
const keyLabel = (id) => `#${String(id || '').slice(-6)}`;
const currentCard = () => payload?.cards.find((card) => card.creditId === selectedId) || payload?.cards[0];

function controls() {
  for (const element of document.querySelectorAll('button, select')) element.disabled = busy;
  $('reset').disabled = busy || payload?.simulated === true;
  $('option').disabled = busy || $('option').options.length < 2;
}

function render(next) {
  payload = next;
  if (!next.cards.some((card) => card.creditId === selectedId)) selectedId = next.cards[0]?.creditId || null;
  const card = currentCard();
  if (!card) return;
  $('heading').textContent = next.simulated ? 'Codex 测试提醒' : 'Codex 重置卡';
  $('account').textContent = next.accountDisplay || (next.simulated ? '演示账号' : '账号待核对');
  const index = next.cards.findIndex((item) => item.creditId === card.creditId);
  $('pager').hidden = next.cards.length < 2;
  $('position').textContent = `${index + 1} / ${next.cards.length}`;
  const hours = Math.ceil((card.expiresAt * 1000 - Date.now()) / 3600000);
  $('days').textContent = hours <= 0 ? '已到期' : hours < 24
    ? `不足 ${Math.max(1, hours)} 小时` : `${Math.ceil(hours / 24)} 天后到期`;
  $('name').textContent = card.cardName;
  $('name').title = card.cardName;
  $('card-key').textContent = keyLabel(card.creditId);
  $('card-key').title = card.creditId;
  $('expiry').textContent = `到期 ${card.expiresLocal}`;
  $('option').replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.textContent = card.snoozeOptions?.length ? '稍后提醒' : '无法延期';
  placeholder.value = ''; placeholder.disabled = true; placeholder.selected = true;
  $('option').appendChild(placeholder);
  for (const choice of card.snoozeOptions || []) {
    const option = document.createElement('option');
    option.value = choice.option; option.textContent = choice.label; $('option').appendChild(option);
  }
  controls();
}

window.api.onReminderData((next) => {
  if (busy || selecting()) deferred = next;
  else render(next);
});
document.addEventListener('focusout', () => queueMicrotask(() => {
  if (!busy && !selecting() && deferred) { const next = deferred; deferred = null; render(next); }
}));

function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').title = message;
  $('feedback').classList.toggle('error', error);
}
async function act(action, args = {}) {
  if (busy) return;
  busy = true; controls(); feedback(action === 'reset' ? '正在核对重置卡…' : '正在保存…');
  try {
    const result = await window.api.reminderAction(action, args);
    if (result?.outcome === 'cancelled') feedback('已取消，重置卡未使用');
    else if (result?.outcome === 'nothingToReset') feedback('当前没有可重置的额度，卡片未消耗');
    else if (result?.outcome === 'noCredit') feedback('Codex 未找到可用的重置卡，请刷新列表', true);
    else if (result?.outcome === 'reset' || result?.outcome === 'alreadyRedeemed') feedback('Codex 已确认重置');
    else feedback('');
  } catch (error) { feedback(action === 'reset'
    ? `结果未确认：${error.message}；请先核对 Codex，勿连续重试` : error.message, true); }
  finally {
    busy = false;
    if (deferred) { const next = deferred; deferred = null; render(next); }
    else if (payload) render(payload);
    controls();
  }
}
$('close').addEventListener('click', () => act('dismiss'));
$('prev').addEventListener('click', () => { if (!payload) return; const i = payload.cards.findIndex((card) => card.creditId === selectedId); selectedId = payload.cards[(i - 1 + payload.cards.length) % payload.cards.length].creditId; feedback(''); render(payload); });
$('next').addEventListener('click', () => { if (!payload) return; const i = payload.cards.findIndex((card) => card.creditId === selectedId); selectedId = payload.cards[(i + 1) % payload.cards.length].creditId; feedback(''); render(payload); });
$('reset').addEventListener('click', () => {
  const card = currentCard();
  if (card && !payload.simulated) act('reset', { cardId: card.creditId, expectedExpiresAt: card.expiresAt });
});
$('option').addEventListener('change', () => {
  const card = currentCard();
  const option = $('option').value;
  $('option').value = ''; $('option').blur();
  if (card && option) act('snooze', { cardId: card.creditId, option });
});
setInterval(() => { if (payload && !busy && !selecting()) render(payload); }, 30_000);
