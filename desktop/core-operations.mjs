// Electron 主进程和 Node sidecar 共用同一组数据库操作。
import * as store from '../core/store.mjs';
import { getSnoozeOptions, planSnooze } from '../core/later.mjs';
import { syncCards } from '../legacy/node/sync.mjs';
import { runReminders } from '../legacy/node/remind.mjs';
import { preflightSync } from '../legacy/node/preflight-sync.mjs';
import { planCardNextCheck, planNextCheck } from '../legacy/node/plan-next.mjs';
import { enabledChannels, quietHours } from '../core/reminder-policy.mjs';
import { deliveryTime } from '../core/reminder-policy.mjs';
import { dueThreshold } from '../legacy/node/check.mjs';
import { maxReminderAttempts } from '../core/delivery-retry.mjs';
import { pendingReminder } from '../core/pending-reminders.mjs';
import { handleCardAction } from '../core/card-actions.mjs';
import { consumeCredit, refreshCreditStatus } from '../legacy/node/consume.mjs';
import { accountStatus, checkAccount, requireAccount, requireCardInScope } from './account-guard.mjs';
import { accountDisplayLabels } from '../core/account-labels.mjs';
import { resetCardFromReminder } from './reset-card.mjs';
import { callAppServer } from '../legacy/node/check.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const value = (input) => String(input ?? '').trim();

const configPath = () => process.env.CODEX_RESET_MONITOR_CONFIG_PATH || join(import.meta.dirname, '..', 'config.json');
const readDb = (run) => { const db = store.openStore(); try { return run(db); } finally { db.close(); } };
const syncingAccounts = new Map();

