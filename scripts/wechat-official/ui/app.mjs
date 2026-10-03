const api = window.wechatProbe;
const byId = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  'statusBanner', 'statusMessage', 'loginButton', 'forgetButton', 'connectionState',
  'qrArea', 'qrImage', 'verifyForm', 'verifyCode', 'verifyButton', 'boundNote',
  'contextInstruction', 'contextDetail', 'sendButton', 'omitButton', 'delayMinutes',
  'scheduleButton', 'scheduledNote', 'scheduledAt', 'cancelButton', 'tests',
  'sharingButton', 'sharingState', 'sourceForm', 'sourceName', 'sourceButton', 'sharedClients', 'sharedReceipts',
].map((id) => [id, byId(id)]));

let state = { phase: 'idle', message: '正在连接本地验证工具…', busy: true, bound: false, hasContext: false, contextAt: null, scheduled: null, tests: [], listening: false };
let pending = false;
let localError = '';
let available = Boolean(api);

const timeLabel = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)
    : '时间未知';
};

function acceptStatus(payload) {
  const next = payload?.status ?? payload;
  if (!next || typeof next !== 'object' || !Object.hasOwn(next, 'phase')) return;
  state = next;
  if (state.phase !== 'verify') elements.verifyCode.value = '';
  render();
}

function renderTests(disabled) {
  const records = Array.isArray(state.tests) ? state.tests.slice(0, 12) : [];
  const fragment = document.createDocumentFragment();
  if (!records.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '尚无测试记录。手机看到消息后，点击对应记录的“已收到”。';
    fragment.append(empty);
  }
  const labels = { pending: '正在提交', accepted: '微信已接受', unknown: '发送结果待确认', rejected: '微信拒绝', received: '手机已收到' };
  for (const test of records) {
    const row = document.createElement('div');
    row.className = 'test-row';
    const copy = document.createElement('div');
    copy.className = 'test-copy';
    const title = document.createElement('p');
    title.className = 'test-title';
    title.textContent = `${String(test.label ?? '模拟提醒测试')} · ${String(test.id ?? '').slice(0, 8)}`;
    const meta = document.createElement('p');
    meta.className = 'test-meta';
    const metadata = [timeLabel(test.at)];
    if (Number.isFinite(test.contextAgeMinutes)) metadata.push(`会话已过去 ${Math.round(test.contextAgeMinutes)} 分钟`);
    if (test.confirmation === 'rejected' && /^[A-Za-z0-9_-]{1,32}$/.test(String(test.code ?? ''))) metadata.push(`错误码 ${test.code}`);
    meta.textContent = metadata.join(' · ');
    const result = document.createElement('span');
    const confirmation = Object.hasOwn(labels, test.confirmation) ? test.confirmation : 'unknown';
    result.className = `test-result ${confirmation}`;
    result.textContent = labels[confirmation];
    copy.append(title, meta, result);
    row.append(copy);
    if (confirmation === 'accepted' || confirmation === 'unknown') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'confirm-button';
      button.textContent = '已收到';
      button.title = '确认你已在手机微信看到这条模拟消息';
      button.disabled = disabled;
      button.addEventListener('click', () => invoke('confirm', test.id));
      row.append(button);
    }
    fragment.append(row);
  }
  elements.tests.replaceChildren(fragment);
}

function renderSharing(disabled) {
  const gateway = state.gateway || {};
  const running = Boolean(gateway.running);
  elements.sharingButton.textContent = running ? '关闭共享' : '开启共享';
  elements.sharingButton.disabled = !available || pending || (!running && (disabled || !state.bound));
  const queue = Number.isInteger(gateway.queued) && gateway.queued > 0 ? ` · 排队 ${gateway.queued} 条` : '';
  elements.sharingState.textContent = running ? `已开启 · ${gateway.sending ? '正在发送' : '等待通知'}${queue}` : '已关闭，开启后供已授权的本机 agent 发送微信通知。';
  elements.sourceName.disabled = disabled || !running;
  elements.sourceButton.disabled = disabled || !running || !elements.sourceName.value.trim();
  const clients = Array.isArray(gateway.clients) ? gateway.clients : [];
  const fragment = document.createDocumentFragment();
  for (const client of clients) {
    const row = document.createElement('div'); row.className = 'source-row';
    const copy = document.createElement('span'); copy.className = 'source-copy';
    copy.textContent = `${String(client.label || '共享来源')}${client.revoked ? ' · 已撤销' : ''}`;
    copy.title = String(client.label || '共享来源'); row.append(copy);
    if (!client.revoked) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet';
      button.textContent = '撤销'; button.disabled = !available || pending;
      button.addEventListener('click', () => invoke('gatewayRevokeClient', client.id)); row.append(button);
    }
    fragment.append(row);
  }
  elements.sharedClients.replaceChildren(fragment);
  const receipts = Array.isArray(gateway.receipts) ? gateway.receipts.slice(0, 6) : [];
  const recent = document.createDocumentFragment();
  const labels = { pending: '正在提交', queued: '排队中', accepted: '微信已接受', unknown: '结果待确认', rejected: '微信拒绝', unsent: '未发送', cancelled: '已取消' };
  for (const receipt of receipts) {
    const row = document.createElement('p'); row.className = 'receipt-row';
    const label = clients.find((client) => client.id === receipt.clientId)?.label || '共享来源';
    row.textContent = `${String(label)} · ${String(receipt.id || '').slice(0, 8)} · ${labels[receipt.state] || '结果待确认'}${receipt.at ? ` · ${timeLabel(receipt.at)}` : ''}`;
    recent.append(row);
  }
  elements.sharedReceipts.replaceChildren(recent);
}

