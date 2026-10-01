import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { callAppServer } from '../legacy/node/check.mjs';
import { activateAccountScope, bindAccountScope, confirmAccountScope, countCodexCards,
  getActiveAccountScope, getAccountScope, currentCliScopeId, getCard, listAccountScopes, openStore } from '../core/store.mjs';

let sessionStatus = null;
const scopeStatuses = new Map();
const candidateSalt = randomUUID();
const checkQueues = new Map();
const digest = (scopeId, value) => value
  ? createHash('sha256').update(`${scopeId}\0${value}`).digest('hex') : null;

export function maskAccountEmail(email) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

function parseIdentity(response) {
  if (response?.account?.type !== 'chatgpt') return null;
  const rawEmail = response.account.email;
  const email = typeof rawEmail === 'string' && /^[^\s@]+@[^\s@]+$/.test(rawEmail.trim())
    ? rawEmail.trim().toLowerCase() : null;
  const rawWorkspace = response.workspaceRouting?.chatgptAccountId;
  const workspaceId = typeof rawWorkspace === 'string' && rawWorkspace.trim()
    ? rawWorkspace.trim() : null;
  if (!email && !workspaceId) return null;
  return { email, workspaceId, displayName: email ? maskAccountEmail(email)
    : `ChatGPT 工作区 · ****${workspaceId.slice(-4)}` };
}

export function accountStatus(db, scopeId = null) {
  const binding = scopeId ? getAccountScope(db, scopeId) : getActiveAccountScope(db);
  const scoped = scopeStatuses.get(binding?.scopeId);
  if (scoped) return { ...scoped };
  if (sessionStatus?.scopeId === (binding?.scopeId ?? null)) return { ...sessionStatus };
  return { state: 'checking', scopeId: binding?.scopeId ?? null, boundDisplay: binding?.displayName ?? null,
    currentDisplay: null, verifiedAt: null };
}

