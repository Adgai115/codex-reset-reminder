import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callAppServer } from './check.mjs';
import { replanScheduledTask } from './replan.mjs';
import { markCardUsed, openStore, saveCodexSnapshot } from './store.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.CODEX_RESET_MONITOR_CONFIG_PATH || join(directory, 'config.json');

function windowSummary(window) {
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  return { usedPercent: window.usedPercent,
    durationMins: Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null };
}

export function summarizeRateLimits(response, checkedAt = Math.floor(Date.now() / 1000)) {
  const limits = response?.rateLimitsByLimitId?.codex || response?.rateLimits;
  const count = response?.rateLimitResetCredits?.availableCount;
  return {
    checkedAt,
    remaining: Number.isInteger(count) && count >= 0 ? count : null,
    primary: windowSummary(limits?.primary),
    secondary: windowSummary(limits?.secondary),
  };
}

async function codexScriptPath() {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  return resolve(config.codexScript);
}

async function readStatus(codexScript, appServer, verifyAccount = null) {
  const scopeId = verifyAccount ? await verifyAccount() : null;
  const response = await appServer(codexScript, 'account/rateLimits/read');
  if (verifyAccount && await verifyAccount() !== scopeId) throw new Error('Codex 账号在读取期间发生变化');
  const resetCredits = response?.rateLimitResetCredits;
  if (Number.isInteger(resetCredits?.availableCount) && Array.isArray(resetCredits?.credits)) {
    try {
      const db = openStore();
      try { saveCodexSnapshot(db, resetCredits, Math.floor(Date.now() / 1000), scopeId); }
      finally { db.close(); }
    } catch {
      // A local cache failure must not hide the fresh result returned by Codex.
    }
  }
  return summarizeRateLimits(response);
}

export async function refreshCreditStatus({ appServer = callAppServer, verifyAccount = null } = {}) {
  return readStatus(await codexScriptPath(), appServer, verifyAccount);
}

export async function consumeCredit(creditId, idempotencyKey, { appServer = callAppServer,
  verifyAccount = null, verifyCard = null } = {}) {
  if (!creditId || !idempotencyKey) throw new Error('缺少重置卡编号或操作标识');
  const codexScript = await codexScriptPath();
  const scopeId = verifyAccount ? await verifyAccount() : null;
  if (verifyCard) verifyCard(creditId, scopeId);
  const result = await appServer(codexScript, 'account/rateLimitResetCredit/consume', {
    creditId,
    idempotencyKey,
  });
  if (verifyAccount) {
    try {
      if (await verifyAccount() !== scopeId) throw new Error('Codex 账号在用卡期间发生变化');
    } catch (error) { error.afterRequest = true; throw error; }
  }
  const outcome = result?.outcome;
  if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(outcome)) {
    throw new Error('Codex 返回了无法识别的用卡结果');
  }
  let statusInfo = null;
  if (outcome === 'reset' || outcome === 'alreadyRedeemed') {
    const db = openStore();
    try { markCardUsed(db, creditId); } finally { db.close(); }
    try {
      statusInfo = await readStatus(codexScript, appServer, verifyAccount);
    } catch {
      // The use result is authoritative even if the follow-up read fails.
    } finally {
      // A slightly stale read must never make the consumed credit available again.
      const afterRead = openStore();
      try { markCardUsed(afterRead, creditId); } finally { afterRead.close(); }
    }
  }
  return { outcome, statusInfo };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [creditId, idempotencyKey] = process.argv.slice(2);
  consumeCredit(creditId, idempotencyKey)
    .then((result) => { console.log(JSON.stringify(result)); replanScheduledTask(); })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