function render() {
  const disabled = !available || pending || Boolean(state.busy);
  const bound = Boolean(state.bound);
  const ready = bound && Boolean(state.hasContext);
  const hasSchedule = Boolean(state.scheduled?.at);
  elements.statusMessage.textContent = localError || state.message || (bound ? '微信测试连接已绑定。' : '请扫码绑定微信。');
  elements.statusBanner.dataset.tone = localError || state.phase === 'error' ? 'error' : bound ? 'success' : 'neutral';
  elements.loginButton.disabled = disabled || bound;
  elements.loginButton.textContent = bound ? '已扫码绑定' : state.phase === 'idle' ? '扫码绑定' : '重新扫码';
  elements.forgetButton.disabled = disabled || state.phase === 'idle';
  elements.connectionState.textContent = bound ? (state.listening ? '已绑定 · 正在监听微信' : '已绑定') : ({ login: '等待微信扫码', verify: '等待验证码', expired: '连接已失效', error: '连接待处理' }[state.phase] || '尚未绑定');

  const qr = typeof state.qrDataUrl === 'string' && state.qrDataUrl.startsWith('data:image/svg+xml;base64,') && state.phase === 'login';
  elements.qrArea.hidden = !qr;
  if (qr && elements.qrImage.getAttribute('src') !== state.qrDataUrl) elements.qrImage.setAttribute('src', state.qrDataUrl);
  if (!qr) elements.qrImage.removeAttribute('src');
  elements.verifyForm.hidden = state.phase !== 'verify';
  elements.verifyCode.disabled = disabled;
  elements.verifyButton.disabled = disabled || !elements.verifyCode.value.trim();
  elements.boundNote.hidden = !bound;
  elements.contextInstruction.textContent = ready ? '测试会话已建立，可以发送模拟提醒。' : '请在微信 ClawBot 会话中发送“验证”，建立测试会话。';
  elements.contextDetail.textContent = ready && state.contextAt ? `最近收到消息：${timeLabel(state.contextAt)}` : state.listening ? '正在等待你发送的微信消息。' : '微信监听暂未运行，请查看上方状态。';
  elements.sendButton.disabled = disabled || !ready;
  elements.omitButton.disabled = disabled || !bound;
  elements.delayMinutes.disabled = disabled || !ready || hasSchedule;
  elements.scheduleButton.disabled = disabled || !ready || hasSchedule;
  elements.scheduledNote.hidden = !hasSchedule;
  elements.scheduledAt.textContent = hasSchedule ? `计划发送：${timeLabel(state.scheduled.at)}` : '';
  elements.cancelButton.disabled = disabled || !hasSchedule;
  renderTests(disabled);
  renderSharing(disabled);
}

async function invoke(method, argument) {
  if (!available || pending) return;
  pending = true;
  localError = '';
  render();
  try {
    const result = argument === undefined ? await api[method]() : await api[method](argument);
    if (result?.status) acceptStatus(result.status);
    if (!result?.ok) localError = typeof result?.error === 'string' ? result.error : '操作未完成，请查看连接状态后重试。';
  } catch {
    localError = '本地验证工具通信失败，请重新打开窗口后重试。';
  } finally {
    pending = false;
    render();
  }
}

elements.loginButton.addEventListener('click', () => invoke('login'));
elements.forgetButton.addEventListener('click', () => invoke('forget'));
elements.sendButton.addEventListener('click', () => invoke('send', { omitContext: false }));
elements.omitButton.addEventListener('click', () => invoke('send', { omitContext: true }));
elements.scheduleButton.addEventListener('click', () => invoke('schedule', Number(elements.delayMinutes.value)));
elements.cancelButton.addEventListener('click', () => invoke('cancel'));
elements.verifyCode.addEventListener('input', render);
elements.sharingButton.addEventListener('click', () => invoke(state.gateway?.running ? 'gatewayDisable' : 'gatewayEnable'));
elements.sourceName.addEventListener('input', render);
elements.sourceForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const label = elements.sourceName.value.trim();
  if (label) invoke('gatewayAddClient', label);
});
elements.verifyForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = elements.verifyCode.value.trim();
  if (code) invoke('verifyCode', code);
});

if (api) {
  const unsubscribe = api.onStatus((status) => {
    localError = '';
    acceptStatus(status);
  });
  window.addEventListener('beforeunload', () => unsubscribe(), { once: true });
  invoke('status');
} else {
  localError = '请从独立验证工具启动此窗口。';
  render();
}
