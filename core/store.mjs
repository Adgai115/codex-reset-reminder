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
  const snoozeColumns = new Set(db.prepare('PRAGMA table_info(snoozes)').all().map((column) => column.name));
  if (!snoozeColumns.has('wechat_delivered_at')) db.exec('ALTER TABLE snoozes ADD COLUMN wechat_delivered_at INTEGER');
  return db;
}

export function saveCodexSnapshot(db, resetCredits, checkedAt = Math.floor(Date.now() / 1000)) {
  const credits = resetCredits?.credits;
  const availableCount = resetCredits?.availableCount;
  if (!Number.isInteger(availableCount) || !Array.isArray(credits)) {
    throw new Error('Codex 未返回可用重置卡的完整到期详情');
  }
  const rows = credits.filter((credit) => credit?.status === 'available'
    && typeof credit.id === 'string' && credit.id.length > 0
    && Number.isInteger(credit.expiresAt));
  const complete = availableCount === credits.length && rows.length === credits.length;
  const previousComplete = latestCompleteSync(db);
  const seenIds = new Set(rows.map((credit) => credit.id));
  const newlyUsed = [];
  const noLongerAvailable = [];
  const upsert = db.prepare(`
    INSERT INTO cards (id, source, title, granted_at, expires_at, status, updated_at, last_seen_at)
    VALUES (?, 'codex', ?, ?, ?, 'available', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source = 'codex', title = excluded.title, granted_at = excluded.granted_at,
      expires_at = excluded.expires_at,
      status = CASE WHEN cards.status = 'used' THEN 'used' ELSE 'available' END,
      updated_at = excluded.updated_at, last_seen_at = excluded.last_seen_at
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const credit of rows) {
      upsert.run(credit.id, credit.title || '重置卡', Number.isInteger(credit.grantedAt) ? credit.grantedAt : null,
        credit.expiresAt, checkedAt, checkedAt);
    }
    if (complete) {
      const missing = db.prepare("SELECT id, expires_at AS expiresAt, reported_used_at AS reportedUsedAt, reported_baseline_count AS reportedBaselineCount FROM cards WHERE source = 'codex' AND status = 'available'").all();
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
    db.prepare('INSERT INTO sync_history (checked_at, outcome, available_count, detailed_count, message) VALUES (?, ?, ?, ?, ?)')
      .run(checkedAt, complete ? 'complete' : 'partial', availableCount, rows.length,
        complete ? null : '只返回部分卡片详情；保留此前缓存的卡片');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { availableCount, detailedCount: rows.length, complete,
    countDelta: previousComplete ? availableCount - previousComplete.availableCount : null,
    newlyUsed, noLongerAvailable };
}

export function recordSyncFailure(db, message, checkedAt = Math.floor(Date.now() / 1000)) {
  db.prepare('INSERT INTO sync_history (checked_at, outcome, message) VALUES (?, ?, ?)')
    .run(checkedAt, 'failed', String(message).slice(0, 300));
}

export function listCards(db, includeInactive = false) {
  return db.prepare(`SELECT id, source, title, granted_at AS grantedAt, expires_at AS expiresAt,
    status, updated_at AS updatedAt, last_seen_at AS lastSeenAt,
    reported_used_at AS reportedUsedAt, reported_baseline_count AS reportedBaselineCount
    FROM cards ${includeInactive ? '' : "WHERE status = 'available'"} ORDER BY expires_at ASC`).all();
}

export function getCard(db, id) {
  return db.prepare(`SELECT id, source, title, granted_at AS grantedAt, expires_at AS expiresAt,
    status, updated_at AS updatedAt, last_seen_at AS lastSeenAt,
    reported_used_at AS reportedUsedAt, reported_baseline_count AS reportedBaselineCount
    FROM cards WHERE id = ?`).get(id) || null;
}

export function reportCardUsed(db, id, reportedAt = Math.floor(Date.now() / 1000)) {
  const card = getCard(db, id);
  if (!card || card.source !== 'codex' || card.status !== 'available' || card.expiresAt <= reportedAt) {
    throw new Error('这张 Codex 重置卡已不可用');
  }
  const baseline = latestCompleteSync(db)?.availableCount ?? null;
  db.prepare(`UPDATE cards SET reported_used_at = COALESCE(reported_used_at, ?),
    reported_baseline_count = COALESCE(reported_baseline_count, ?), updated_at = ? WHERE id = ?`)
    .run(reportedAt, baseline, reportedAt, id);
  return getCard(db, id);
}

export function listDueUsageVerifications(db, nowSeconds = Math.floor(Date.now() / 1000), delaySeconds = 600) {
  return db.prepare(`SELECT c.id, c.reported_used_at AS reportedUsedAt
    FROM cards c
    WHERE c.source = 'codex' AND c.status = 'available' AND c.expires_at > ?
      AND c.reported_used_at IS NOT NULL AND c.reported_used_at + ? <= ?
      AND NOT EXISTS (
        SELECT 1 FROM sync_history s
        WHERE s.outcome = 'complete' AND s.checked_at >= c.reported_used_at + ?
      )
    ORDER BY c.reported_used_at ASC`).all(nowSeconds, delaySeconds, nowSeconds, delaySeconds);
}

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

export function updateManualCard(db, id, { title, expiresAt }) {
  if (!id?.startsWith('manual:') || typeof title !== 'string' || !title.trim()
    || !Number.isInteger(expiresAt) || expiresAt <= Date.now() / 1000) {
    throw new Error('请提供手动卡片编号、名称和未来到期时间');
  }
  return db.prepare("UPDATE cards SET title = ?, expires_at = ?, status = 'available', updated_at = ? WHERE id = ? AND source = 'manual'")
    .run(title.trim(), expiresAt, Math.floor(Date.now() / 1000), id).changes > 0;
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

export function latestSync(db) {
  return db.prepare('SELECT checked_at AS checkedAt, outcome, available_count AS availableCount, detailed_count AS detailedCount, message FROM sync_history ORDER BY checked_at DESC, id DESC LIMIT 1').get() || null;
}

export function latestCompleteSync(db) {
  return db.prepare("SELECT checked_at AS checkedAt, outcome, available_count AS availableCount, detailed_count AS detailedCount FROM sync_history WHERE outcome = 'complete' ORDER BY checked_at DESC, id DESC LIMIT 1").get() || null;
}
