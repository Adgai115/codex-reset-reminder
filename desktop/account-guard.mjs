import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { callAppServer } from '../legacy/node/check.mjs';
import { activateAccountScope, bindAccountScope, confirmAccountScope, countCodexCards,
  getActiveAccountScope, getCard, listAccountScopes, openStore } from '../core/store.mjs';

let sessionStatus = null;
const candidateSalt = randomUUID();
let checkQueue = Promise.resolve();
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

export function accountStatus(db) {
  const binding = getActiveAccountScope(db);
  if (sessionStatus?.scopeId === (binding?.scopeId ?? null)) return { ...sessionStatus };
  return { state: 'checking', boundDisplay: binding?.displayName ?? null,
    currentDisplay: null, verifiedAt: null };
}

async function performAccountCheck(configPath, { appServer = callAppServer,
  confirmLegacy = false, expectedCandidateToken = null } = {}) {
  const db = openStore();
  let binding = getActiveAccountScope(db);
  try {
    let identity;
    try {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      identity = parseIdentity(await appServer(resolve(config.codexScript), 'account/read', {}));
    } catch {
      sessionStatus = { state: 'unavailable', scopeId: binding?.scopeId ?? null,
        boundDisplay: binding?.displayName ?? null, currentDisplay: null, verifiedAt: null };
      return accountStatus(db);
    }
    if (!identity) {
      sessionStatus = { state: 'unidentified', scopeId: binding?.scopeId ?? null,
        boundDisplay: binding?.displayName ?? null, currentDisplay: null, verifiedAt: null };
      return accountStatus(db);
    }
    const scopes = listAccountScopes(db);
    if (!scopes.length) {
      const candidateToken = digest(candidateSalt, `${identity.email || ''}\0${identity.workspaceId || ''}`);
      if (countCodexCards(db) && (!confirmLegacy || expectedCandidateToken !== candidateToken)) {
        sessionStatus = { state: 'needsBinding', scopeId: null,
          boundDisplay: null, currentDisplay: identity.displayName,
          candidateToken, verifiedAt: null };
        return accountStatus(db);
      }
      const scopeId = randomUUID();
      bindAccountScope(db, { scopeId, emailHash: digest(scopeId, identity.email),
        workspaceHash: digest(scopeId, identity.workspaceId), displayName: identity.displayName });
      binding = getActiveAccountScope(db);
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
        return accountStatus(db);
      } else binding = null;
      if (!binding) {
        const scopeId = randomUUID();
        bindAccountScope(db, { scopeId, emailHash: digest(scopeId, identity.email),
          workspaceHash: digest(scopeId, identity.workspaceId), displayName: identity.displayName });
        binding = getActiveAccountScope(db);
      } else if (!binding.active) {
        activateAccountScope(db, binding.scopeId);
      }
    }
    const emailHash = digest(binding.scopeId, identity.email);
    const workspaceHash = digest(binding.scopeId, identity.workspaceId);
    confirmAccountScope(db, { scopeId: binding.scopeId,
      emailHash: emailHash || binding.emailHash,
      workspaceHash: workspaceHash || binding.workspaceHash,
      displayName: identity.displayName });
    sessionStatus = { state: 'verified', scopeId: binding.scopeId,
      boundDisplay: identity.displayName, currentDisplay: identity.displayName,
      verifiedAt: Math.floor(Date.now() / 1000) };
    return accountStatus(db);
  } finally { db.close(); }
}

export function checkAccount(configPath, options = {}) {
  const pending = checkQueue.catch(() => {}).then(() => performAccountCheck(configPath, options));
  checkQueue = pending.catch(() => {});
  return pending;
}

const messages = {
  needsBinding: '现有 Codex 卡尚未绑定账号；请确认正在使用原 CLI 账号，再在管理页绑定。',
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
