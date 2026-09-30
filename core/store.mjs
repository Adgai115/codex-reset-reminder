import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { nextRetryAfter } from './delivery-retry.mjs';

// Data lives beside the project root (not core/) so the Windows PowerShell tasks,
// CLI entry points and any packaged desktop shell all read the same database.
// A desktop app overrides this via CODEX_RESET_MONITOR_DATA_DIR (e.g. userData).
export const dataDirectory = process.env.CODEX_RESET_MONITOR_DATA_DIR
  || join(dirname(fileURLToPath(import.meta.url)), '..', '.state');
export const databasePath = join(dataDirectory, 'data.db');

export function openStore() {
  mkdirSync(dataDirectory, { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('codex', 'manual')),
      title TEXT NOT NULL,
      granted_at INTEGER,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'used', 'not_available')),
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      reported_used_at INTEGER,
      reported_baseline_count INTEGER
    );
    CREATE INDEX IF NOT EXISTS cards_active_expiry ON cards(status, expires_at);
    CREATE TABLE IF NOT EXISTS account_scopes (
      scope_id TEXT NOT NULL UNIQUE,
      email_hash TEXT,
      workspace_hash TEXT,
      display_name TEXT NOT NULL,
      bound_at INTEGER NOT NULL,
      verified_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS reminder_deliveries (
      card_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      threshold_days INTEGER NOT NULL,
      channel TEXT NOT NULL,
      delivered_at INTEGER NOT NULL,
      PRIMARY KEY (card_id, expires_at, threshold_days, channel),
      FOREIGN KEY (card_id) REFERENCES cards(id)
    );
    CREATE TABLE IF NOT EXISTS reminder_attempts (
      card_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      node_kind TEXT NOT NULL CHECK (node_kind IN ('fixed', 'snooze')),
      node_at INTEGER NOT NULL,
      threshold_days INTEGER NOT NULL,
      channel TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      attempted_at INTEGER,
      succeeded_at INTEGER,
      next_retry_at INTEGER,
      error_code TEXT,
      error_text TEXT,
      PRIMARY KEY (card_id, expires_at, node_kind, node_at, channel),
      FOREIGN KEY (card_id) REFERENCES cards(id)
    );
    CREATE INDEX IF NOT EXISTS reminder_attempts_retry ON reminder_attempts(state, next_retry_at);
    CREATE TABLE IF NOT EXISTS sync_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checked_at INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      available_count INTEGER,
      detailed_count INTEGER,
      message TEXT
    );
    CREATE TABLE IF NOT EXISTS feishu_messages (
      message_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      threshold_days INTEGER NOT NULL,
      recipient_open_id TEXT NOT NULL,
      action_status TEXT NOT NULL DEFAULT 'available',
      sent_at INTEGER NOT NULL,
      FOREIGN KEY (card_id) REFERENCES cards(id)
    );
    CREATE TABLE IF NOT EXISTS card_action_events (
      event_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT,
      processed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS desktop_reset_requests (
      card_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      PRIMARY KEY (card_id, expires_at),
      FOREIGN KEY (card_id) REFERENCES cards(id)
    );
    CREATE TABLE IF NOT EXISTS snoozes (
      card_id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      target_at INTEGER NOT NULL,
      desktop_delivered_at INTEGER,
      feishu_delivered_at INTEGER,
      wechat_delivered_at INTEGER,
      FOREIGN KEY (card_id) REFERENCES cards(id)
    );
  `);
  const cardColumns = new Set(db.prepare('PRAGMA table_info(cards)').all().map((column) => column.name));
  if (!cardColumns.has('reported_used_at')) db.exec('ALTER TABLE cards ADD COLUMN reported_used_at INTEGER');
  if (!cardColumns.has('reported_baseline_count')) db.exec('ALTER TABLE cards ADD COLUMN reported_baseline_count INTEGER');
  if (!cardColumns.has('account_scope_id')) db.exec('ALTER TABLE cards ADD COLUMN account_scope_id TEXT');
  if (!cardColumns.has('credit_id')) {
    db.exec('ALTER TABLE cards ADD COLUMN credit_id TEXT');
    db.exec("UPDATE cards SET credit_id = id WHERE source = 'codex'");
  }
  const scopeColumns = new Set(db.prepare('PRAGMA table_info(account_scopes)').all().map((column) => column.name));
  if (scopeColumns.has('slot')) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE account_scopes_next (scope_id TEXT PRIMARY KEY, email_hash TEXT,
        workspace_hash TEXT, display_name TEXT NOT NULL, bound_at INTEGER NOT NULL,
        verified_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)));
      INSERT INTO account_scopes_next SELECT scope_id, email_hash, workspace_hash,
        display_name, bound_at, verified_at, 1 FROM account_scopes;
      DROP TABLE account_scopes;
      ALTER TABLE account_scopes_next RENAME TO account_scopes;
      COMMIT;`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS account_scopes_one_active ON account_scopes(active) WHERE active = 1');
  const currentScopeColumns = new Set(db.prepare('PRAGMA table_info(account_scopes)').all().map((column) => column.name));
  for (const [name, definition] of [['reminders_enabled', 'INTEGER NOT NULL DEFAULT 1'],
    ['nickname', 'TEXT'], ['next_sync_at', 'INTEGER'], ['sync_failures', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!currentScopeColumns.has(name)) db.exec(`ALTER TABLE account_scopes ADD COLUMN ${name} ${definition}`);
  }
  db.exec('CREATE TABLE IF NOT EXISTS account_state (name TEXT PRIMARY KEY, value TEXT)');
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS cards_scope_credit ON cards(account_scope_id, credit_id) WHERE source = 'codex' AND account_scope_id IS NOT NULL");
  const historyColumns = new Set(db.prepare('PRAGMA table_info(sync_history)').all().map((column) => column.name));
  if (!historyColumns.has('account_scope_id')) {
    db.exec('ALTER TABLE sync_history ADD COLUMN account_scope_id TEXT');
    const active = getActiveAccountScope(db);
    if (active) db.prepare('UPDATE sync_history SET account_scope_id = ? WHERE account_scope_id IS NULL').run(active.scopeId);
  }
  const snoozeColumns = new Set(db.prepare('PRAGMA table_info(snoozes)').all().map((column) => column.name));
  if (!snoozeColumns.has('wechat_delivered_at')) db.exec('ALTER TABLE snoozes ADD COLUMN wechat_delivered_at INTEGER');
  return db;
}

export function saveCodexSnapshot(db, resetCredits, checkedAt = Math.floor(Date.now() / 1000), scopeId = null) {
  const credits = resetCredits?.credits;
  const availableCount = resetCredits?.availableCount;
  if (!Number.isInteger(availableCount) || availableCount < 0) {
    throw new Error('Codex 未返回有效的重置卡数量');
  }
  if (credits != null && !Array.isArray(credits)) throw new Error('Codex 返回的重置卡详情格式无效');
  const rawRows = (credits || []).filter((credit) => credit?.status === 'available'
    && typeof credit.id === 'string' && credit.id.length > 0
    && Number.isInteger(credit.expiresAt));
  if (new Set(rawRows.map((credit) => credit.id)).size !== rawRows.length) throw new Error('Codex 返回了重复的卡片编号');
  const rows = rawRows.map((credit) => {
    if (!scopeId) return { ...credit, creditId: credit.id };
    const same = db.prepare("SELECT id FROM cards WHERE source = 'codex' AND account_scope_id = ? AND credit_id = ?").get(scopeId, credit.id);
    if (same) return { ...credit, creditId: credit.id, id: same.id };
    const existing = db.prepare('SELECT source, account_scope_id AS scopeId FROM cards WHERE id = ?').get(credit.id);
    if (existing && (!existing.scopeId || existing.source !== 'codex')) throw new Error('Codex 卡片归属账号不一致，已停止合并缓存');
    return { ...credit, creditId: credit.id, id: existing ? `codex:${scopeId}:${credit.id}` : credit.id };
  });
  const complete = Array.isArray(credits) && availableCount === credits.length && rows.length === credits.length;
  const detailMessage = credits == null ? `Codex 只返回 ${availableCount} 张的数量，未提供逐卡到期详情`
    : complete ? null : `Codex 返回 ${availableCount} 张可用卡，其中 ${rows.length} 张有有效到期详情`;
  const previousComplete = latestCompleteSync(db, scopeId);
  const seenIds = new Set(rows.map((credit) => credit.id));
  const newlyUsed = [];
  const noLongerAvailable = [];
  const upsert = db.prepare(`
    INSERT INTO cards (id, source, title, granted_at, expires_at, status, updated_at, last_seen_at, account_scope_id, credit_id)
    VALUES (?, 'codex', ?, ?, ?, 'available', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source = 'codex', title = excluded.title, granted_at = excluded.granted_at,
      expires_at = excluded.expires_at,
      status = CASE WHEN cards.status = 'used' THEN 'used' ELSE 'available' END,
      updated_at = excluded.updated_at, last_seen_at = excluded.last_seen_at,
      account_scope_id = COALESCE(excluded.account_scope_id, cards.account_scope_id)
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const credit of rows) {
      upsert.run(credit.id, credit.title || '重置卡', Number.isInteger(credit.grantedAt) ? credit.grantedAt : null,
        credit.expiresAt, checkedAt, checkedAt, scopeId, credit.creditId);
    }
    if (complete) {
      const missing = db.prepare(`SELECT id, expires_at AS expiresAt,
        reported_used_at AS reportedUsedAt, reported_baseline_count AS reportedBaselineCount
        FROM cards WHERE source = 'codex' AND status = 'available'
        ${scopeId ? 'AND account_scope_id = ?' : ''}`).all(...(scopeId ? [scopeId] : []));
      const setStatus = db.prepare("UPDATE cards SET status = ?, updated_at = ? WHERE id = ? AND status = 'available'");
      for (const card of missing) {
        if (seenIds.has(card.id)) continue;
        const confirmedUsed = card.expiresAt > checkedAt && card.reportedUsedAt !== null
          && Number.isInteger(card.reportedBaselineCount)
          && availableCount < card.reportedBaselineCount;
        setStatus.run(confirmedUsed ? 'used' : 'not_available', checkedAt, card.id);
        (confirmedUsed ? newlyUsed : noLongerAvailable).push(card.id);
      }
    }
    db.prepare('INSERT INTO sync_history (checked_at, outcome, available_count, detailed_count, message, account_scope_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(checkedAt, complete ? 'complete' : 'partial', availableCount, rows.length,
        detailMessage, scopeId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { availableCount, detailedCount: rows.length, complete, detailMessage,
    countDelta: previousComplete ? availableCount - previousComplete.availableCount : null,
    newlyUsed, noLongerAvailable };
}

export function recordSyncFailure(db, message, checkedAt = Math.floor(Date.now() / 1000), scopeId = null) {
  db.prepare('INSERT INTO sync_history (checked_at, outcome, message, account_scope_id) VALUES (?, ?, ?, ?)')
    .run(checkedAt, 'failed', String(message).slice(0, 300), scopeId);
}

export function listCards(db, includeInactive = false) {
  return db.prepare(`SELECT id, source, title, granted_at AS grantedAt, expires_at AS expiresAt,
    status, updated_at AS updatedAt, last_seen_at AS lastSeenAt,
    account_scope_id AS accountScopeId, COALESCE(credit_id, id) AS creditId,
    reported_used_at AS reportedUsedAt, reported_baseline_count AS reportedBaselineCount
    FROM cards ${includeInactive ? '' : "WHERE status = 'available'"} ORDER BY expires_at ASC`).all();
}

export function getCard(db, id) {
  return db.prepare(`SELECT id, source, title, granted_at AS grantedAt, expires_at AS expiresAt,
    status, updated_at AS updatedAt, last_seen_at AS lastSeenAt,
    account_scope_id AS accountScopeId, COALESCE(credit_id, id) AS creditId,
    reported_used_at AS reportedUsedAt, reported_baseline_count AS reportedBaselineCount
    FROM cards WHERE id = ?`).get(id) || null;
}

export function getActiveAccountScope(db) {
  return db.prepare(`SELECT scope_id AS scopeId, email_hash AS emailHash,
    workspace_hash AS workspaceHash, display_name AS displayName,
    bound_at AS boundAt, verified_at AS verifiedAt, active, nickname,
    reminders_enabled AS remindersEnabled, next_sync_at AS nextSyncAt, sync_failures AS syncFailures
    FROM account_scopes WHERE active = 1 LIMIT 1`).get() || null;
}

export function listAccountScopes(db) {
  return db.prepare(`SELECT scope_id AS scopeId, email_hash AS emailHash,
    workspace_hash AS workspaceHash, display_name AS displayName,
    bound_at AS boundAt, verified_at AS verifiedAt, active, nickname,
    reminders_enabled AS remindersEnabled, next_sync_at AS nextSyncAt, sync_failures AS syncFailures
    FROM account_scopes ORDER BY bound_at ASC`).all();
}

export const getAccountScope = (db, scopeId) => listAccountScopes(db).find((scope) => scope.scopeId === scopeId) || null;

export function currentCliScopeId(db) {
  return db.prepare("SELECT value FROM account_state WHERE name = 'current_cli_scope'").get()?.value || null;
}

export function noteCurrentCliScope(db, scopeId) {
  const previous = currentCliScopeId(db);
  const selected = getActiveAccountScope(db)?.scopeId;
  db.prepare("INSERT INTO account_state (name, value) VALUES ('current_cli_scope', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(scopeId);
  if (!selected || (previous && selected === previous && previous !== scopeId)) activateAccountScope(db, scopeId);
}

export function updateAccountPreferences(db, scopeId, { nickname, remindersEnabled } = {}) {
  const scope = getAccountScope(db, scopeId);
  if (!scope) throw new Error('账号不存在');
  const name = nickname === undefined ? scope.nickname : String(nickname).trim();
  if (name && (name.length > 30 || /[\r\n\t]/.test(name))) throw new Error('账号名称最多 30 字，不能换行');
  if (remindersEnabled !== undefined && typeof remindersEnabled !== 'boolean') throw new Error('提醒开关无效');
  db.prepare('UPDATE account_scopes SET nickname = ?, reminders_enabled = ? WHERE scope_id = ?')
    .run(name || null, remindersEnabled === undefined ? scope.remindersEnabled : Number(remindersEnabled), scopeId);
}

export function recordAccountSyncSchedule(db, scopeId, complete, nowSeconds = Math.floor(Date.now() / 1000)) {
  const scope = getAccountScope(db, scopeId);
  const failures = complete ? 0 : Math.min((scope?.syncFailures || 0) + 1, 3);
  const next = nowSeconds + (failures ? [60, 300, 900][failures - 1] : 900);
  db.prepare('UPDATE account_scopes SET next_sync_at = ?, sync_failures = ? WHERE scope_id = ?').run(next, failures, scopeId);
  return next;
}

export function listSyncHistory(db, scopeId, limit = 50) {
  return db.prepare(`SELECT checked_at AS checkedAt, outcome, available_count AS availableCount,
    detailed_count AS detailedCount, message FROM sync_history WHERE account_scope_id = ?
    ORDER BY checked_at DESC, id DESC LIMIT ?`).all(scopeId, limit);
}

export function activateAccountScope(db, scopeId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT 1 FROM account_scopes WHERE scope_id = ?').get(scopeId))
      throw new Error('账号不存在');
    db.prepare('UPDATE account_scopes SET active = 0 WHERE active = 1').run();
    db.prepare('UPDATE account_scopes SET active = 1 WHERE scope_id = ?').run(scopeId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function countCodexCards(db) {
  return db.prepare("SELECT COUNT(*) AS count FROM cards WHERE source = 'codex'")
    .get().count;
}

export function bindAccountScope(db, { scopeId, emailHash, workspaceHash, displayName,
  nowSeconds = Math.floor(Date.now() / 1000) }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const firstAccount = listAccountScopes(db).length === 0;
    db.prepare('UPDATE account_scopes SET active = 0 WHERE active = 1').run();
    db.prepare(`INSERT INTO account_scopes (scope_id, email_hash, workspace_hash,
      display_name, bound_at, verified_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .run(scopeId, emailHash, workspaceHash, displayName, nowSeconds, nowSeconds);
    if (firstAccount) {
      db.prepare("UPDATE cards SET account_scope_id = ? WHERE source = 'codex' AND account_scope_id IS NULL")
        .run(scopeId);
      db.prepare('UPDATE sync_history SET account_scope_id = ? WHERE account_scope_id IS NULL').run(scopeId);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function confirmAccountScope(db, { scopeId, emailHash, workspaceHash, displayName,
  nowSeconds = Math.floor(Date.now() / 1000) }) {
  db.prepare(`UPDATE account_scopes SET email_hash = ?, workspace_hash = ?,
    display_name = ?, verified_at = ? WHERE scope_id = ?`)
    .run(emailHash, workspaceHash, displayName, nowSeconds, scopeId);
}

export function reportCardUsed(db, id, reportedAt = Math.floor(Date.now() / 1000)) {
  const card = getCard(db, id);
  if (!card || card.source !== 'codex' || card.status !== 'available' || card.expiresAt <= reportedAt) {
    throw new Error('这张 Codex 重置卡已不可用');
  }
  const baseline = latestCompleteSync(db, card.accountScopeId)?.availableCount ?? null;
  db.prepare(`UPDATE cards SET reported_used_at = COALESCE(reported_used_at, ?),
    reported_baseline_count = COALESCE(reported_baseline_count, ?), updated_at = ? WHERE id = ?`)
    .run(reportedAt, baseline, reportedAt, id);
  return getCard(db, id);
}

export function listDueUsageVerifications(db, nowSeconds = Math.floor(Date.now() / 1000), delaySeconds = 600,
  scopeId = null) {
  return db.prepare(`SELECT c.id, c.reported_used_at AS reportedUsedAt
    FROM cards c
    WHERE c.source = 'codex' AND c.status = 'available' AND c.expires_at > ?
      AND (? IS NULL OR c.account_scope_id = ?)
      AND c.reported_used_at IS NOT NULL AND c.reported_used_at + ? <= ?
      AND NOT EXISTS (
        SELECT 1 FROM sync_history s
        WHERE s.outcome = 'complete' AND s.checked_at >= c.reported_used_at + ?
          AND (s.account_scope_id = c.account_scope_id OR (s.account_scope_id IS NULL AND c.account_scope_id IS NULL))
      )
    ORDER BY c.reported_used_at ASC`).all(nowSeconds, scopeId, scopeId,
    delaySeconds, nowSeconds, delaySeconds);
}

// 仅供测试构造旧版记录；正式界面、CLI、提醒调度均不再使用手动卡。
export function addManualCard(db, { title, expiresAt }) {
  if (typeof title !== 'string' || !title.trim() || !Number.isInteger(expiresAt) || expiresAt <= Date.now() / 1000) {
    throw new Error('请提供卡片名称和未来的到期时间');
  }
  const id = `manual:${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO cards (id, source, title, expires_at, status, updated_at) VALUES (?, 'manual', ?, ?, 'available', ?)")
    .run(id, title.trim(), expiresAt, now);
  return id;
}

export function markCardUsed(db, id) {
  return db.prepare("UPDATE cards SET status = 'used', updated_at = ? WHERE id = ? AND status = 'available'")
    .run(Math.floor(Date.now() / 1000), id).changes > 0;
}

export function markCardUnavailable(db, id) {
  return db.prepare("UPDATE cards SET status = 'not_available', updated_at = ? WHERE id = ? AND status = 'available'")
    .run(Math.floor(Date.now() / 1000), id).changes > 0;
}

export function recordFeishuMessage(db, { messageId, cardId, expiresAt, thresholdDays, recipientOpenId }) {
  if (!/^om_/.test(messageId || '') || !/^ou_/.test(recipientOpenId || '')) throw new Error('飞书消息或接收人编号无效');
  db.prepare(`INSERT OR IGNORE INTO feishu_messages
    (message_id, card_id, expires_at, threshold_days, recipient_open_id, sent_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(messageId, cardId, expiresAt, thresholdDays, recipientOpenId, Math.floor(Date.now() / 1000));
}

export function getFeishuMessage(db, messageId) {
  return db.prepare(`SELECT message_id AS messageId, card_id AS cardId, expires_at AS expiresAt,
    threshold_days AS thresholdDays, recipient_open_id AS recipientOpenId,
    action_status AS actionStatus, sent_at AS sentAt
    FROM feishu_messages WHERE message_id = ?`).get(messageId) || null;
}

export function listPendingFeishuConfirmations(db) {
  return db.prepare(`SELECT m.message_id AS messageId, m.card_id AS cardId,
    m.threshold_days AS thresholdDays
    FROM feishu_messages m JOIN cards c ON c.id = m.card_id
    WHERE m.action_status = 'pending_verification'`).all();
}

export function setFeishuMessageStatus(db, messageId, status) {
  if (!['available', 'used', 'snoozed', 'unavailable', 'choosing', 'pending_verification'].includes(status)) throw new Error('无效的飞书卡片状态');
  db.prepare('UPDATE feishu_messages SET action_status = ? WHERE message_id = ?')
    .run(status, messageId);
}

export function desktopResetKey(db, cardId, expiresAt, newKey) {
  db.prepare(`INSERT OR IGNORE INTO desktop_reset_requests
    (card_id, expires_at, idempotency_key, requested_at) VALUES (?, ?, ?, ?)`)
    .run(cardId, expiresAt, newKey, Math.floor(Date.now() / 1000));
  return db.prepare(`SELECT idempotency_key AS idempotencyKey FROM desktop_reset_requests
    WHERE card_id = ? AND expires_at = ?`).get(cardId, expiresAt).idempotencyKey;
}

export function clearDesktopResetKey(db, cardId, expiresAt, key) {
  db.prepare(`DELETE FROM desktop_reset_requests
    WHERE card_id = ? AND expires_at = ? AND idempotency_key = ?`).run(cardId, expiresAt, key);
}

export function claimCardActionEvent(db, eventId, messageId, action) {
  if (!eventId || !messageId || !action) return false;
  return db.prepare('INSERT OR IGNORE INTO card_action_events (event_id, message_id, action, processed_at) VALUES (?, ?, ?, ?)')
    .run(eventId, messageId, action, Math.floor(Date.now() / 1000)).changes > 0;
}

export function completeCardActionEvent(db, eventId, outcome) {
  db.prepare('UPDATE card_action_events SET outcome = ?, processed_at = ? WHERE event_id = ?')
    .run(outcome, Math.floor(Date.now() / 1000), eventId);
}

export function scheduleSnooze(db, cardId, expiresAt, targetAt) {
  if (!Number.isInteger(targetAt) || targetAt <= Math.floor(Date.now() / 1000) || targetAt >= expiresAt) {
    throw new Error('稍后提醒时间无效');
  }
  db.prepare(`INSERT INTO snoozes (card_id, expires_at, target_at)
    VALUES (?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET expires_at = excluded.expires_at,
    target_at = excluded.target_at, desktop_delivered_at = NULL, feishu_delivered_at = NULL,
    wechat_delivered_at = NULL`)
    .run(cardId, expiresAt, targetAt);
}

export function getSnooze(db, cardId) {
  return db.prepare(`SELECT card_id AS cardId, expires_at AS expiresAt, target_at AS targetAt,
    desktop_delivered_at AS desktopDeliveredAt, feishu_delivered_at AS feishuDeliveredAt,
    wechat_delivered_at AS wechatDeliveredAt
    FROM snoozes WHERE card_id = ?`).get(cardId) || null;
}

export function listDueSnoozes(db, nowSeconds = Math.floor(Date.now() / 1000)) {
  return db.prepare(`SELECT s.card_id AS cardId, s.expires_at AS expiresAt, s.target_at AS targetAt,
    s.desktop_delivered_at AS desktopDeliveredAt, s.feishu_delivered_at AS feishuDeliveredAt,
    s.wechat_delivered_at AS wechatDeliveredAt,
    c.source, c.title, c.status
    FROM snoozes s JOIN cards c ON c.id = s.card_id
    WHERE s.target_at <= ? AND c.status = 'available' AND c.expires_at = s.expires_at
      AND c.expires_at > ?
    ORDER BY s.target_at ASC`).all(nowSeconds, nowSeconds);
}

export function markSnoozeDelivered(db, cardId, channel) {
  if (!['desktop', 'feishu', 'wechat'].includes(channel)) throw new Error('无效的提醒渠道');
  db.prepare(`UPDATE snoozes SET ${channel}_delivered_at = ? WHERE card_id = ?`)
    .run(Math.floor(Date.now() / 1000), cardId);
}

export function clearSnooze(db, cardId) {
  db.prepare('DELETE FROM snoozes WHERE card_id = ?').run(cardId);
}

export function deliveryExists(db, id, expiresAt, days, channel) {
  return !!db.prepare('SELECT 1 FROM reminder_deliveries WHERE card_id = ? AND expires_at = ? AND threshold_days = ? AND channel = ?')
    .get(id, expiresAt, days, channel);
}

export function recordDelivery(db, id, expiresAt, days, channel) {
  db.prepare('INSERT OR IGNORE INTO reminder_deliveries (card_id, expires_at, threshold_days, channel, delivered_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, expiresAt, days, channel, Math.floor(Date.now() / 1000));
}

export function getReminderAttempt(db, { cardId, expiresAt, nodeKind, nodeAt, channel }) {
  return db.prepare(`SELECT card_id AS cardId, expires_at AS expiresAt, node_kind AS nodeKind,
    node_at AS nodeAt, threshold_days AS thresholdDays, channel, state, attempts,
    attempted_at AS attemptedAt, succeeded_at AS succeededAt,
    next_retry_at AS nextRetryAt, error_code AS errorCode, error_text AS errorText
    FROM reminder_attempts WHERE card_id = ? AND expires_at = ? AND node_kind = ? AND node_at = ? AND channel = ?`)
    .get(cardId, expiresAt, nodeKind, nodeAt, channel) || null;
}

export function beginReminderAttempt(db, node, channel, attemptedAt) {
  const previous = getReminderAttempt(db, { ...node, channel });
  const attempts = (previous?.attempts ?? 0) + 1;
  const plannedRetry = nextRetryAfter(attempts, attemptedAt);
  db.prepare(`INSERT INTO reminder_attempts (card_id, expires_at, node_kind, node_at,
    threshold_days, channel, state, attempts, attempted_at, next_retry_at)
    VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?)
    ON CONFLICT(card_id, expires_at, node_kind, node_at, channel) DO UPDATE SET
      state = 'sending', attempts = excluded.attempts,
      attempted_at = excluded.attempted_at, next_retry_at = excluded.next_retry_at,
      error_code = NULL, error_text = NULL`)
    .run(node.cardId, node.expiresAt, node.nodeKind, node.nodeAt, node.thresholdDays,
      channel, attempts, attemptedAt, plannedRetry < node.expiresAt ? plannedRetry : null);
  return attempts;
}

export function recordReminderResult(db, node, channel, { state, attemptedAt, nextRetryAt = null,
  errorCode = null, errorText = null }) {
  if (!['sent', 'failed'].includes(state)) throw new Error('无效的提醒发送结果');
  db.prepare(`INSERT INTO reminder_attempts (card_id, expires_at, node_kind, node_at,
    threshold_days, channel, state, attempts, attempted_at, succeeded_at, next_retry_at,
    error_code, error_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(card_id, expires_at, node_kind, node_at, channel) DO UPDATE SET
      state = excluded.state,
      attempts = CASE WHEN reminder_attempts.state = 'sending' THEN reminder_attempts.attempts
        ELSE reminder_attempts.attempts + 1 END,
      attempted_at = excluded.attempted_at, succeeded_at = excluded.succeeded_at,
      next_retry_at = excluded.next_retry_at, error_code = excluded.error_code,
      error_text = excluded.error_text`)
    .run(node.cardId, node.expiresAt, node.nodeKind, node.nodeAt, node.thresholdDays,
      channel, state, attemptedAt, state === 'sent' ? attemptedAt : null, nextRetryAt,
      errorCode, errorText);
}

export function listReminderResults(db, cardId) {
  const attempts = db.prepare(`SELECT card_id AS cardId, expires_at AS expiresAt,
    node_kind AS nodeKind, node_at AS nodeAt, threshold_days AS thresholdDays, channel,
    state, attempts, attempted_at AS attemptedAt, succeeded_at AS succeededAt,
    next_retry_at AS nextRetryAt, error_code AS errorCode, error_text AS errorText
    FROM reminder_attempts WHERE card_id = ? ORDER BY node_at DESC, attempted_at DESC`).all(cardId);
  const oldDeliveries = db.prepare(`SELECT d.card_id AS cardId, d.expires_at AS expiresAt,
    CASE WHEN d.threshold_days = 0 THEN 'snooze' ELSE 'fixed' END AS nodeKind,
    CASE WHEN d.threshold_days = 0 THEN COALESCE(s.target_at, d.delivered_at)
      ELSE d.expires_at - d.threshold_days * 86400 END AS nodeAt,
    d.threshold_days AS thresholdDays, d.channel, d.delivered_at AS attemptedAt
    FROM reminder_deliveries d LEFT JOIN snoozes s ON s.card_id = d.card_id
      AND s.expires_at = d.expires_at
    WHERE d.card_id = ? AND NOT EXISTS (
      SELECT 1 FROM reminder_attempts a WHERE a.card_id = d.card_id
        AND a.expires_at = d.expires_at AND a.threshold_days = d.threshold_days
        AND a.channel = d.channel)
    ORDER BY d.delivered_at DESC`).all(cardId);
  return [...attempts, ...oldDeliveries.map((row) => ({ ...row, state: 'sent',
    attempts: 1, succeededAt: row.attemptedAt, nextRetryAt: null,
    errorCode: null, errorText: null }))]
    .sort((a, b) => b.nodeAt - a.nodeAt || b.attemptedAt - a.attemptedAt);
}

export function latestSync(db, scopeId = null) {
  return db.prepare(`SELECT checked_at AS checkedAt, outcome, available_count AS availableCount,
    detailed_count AS detailedCount, message FROM sync_history
    WHERE (? IS NULL OR account_scope_id = ?) ORDER BY checked_at DESC, id DESC LIMIT 1`)
    .get(scopeId, scopeId) || null;
}

export function latestCompleteSync(db, scopeId = null) {
  return db.prepare(`SELECT checked_at AS checkedAt, outcome, available_count AS availableCount,
    detailed_count AS detailedCount FROM sync_history WHERE outcome = 'complete'
    AND (? IS NULL OR account_scope_id = ?) ORDER BY checked_at DESC, id DESC LIMIT 1`)
    .get(scopeId, scopeId) || null;
}