async function performAccountCheck(configPath, { appServer = callAppServer,
  confirmLegacy = false, expectedCandidateToken = null, expectedScopeId = null,
  activate = true, beforeConfirm = null } = {}) {
  const db = openStore();
  let binding = expectedScopeId ? getAccountScope(db, expectedScopeId)
    : getAccountScope(db, currentCliScopeId(db)) || getActiveAccountScope(db);
  const finish = (status) => {
    if (status.scopeId) scopeStatuses.set(status.scopeId, status);
    sessionStatus = status;
    return { ...status };
  };
  try {
    let identity;
    try {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      identity = parseIdentity(await appServer(resolve(config.codexScript), 'account/read', {}));
    } catch {
      sessionStatus = { state: 'unavailable', scopeId: binding?.scopeId ?? null,
        boundDisplay: binding?.displayName ?? null, currentDisplay: null, verifiedAt: null };
      return finish(sessionStatus);
    }
    if (!identity) {
      sessionStatus = { state: 'unidentified', scopeId: binding?.scopeId ?? null,
        boundDisplay: binding?.displayName ?? null, currentDisplay: null, verifiedAt: null };
      return finish(sessionStatus);
    }
    const scopes = listAccountScopes(db);
    if (expectedScopeId) {
      const match = binding && (binding.workspaceHash
        ? identity.workspaceId && binding.workspaceHash === digest(binding.scopeId, identity.workspaceId)
        : identity.email && binding.emailHash === digest(binding.scopeId, identity.email));
      if (!match) return finish({ state: 'mismatch', scopeId: expectedScopeId,
        boundDisplay: binding?.displayName ?? null, currentDisplay: identity.displayName, verifiedAt: null });
      const confirmed = { scopeId: binding.scopeId, emailHash: digest(binding.scopeId, identity.email) || binding.emailHash,
        workspaceHash: digest(binding.scopeId, identity.workspaceId) || binding.workspaceHash, displayName: identity.displayName };
      if (beforeConfirm) await beforeConfirm(confirmed);
      confirmAccountScope(db, confirmed);
      return finish({ state: 'verified', scopeId: binding.scopeId, boundDisplay: identity.displayName,
        currentDisplay: identity.displayName, verifiedAt: Math.floor(Date.now() / 1000) });
    }
    let newBinding = false;
    if (!scopes.length) {
      const candidateToken = digest(candidateSalt, `${identity.email || ''}\0${identity.workspaceId || ''}`);
      if (countCodexCards(db) && (!confirmLegacy || expectedCandidateToken !== candidateToken)) {
        sessionStatus = { state: 'needsBinding', scopeId: null,
          boundDisplay: null, currentDisplay: identity.displayName,
          candidateToken, verifiedAt: null };
        return finish(sessionStatus);
      }
      const scopeId = randomUUID();
      binding = { scopeId, emailHash: digest(scopeId, identity.email),
        workspaceHash: digest(scopeId, identity.workspaceId), displayName: identity.displayName };
      newBinding = true;
    } else {
      const workspaceMatches = identity.workspaceId
        ? scopes.filter((scope) => scope.workspaceHash === digest(scope.scopeId, identity.workspaceId)) : [];
      const emailMatches = identity.email
        ? scopes.filter((scope) => scope.emailHash === digest(scope.scopeId, identity.email)) : [];
      if (workspaceMatches.length) binding = workspaceMatches[0];
      else if (identity.workspaceId) binding = emailMatches.find((scope) => !scope.workspaceHash) || null;
      else if (emailMatches.length === 1 && !emailMatches[0].workspaceHash) binding = emailMatches[0];
      else if (emailMatches.length) {
        sessionStatus = { state: 'unidentified', scopeId: getActiveAccountScope(db)?.scopeId ?? null,
          boundDisplay: getActiveAccountScope(db)?.displayName ?? null,
          currentDisplay: identity.displayName, verifiedAt: null };
        return finish(sessionStatus);
      } else binding = null;
      if (!binding) {
        const scopeId = randomUUID();
        binding = { scopeId, emailHash: digest(scopeId, identity.email),
          workspaceHash: digest(scopeId, identity.workspaceId), displayName: identity.displayName };
        newBinding = true;
      }
    }
    const emailHash = digest(binding.scopeId, identity.email);
    const workspaceHash = digest(binding.scopeId, identity.workspaceId);
    const confirmed = { scopeId: binding.scopeId,
      emailHash: emailHash || binding.emailHash,
      workspaceHash: workspaceHash || binding.workspaceHash,
      displayName: identity.displayName };
    // 保存独立会话后才登记或更新账号；这里没有跨异步步骤的数据库事务。
    if (beforeConfirm) await beforeConfirm(confirmed);
    const originallySelected = getActiveAccountScope(db)?.scopeId;
    if (newBinding) bindAccountScope(db, confirmed);
    else if (activate && !binding.active) activateAccountScope(db, binding.scopeId);
    if (!activate && originallySelected && getActiveAccountScope(db)?.scopeId !== originallySelected)
      activateAccountScope(db, originallySelected);
    confirmAccountScope(db, confirmed);
    sessionStatus = { state: 'verified', scopeId: binding.scopeId,
      boundDisplay: identity.displayName, currentDisplay: identity.displayName,
      verifiedAt: Math.floor(Date.now() / 1000) };
    return finish(sessionStatus);
  } finally { db.close(); }
}

export function checkAccount(configPath, options = {}) {
  const key = options.expectedScopeId || 'current';
  const pending = (checkQueues.get(key) || Promise.resolve()).catch(() => {}).then(() => performAccountCheck(configPath, options));
  checkQueues.set(key, pending);
  pending.finally(() => { if (checkQueues.get(key) === pending) checkQueues.delete(key); }).catch(() => {});
  return pending;
}

const messages = {
  mismatch: '此账号的登录会话已变化，请重新登录此账号；其他账号继续提醒。',
  needsBinding: '现有 Codex 卡尚未绑定账号；请确认正在使用原 CLI 账号，再到“设置 → 账号”确认。',
  unavailable: '暂时无法核实 Codex 登录账号；请检查连接后重新核对。',
  unidentified: 'Codex 未提供可辨认的账号身份；已暂停 Codex 卡操作。',
  checking: 'Codex 账号尚未核实，请稍后重试。',
};

export async function requireAccount(configPath, options = {}) {
  const status = await checkAccount(configPath, options);
  if (status.state !== 'verified') {
    const error = new Error(messages[status.state] || messages.checking);
    error.code = `ACCOUNT_${status.state.toUpperCase()}`;
    throw error;
  }
  return status.scopeId;
}

export function requireCardInScope(cardId, scopeId) {
  const db = openStore();
  try {
    const card = getCard(db, cardId);
    if (card?.source !== 'codex' || card.accountScopeId !== scopeId) {
      const error = new Error('这张 Codex 卡不属于当前绑定账号，已阻止正式用卡。');
      error.code = 'ACCOUNT_CARD_SCOPE';
      throw error;
    }
    return card;
  } finally { db.close(); }
}