export async function runCoreOperation(op, args = {}, context = {}) {
  const { desktop, accounts } = context;
  const recurse = (operation, arguments_ = {}) => runCoreOperation(operation, arguments_, context);
  const selectedId = () => readDb((db) => store.getActiveAccountScope(db)?.scopeId ?? null);
  const scopes = () => readDb(store.listAccountScopes);
  const currentId = () => readDb(store.currentCliScopeId) || selectedId();
  const profileExists = (id) => accounts ? accounts('has', { scopeId: id }) : Promise.resolve(false);
  const serverFor = (id) => async (script, method, params) => {
    if (!accounts) return callAppServer(script, method, params);
    if (id && !(await profileExists(id))) {
      if (id !== currentId()) throw new Error('此账号需要登录，卡片与记录已保留');
      return accounts('request', { script, scopeId: null, method, params });
    }
    return accounts('request', { script, scopeId: id, method, params, useCurrent: id === currentId() });
  };
  const verifiedScope = (id) => requireAccount(configPath(), { appServer: serverFor(id),
    ...(id ? { expectedScopeId: id, activate: false } : {}) });
  async function discoverCurrent(options = {}) {
    const result = await checkAccount(configPath(), { ...options, appServer: serverFor(null), activate: false });
    if (result.state === 'verified') {
      const binding = readDb((db) => { store.noteCurrentCliScope(db, result.scopeId); return store.getAccountScope(db, result.scopeId); });
      if (accounts) {
        const config = JSON.parse(await readFile(configPath(), 'utf8'));
        try { await accounts('capture', { binding, script: config.codexScript }); }
        catch { /* 当前 CLI 仍可读取；独立登录失败可在账号管理中恢复。 */ }
      }
    }
    return result;
  }
  const protectedSync = async (path, options = {}) => {
    const id = options.accountScopeId || selectedId();
    syncingAccounts.set(id, (syncingAccounts.get(id) || 0) + 1);
    try {
      const result = await syncCards(path, { ...options, appServer: serverFor(id),
        accountScopeId: id, accountGuard: () => verifiedScope(id) });
      readDb((db) => store.recordAccountSyncSchedule(db, id, result.complete));
      return result;
    } catch (error) {
      readDb((db) => store.recordAccountSyncSchedule(db, id, false));
      throw error;
    } finally {
      const remaining = (syncingAccounts.get(id) || 1) - 1;
      if (remaining) syncingAccounts.set(id, remaining); else syncingAccounts.delete(id);
    }
  };
  const accountForCard = (id) => readDb((db) => store.getCard(db, id)?.accountScopeId || null);
  const enabledScopes = () => scopes().filter((scope) => scope.remindersEnabled
    && (!args.scopeId || scope.scopeId === args.scopeId));
  const preflightScope = (scope) => preflightSync({ configPath: configPath(),
    sync: (path, options) => protectedSync(path, { ...options, accountScopeId: scope.scopeId }),
    ...args, accountScopeId: scope.scopeId });
  const remindScope = async (scope) => {
    const accountReady = accounts ? await profileExists(scope.scopeId) : true;
    return runReminders({ configPath: configPath(), desktop: desktop && ((payload) => desktop({ ...payload,
      cards: (payload.cards || [payload]).map((card) => ({ ...card, accountReady })) })),
      trackAttempts: true, batchDesktop: true, ...args, allowCodex: true,
      accountScopeId: scope.scopeId, verifyScope: () => {
        if (!readDb((db) => store.getAccountScope(db, scope.scopeId)?.remindersEnabled))
          throw new Error('此账号提醒已暂停');
        return verifiedScope(scope.scopeId);
      } });
  };
  const snapshotInputs = async () => {
    const accountScopes = scopes();
    const [config, profiles] = await Promise.all([
      readFile(configPath(), 'utf8').then(JSON.parse),
      Promise.all(accountScopes.map(async (scope) => [scope.scopeId, await profileExists(scope.scopeId)])),
    ]);
    return { accountScopes, config, scopeProfiles: new Map(profiles),
      labels: accountDisplayLabels(accountScopes), cards: readDb((db) => store.listCards(db, true)) };
  };
  const consumeForCard = async (id, key) => {
    const scopeId = accountForCard(id);
    if (accounts && !(await profileExists(scopeId))) {
      const error = new Error('请先在账号管理中登录此账号，再确认立即重置');
      error.code = 'ACCOUNT_LOGIN_REQUIRED'; throw error;
    }
    if (accounts && scopeId === currentId()) {
      const config = JSON.parse(await readFile(configPath(), 'utf8'));
      await serverFor(scopeId)(config.codexScript, 'account/rateLimits/read');
      const binding = readDb((db) => store.getAccountScope(db, scopeId));
      await accounts('capture', { binding, script: config.codexScript });
    }
    return consumeCredit(id, key, { appServer: serverFor(scopeId),
      verifyAccount: () => verifiedScope(scopeId), verifyCard: requireCardInScope });
  };
  if (op === 'syncCards') {
    if (!args.scopeId) await discoverCurrent();
    const id = args.scopeId || selectedId();
    if (!id) throw new Error('请先连接一个 Codex 账号');
    return protectedSync(configPath(), { accountScopeId: id });
  }
  if (op === 'syncAllAccounts') {
    const knownScopes = scopes();
    const discovering = discoverCurrent();
    const results = [];
    const now = Math.floor(Date.now() / 1000);
    const synchronize = async (scope) => {
      if (!args.force && scope.nextSyncAt > now) return;
      try { results.push({ scopeId: scope.scopeId, ...await protectedSync(configPath(), { accountScopeId: scope.scopeId }) }); }
      catch { results.push({ scopeId: scope.scopeId, complete: false, error: '账号同步失败' }); }
    };
    const synchronizing = Promise.all(knownScopes.map(synchronize));
    const current = await discovering;
    await Promise.all([synchronizing, ...scopes().filter((scope) => !knownScopes.some((known) => known.scopeId === scope.scopeId)).map(synchronize)]);
    const nextSyncAt = Math.min(...scopes().map((scope) => scope.nextSyncAt || now + 60));
    return { complete: results.length ? results.every((result) => result.complete) : current.state === 'verified',
      accounts: results, nextSyncAt: Number.isFinite(nextSyncAt) ? nextSyncAt : now + 60 };
  }
  if (op === 'completeAccountLogin') {
    const appServer = (script) => accounts('loginRequest', { loginToken: args.loginToken, script });
    const status = await checkAccount(configPath(), { appServer,
      beforeConfirm: (binding) => accounts('loginRequest', { loginToken: args.loginToken, binding }),
      ...(args.expectedScopeId ? { expectedScopeId: args.expectedScopeId, activate: false } : {}) });
    if (status.state !== 'verified') throw new Error('登录的账号与所选账号不匹配');
    return status;
  }
  if (op === 'checkReminders') {
    // 每个账号独立执行核验、提醒前同步和发送；慢账号不占用其他账号的发送机会。
    const results = await Promise.all(enabledScopes().map(async (scope) => {
      try {
        if (readDb((db) => store.listDueUsageVerifications(db,
          Math.floor(Date.now() / 1000), 600, scope.scopeId)).length) {
          try { await protectedSync(configPath(), { accountScopeId: scope.scopeId }); }
          catch { /* 继续按账号身份核对和缓存提醒规则处理。 */ }
        }
        await verifiedScope(scope.scopeId);
        await preflightScope(scope);
        return await remindScope(scope);
      } catch { return { accountScopeId: scope.scopeId, due: [], unavailable: true }; }
    }));
    return { due: results.flatMap((result) => result.due), accounts: results };
  }
  if (op === 'runReminders') {
    const results = await Promise.all(enabledScopes().map(async (scope) => {
      try { await verifiedScope(scope.scopeId); return await remindScope(scope); }
      catch { return { accountScopeId: scope.scopeId, due: [], unavailable: true }; }
    }));
    return { due: results.flatMap((result) => result.due), accounts: results };
  }
  if (op === 'preflightSync') {
    const results = await Promise.all(enabledScopes().map(async (scope) => {
      try { await verifiedScope(scope.scopeId); return await preflightScope(scope); }
      catch { return { attempted: false, reason: 'account_unavailable', accountScopeId: scope.scopeId }; }
    }));
    return { attempted: results.some((result) => result.attempted), accounts: results };
  }
  if (op === 'handleCardAction') {
    let actionScopeId = null;
    return handleCardAction(args.event, args.config, {
      verifyCardAction: async (card) => { actionScopeId = card.accountScopeId;
        return requireCardInScope(card.id, await verifiedScope(actionScopeId)); },
      consume: consumeForCard,
      refreshStatus: () => refreshCreditStatus({ appServer: serverFor(actionScopeId),
        verifyAccount: () => verifiedScope(actionScopeId) }),
    });
  }
  if (op === 'checkAccount') return args.scopeId ? checkAccount(configPath(), {
    appServer: serverFor(args.scopeId), expectedScopeId: args.scopeId, activate: false }) : discoverCurrent();
  if (op === 'confirmLegacyBinding') return discoverCurrent({
    confirmLegacy: true, expectedCandidateToken: args.expectedCandidateToken });
  if (op === 'resetCardFromReminder') {
    const scopeId = accountForCard(args.cardId);
    return resetCardFromReminder(args, { verifyAccount: () => verifiedScope(scopeId), consume: consumeForCard });
  }
  if (op === 'pendingReminders') {
    const snapshot = args.all ? await recurse('allAccountsSnapshot') : await recurse('manageSnapshot', args);
    return { accountDisplay: snapshot.account.boundDisplay, cards: snapshot.cards.filter((card) => card.pendingReminder
      && (!args.cardId || card.id === args.cardId)).map((card) => ({
      creditId: card.id, originalCreditId: card.creditId, accountScopeId: card.accountScopeId,
      reviewOnly: true,
      accountDisplay: card.accountDisplay || snapshot.account.displayLabel || snapshot.account.boundDisplay,
      accountReady: card.accountReady ?? (snapshot.account.state === 'verified'
        && (!accounts || snapshot.account.independent)),
      cardName: card.title, source: card.source, expiresAt: card.expiresAt,
      expiresLocal: new Date(card.expiresAt * 1000).toLocaleString('zh-CN', { hour12: false }),
      currentAvailableCount: snapshot.confirmed?.availableCount ?? null,
      syncedAt: snapshot.confirmed?.checkedAt ?? null, ...card.pendingReminder,
    })) };
  }
  if (op === 'allAccountsSnapshot') {
    const snapshotBatch = await snapshotInputs();
    const snapshots = await Promise.all(snapshotBatch.accountScopes.map((scope) => runCoreOperation(
      'manageSnapshot', { scopeId: scope.scopeId }, { ...context, snapshotBatch })));
    return { account: { state: 'verified', boundDisplay: null }, accounts: snapshots.map((snapshot) => snapshot.account),
      cards: snapshots.flatMap((snapshot) => snapshot.cards.map((card) => ({ ...card,
        accountDisplay: snapshot.account.displayLabel || snapshot.account.boundDisplay,
        accountReady: snapshot.account.state === 'verified' && snapshot.account.remindersEnabled
          && (!accounts || snapshot.account.independent) }))) };
  }

  const snapshotBatch = op === 'manageSnapshot' ? context.snapshotBatch || await snapshotInputs() : null;

  const db = store.openStore();
  try {
    switch (op) {
      case 'manageSnapshot': {
        // 一次读取列表与提醒计划，界面沿用核心规则，不另算一套到期节点。
        const { config, scopeProfiles, accountScopes, labels, cards } = snapshotBatch;
        const channels = enabledChannels(config);
        const nowSeconds = Math.floor(Date.now() / 1000);
        const selected = args.scopeId ? store.getAccountScope(db, args.scopeId) : store.getActiveAccountScope(db);
        if (args.scopeId && !selected) throw new Error('账号不存在');
        const describe = (scope) => ({ ...accountStatus(db, scope.scopeId),
          displayLabel: labels.get(scope.scopeId), boundDisplay: labels.get(scope.scopeId),
          nickname: scope.nickname, remindersEnabled: Boolean(scope.remindersEnabled),
          nextSyncAt: scope.nextSyncAt, recovering: scope.syncFailures > 0,
          currentCli: scope.scopeId === store.currentCliScopeId(db),
          independent: scopeProfiles.get(scope.scopeId) === true,
          latest: store.latestSync(db, scope.scopeId),
          ...(accounts && !scopeProfiles.get(scope.scopeId) && store.currentCliScopeId(db)
            && scope.scopeId !== store.currentCliScopeId(db)
            ? { state: 'loginRequired' } : {}) });
        const account = selected ? describe(selected) : accountStatus(db);
        const boundScopeId = account.scopeId;
        const legacyUnbound = !store.getActiveAccountScope(db);
        const confirmed = boundScopeId || legacyUnbound
          ? store.latestCompleteSync(db, boundScopeId) : null;
        const options = { channels, quiet: quietHours(config), nowSeconds,
          completeSyncAt: confirmed?.checkedAt ?? 0 };
        const nodeIsCurrent = (card, snooze, result) => {
          if (card.status !== 'available' || card.expiresAt <= nowSeconds
            || result.expiresAt !== card.expiresAt || !channels.includes(result.channel)) return false;
          const days = dueThreshold(card.expiresAt, nowSeconds);
          if (result.nodeKind === 'fixed') return days === result.thresholdDays
            && !(snooze?.expiresAt === card.expiresAt && snooze.targetAt >= result.nodeAt);
          return snooze?.expiresAt === card.expiresAt && snooze.targetAt === result.nodeAt
            && nowSeconds >= deliveryTime(snooze.targetAt, card.expiresAt, options.quiet)
            && (days === null || snooze.targetAt >= card.expiresAt - days * 86400);
        };
        return { channels, latest: boundScopeId || legacyUnbound
          ? store.latestSync(db, boundScopeId) : null,
          confirmed, account, syncing: syncingAccounts.has(boundScopeId), accounts: accountScopes.map(describe),
          syncHistory: boundScopeId ? store.listSyncHistory(db, boundScopeId) : [],
          cards: cards.filter((card) => card.source === 'codex'
            && (legacyUnbound ? card.accountScopeId === null : card.accountScopeId === boundScopeId)).map((card) => {
            const snooze = store.getSnooze(db, card.id);
            const results = store.listReminderResults(db, card.id);
            return { ...card, snooze,
              pendingReminder: pendingReminder(card, snooze, results, nowSeconds),
              deliveryResults: results.map((result) => {
                const activeNode = nodeIsCurrent(card, snooze, result);
                const accountReady = account.state === 'verified' && account.remindersEnabled !== false;
                const retryOpen = activeNode && result.state === 'failed'
                  && result.attempts < maxReminderAttempts;
                return { ...result,
                  autoPending: retryOpen && accountReady && Boolean(result.nextRetryAt),
                  retryable: retryOpen && accountReady
                    && nowSeconds >= deliveryTime(nowSeconds, card.expiresAt, options.quiet),
                  suspendedReason: result.state !== 'failed' || result.attempts >= maxReminderAttempts ? null
                    : !activeNode ? '当前节点已结束或渠道已关闭，停止补发。'
                      : account.remindersEnabled === false ? '此账号提醒已暂停。'
                        : !accountReady ? 'Codex 账号待核实，暂停补发。' : null,
                };
              }),
              snoozeOptions: getSnoozeOptions(card, nowSeconds),
              plan: planCardNextCheck(db, card, options),
            };
          }) };
      }
      case 'selectAccount': {
        store.activateAccountScope(db, value(args.scopeId));
        return { selected: value(args.scopeId) };
      }
      case 'updateAccount': {
        store.updateAccountPreferences(db, value(args.scopeId), args);
        return { saved: true };
      }
      case 'listCards': {
        const boundScopeId = args.scopeId || accountStatus(db).scopeId;
        const legacyUnbound = !store.getActiveAccountScope(db);
        return store.listCards(db, args.includeInactive === true).filter((card) =>
          card.source === 'codex' && (legacyUnbound ? card.accountScopeId === null
            : card.accountScopeId === boundScopeId));
      }
      case 'getCard': {
        const boundScopeId = accountStatus(db).scopeId;
        const card = store.getCard(db, value(args.cardId));
        return card?.source === 'codex' && (store.getActiveAccountScope(db)
          ? card.accountScopeId === boundScopeId : card.accountScopeId === null) ? card : null;
      }
      case 'latestSync': return accountStatus(db).scopeId
        ? store.latestSync(db, accountStatus(db).scopeId) : null;
      case 'latestCompleteSync': return accountStatus(db).scopeId
        ? store.latestCompleteSync(db, accountStatus(db).scopeId) : null;
      case 'dueUsageVerifications': return store.listAccountScopes(db)
        .filter((scope) => accountStatus(db, scope.scopeId).state === 'verified')
        .flatMap((scope) => store.listDueUsageVerifications(db, Math.floor(Date.now() / 1000), 600, scope.scopeId)
          .map((card) => ({ ...card, accountScopeId: scope.scopeId })));
      case 'planNextCheck': {
        const config = JSON.parse(await readFile(configPath(), 'utf8'));
        const plans = store.listAccountScopes(db).filter((scope) => scope.remindersEnabled
          && accountStatus(db, scope.scopeId).state === 'verified').map((scope) => planNextCheck(db,
          { channels: enabledChannels(config), quiet: quietHours(config), accountScopeId: scope.scopeId }));
        return plans.filter((plan) => plan.nextAt).sort((a, b) => a.nextAt - b.nextAt)[0] || { nextAt: null, reason: null };
      }
      case 'snooze': return store.getSnooze(db, value(args.cardId));
      case 'scheduleSnooze': {
        let card = store.getCard(db, value(args.cardId));
        if (card?.source !== 'codex') throw new Error('只支持从 Codex 同步的官方重置卡');
        card = requireCardInScope(card.id, args.scopeId || selectedId());
        if (args.expectedExpiresAt !== undefined && card.expiresAt !== args.expectedExpiresAt)
          throw new Error('卡片已更新，请重新查看提醒');
        const plan = planSnooze(card, value(args.option));
        store.scheduleSnooze(db, card.id, card.expiresAt, plan.targetAt);
        return plan;
      }
      case 'clearSnooze': {
        const card = store.getCard(db, value(args.cardId));
        if (card?.source !== 'codex') throw new Error('只支持从 Codex 同步的官方重置卡');
        requireCardInScope(card.id, args.scopeId || selectedId());
        const snooze = card && store.getSnooze(db, card.id);
        if (card?.status !== 'available' || snooze?.expiresAt !== card.expiresAt) {
          throw new Error('这张卡片没有可取消的延期提醒');
        }
        store.clearSnooze(db, card.id);
        return { cleared: true };
      }
      default: throw new Error(`未知操作：${op}`);
    }
  } finally { db.close(); }
}
