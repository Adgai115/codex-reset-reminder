import { accountDescription, accountSummary } from '../manage/view-model.mjs';

// 账号偏好独立保存；提醒页草稿由设置窗口保留。
export function createAccountsSettings({ api, onWorking, onDraftDirty }) {
  const $ = (id) => document.getElementById(id);
  const list = $('account-list');
  let snapshot = null;
  let busy = false;
  let blocked = false;
  let loading = false;
  let loadPromise = null;
  let reloadPending = false;
  let readFailed = false;
  let localLogin = null;
  let loginRevision = 0;
  let nameDraftDirty = false;

  const loginState = () => localLogin || snapshot?.login || {};
  const accountLabel = (account) => account?.displayLabel || account?.nickname || account?.boundDisplay || 'Codex 账号';
  function notice(message, error = false) {
    $('account-notice').textContent = message || '';
    $('account-notice').classList.toggle('error', error);
  }
  function notifyNameDraft() {
    const value = [...list.querySelectorAll('[data-account-name]')].some((input) => {
      const account = snapshot?.accounts?.find((entry) => entry.scopeId === input.dataset.scope);
      return account && input.value !== (account.nickname || '');
    });
    if (value === nameDraftDirty) return;
    nameDraftDirty = value;
    // 原生关闭窗口不会触发 DOM change；输入时立即保护尚未自动保存的名称。
    Promise.resolve(onDraftDirty?.(value)).catch((error) => notice(error.message, true));
  }
  function text(parent, tag, value, className = '') {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    parent.appendChild(element);
    return element;
  }
  function button(parent, value, handler) {
    const element = text(parent, 'button', value);
    element.type = 'button';
    element.addEventListener('click', handler);
    return element;
  }
  function stateLabel(account) {
    if (account.state === 'verified') return account.independent ? '已连接' : '需独立登录';
    if (account.state === 'loginRequired' || account.state === 'mismatch') return '需要登录';
    if (account.state === 'needsBinding') return '待确认账号';
    if (account.state === 'unidentified') return '账号无法辨认';
    if (account.state === 'unavailable') return '连接待恢复';
    return '核对中…';
  }
  function controls() {
    const disabled = busy || blocked;
    const waiting = loginState().state === 'waiting';
    for (const element of list.querySelectorAll('input, button')) {
      element.disabled = disabled || (element.dataset.login === 'true' && waiting);
    }
    $('add-account').disabled = disabled || waiting;
    $('get-current-account').disabled = disabled;
    $('check-account').disabled = disabled || !snapshot?.account?.scopeId;
    $('check-account').hidden = !snapshot?.account?.scopeId;
    $('check-account').title = `核对 ${accountLabel(snapshot?.account)} 的身份与卡片`;
    $('check-account').setAttribute('aria-label', `重新核对 ${accountLabel(snapshot?.account)}`);
    $('bind-account').hidden = snapshot?.account?.state !== 'needsBinding';
    $('bind-account').disabled = disabled;
    $('cancel-login').hidden = !waiting;
    $('cancel-login').disabled = disabled;
  }
  function createRow(scopeId) {
    const row = text(list, 'div', '', 'account-row');
    row.dataset.scope = scopeId;
    const info = text(row, 'div', '', 'account-info');
    const name = text(info, 'div', '', 'account-name');
    const input = text(name, 'input', '');
    input.maxLength = 30;
    input.dataset.scope = scopeId;
    input.dataset.accountName = 'true';
    input.addEventListener('input', notifyNameDraft);
    input.addEventListener('change', () => {
      const nickname = input.value;
      run(() => api.core('updateAccount', { scopeId, nickname }), '账号名称已保存');
    });
    // 纯后台刷新保留输入；失焦后再应用保存结果或失败回滚。
    input.addEventListener('blur', () => queueMicrotask(() => { if (!busy) render(); }));
    const meta = text(info, 'div', '', 'account-meta');
    text(meta, 'span', '', 'account-state');
    const actions = text(row, 'div', '', 'account-actions');
    const label = text(actions, 'label', '');
    const toggle = text(label, 'input', '');
    toggle.type = 'checkbox';
    toggle.dataset.accountReminders = 'true';
    label.appendChild(document.createTextNode('提醒'));
    toggle.addEventListener('change', () => {
      const remindersEnabled = toggle.checked;
      run(() => api.core('updateAccount', { scopeId, remindersEnabled }),
        remindersEnabled ? '已开启账号提醒' : '已暂停账号提醒');
    });
    const view = button(actions, '查看', () => run(() => api.viewAccount(scopeId),
      `已切换到 ${accountLabel(snapshot.accounts.find((account) => account.scopeId === scopeId))}`));
    view.dataset.accountView = 'true';
    view.dataset.view = scopeId;
    const login = button(actions, '登录', () => loginAccount(scopeId));
    login.dataset.login = 'true';
    return row;
  }
  function render() {
    const accounts = snapshot?.accounts || [];
    const ids = new Set(accounts.map((account) => account.scopeId));
    for (const row of list.querySelectorAll('.account-row')) if (!ids.has(row.dataset.scope)) row.remove();
    for (const placeholder of list.querySelectorAll('.accounts-empty')) placeholder.remove();
    if (accounts.length) {
      // 按 scope 更新现有节点，刷新其他账号时不会重建正在编辑的名称框。
      if (!list.querySelector('.account-row')) list.replaceChildren();
      for (const [index, account] of accounts.entries()) {
        let row = [...list.querySelectorAll('.account-row')].find((element) => element.dataset.scope === account.scopeId);
        row ||= createRow(account.scopeId);
        if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
        row.dataset.selected = String(account.scopeId === snapshot.account?.scopeId);
        const name = row.querySelector('[data-account-name]');
        if (document.activeElement !== name) name.value = account.nickname || '';
        name.placeholder = account.boundDisplay || accountLabel(account);
        name.setAttribute('aria-label', `账号名称 ${accountLabel(account)}`);
        name.title = account.currentCli ? `${accountLabel(account)} · Codex CLI 使用此账号` : accountLabel(account);
        row.querySelector('.account-state').textContent = stateLabel(account);
        const toggle = row.querySelector('[data-account-reminders]');
        toggle.checked = account.remindersEnabled;
        toggle.setAttribute('aria-label', `${accountLabel(account)} 提醒`);
        const view = row.querySelector('[data-account-view]');
        view.title = account.scopeId === snapshot.account?.scopeId ? '正在查看此账号' : '查看此账号的卡片与记录';
        view.setAttribute('aria-label', `查看 ${accountLabel(account)} 的卡片与记录`);
        row.querySelector('[data-login]').textContent = account.independent ? '重新登录' : '登录';
      }
    } else {
      list.replaceChildren();
      text(list, 'div', snapshot ? '暂无账号' : readFailed ? '账号暂不可用' : '读取中…', 'accounts-empty');
    }
    const login = loginState();
    $('login-status').textContent = login.state === 'waiting' ? '请在浏览器完成登录'
      : login.state === 'failed' ? login.message || '登录未完成，请重试' : '';
    $('login-status').classList.toggle('error', login.state === 'failed');
    notifyNameDraft();
    controls();
  }
  async function refresh(force = false) {
    if (loading) {
      reloadPending = true;
      await loadPromise;
      return reloadPending ? refresh(force) : !readFailed;
    }
    if (busy && !force) { reloadPending = true; return false; }
    loading = true;
    reloadPending = false;
    const revision = loginRevision;
    loadPromise = (async () => {
      try {
        const value = await api.core('manageSnapshot');
        snapshot = value;
        if (revision === loginRevision && value.login) localLogin = value.login;
        readFailed = false;
        render();
        return true;
      } catch (error) {
        readFailed = true;
        notice(`账号读取失败：${error.message}`, true);
        render();
        return false;
      } finally { loading = false; }
    })();
    const result = await loadPromise;
    if (reloadPending && !busy) return refresh();
    return result;
  }
  async function run(operation, success = '') {
    if (busy || blocked) return null;
    busy = true;
    controls();
    try {
      await onWorking(true);
      const result = await operation();
      const refreshed = await refresh(true);
      if (refreshed && success) notice(success);
      return result;
    } catch (error) {
      await refresh(true);
      notice(error.message, true);
      return null;
    } finally {
      busy = false;
      render();
      try { await onWorking(false); } catch (error) { notice(error.message, true); }
      if (reloadPending) refresh();
    }
  }
  async function loginAccount(scopeId) {
    if (loginState().state === 'waiting') return;
    await run(async () => {
      const result = await api.loginAccount(scopeId);
      localLogin = { ...result, scopeId };
      loginRevision += 1;
      return result;
    });
  }
  function checkedMessage(result) {
    if (result.state !== 'verified') return { text: `${accountSummary(result)}\n${accountDescription(result)}`, error: true };
    if (result.syncError) return { text: `账号已核对 · 同步暂不可用\n${result.syncError}`, error: true };
    const sync = result.syncResult;
    if (sync?.complete) return { text: `已核对 · ${sync.availableCount} 张可用`, error: false };
    return { text: `已连接 · ${sync?.availableCount ?? 0} 张可用，详情待获取${sync?.detailMessage ? `\n${sync.detailMessage}` : ''}`, error: true };
  }
  async function checkAccount(scopeId) {
    const result = await run(() => api.core('checkAccount', scopeId ? { scopeId } : {}));
    if (result) { const message = checkedMessage(result); notice(message.text, message.error); }
  }
  $('add-account').addEventListener('click', () => loginAccount());
  $('get-current-account').addEventListener('click', () => checkAccount());
  $('check-account').addEventListener('click', () => checkAccount(snapshot?.account?.scopeId));
  $('cancel-login').addEventListener('click', () => run(async () => {
    await api.cancelAccountLogin();
    localLogin = { state: 'idle' };
    loginRevision += 1;
  }, '登录已取消'));
  $('bind-account').addEventListener('click', async () => {
    if (busy || blocked || snapshot?.account?.state !== 'needsBinding') return;
    const candidate = snapshot.account;
    if (!confirm(`确认 ${candidate.currentDisplay} 是现有卡片的原账号？\n绑定后将同步并提醒这些卡片。`)) return;
    const result = await run(() => api.core('confirmLegacyBinding', {
      expectedCandidateToken: candidate.candidateToken,
    }));
    if (result) { const message = checkedMessage(result); notice(message.text, message.error); }
  });
  api.onStateChanged(() => refresh());
  window.addEventListener('focus', () => refresh());
  // 读取本地状态，不会轮询或消耗 Codex 重置卡。
  setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
  refresh();
  return {
    refresh,
    setBlocked(value) { blocked = value; controls(); },
  };
}
