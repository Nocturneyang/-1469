const { openWorkbenchDb } = require('../db/workbench-db');

const DEFAULT_STALE_SENDING_MS = 60 * 1000;
const DEFAULT_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

function createOutboundConsumer({
  db,
  dbPath,
  platform,
  account,
  sendMessage,
  staleSendingMs = DEFAULT_STALE_SENDING_MS,
  failureWindowMs = DEFAULT_FAILURE_WINDOW_MS,
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
} = {}) {
  if (!platform) throw new Error('platform is required');
  if (!account) throw new Error('account is required');
  if (typeof sendMessage !== 'function') throw new Error('sendMessage function is required');
  const ownedDb = db ? null : openWorkbenchDb(dbPath);
  const workbenchDb = db || ownedDb;

  async function runOnce() {
    recoverStaleSending(workbenchDb, { platform, account, staleSendingMs });
    const breaker = activeBreaker(workbenchDb, platform, account);
    if (breaker) {
      const paused = pausePendingForBreaker(workbenchDb, { platform, account, reason: breaker.reason || 'account cooldown' });
      return { status: 'paused', paused, breaker };
    }

    const outbound = claimNextPending(workbenchDb, { platform, account });
    if (!outbound) return { status: 'idle' };

    try {
      const result = await sendMessage(mapOutboundTask(outbound));
      markSent(workbenchDb, outbound.id, result || {});
      return { status: 'sent', outbound_id: outbound.id, remote_msg_id: result && result.remote_msg_id };
    } catch (err) {
      const failure = markFailed(workbenchDb, outbound, err, {
        failureWindowMs,
        failureThreshold,
        cooldownMs,
      });
      return { status: 'failed', outbound_id: outbound.id, breaker: failure.breaker };
    }
  }

  function close() {
    if (ownedDb) ownedDb.close();
  }

  return { close, runOnce };
}

function recoverStaleSending(db, { platform, account, staleSendingMs = DEFAULT_STALE_SENDING_MS }) {
  const cutoff = toSqlTimestamp(Date.now() - staleSendingMs);
  return db.prepare(`
    UPDATE outbound_messages
    SET status = 'pending',
        error_code = 'STALE_SENDING_RECOVERED',
        error_message = 'Recovered stale sending task after worker restart',
        sending_started_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE platform = @platform
      AND account = @account
      AND status = 'sending'
      AND sending_started_at IS NOT NULL
      AND sending_started_at < @cutoff
  `).run({ platform, account, cutoff }).changes;
}

function claimNextPending(db, { platform, account }) {
  const tx = db.transaction(() => {
    const outbound = db.prepare(`
      SELECT *
      FROM outbound_messages
      WHERE platform = @platform
        AND account = @account
        AND status = 'pending'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get({ platform, account });
    if (!outbound) return null;
    const result = db.prepare(`
      UPDATE outbound_messages
      SET status = 'sending',
          sending_started_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id AND status = 'pending'
    `).run({ id: outbound.id });
    return result.changes ? db.prepare('SELECT * FROM outbound_messages WHERE id = ?').get(outbound.id) : null;
  });
  return tx();
}

function markSent(db, outboundId, result = {}) {
  db.prepare(`
    UPDATE outbound_messages
    SET status = 'sent',
        remote_msg_id = COALESCE(@remoteMsgId, remote_msg_id),
        error_code = NULL,
        error_message = NULL,
        sent_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @outboundId AND status = 'sending'
  `).run({
    outboundId,
    remoteMsgId: result.remote_msg_id || result.message_id || null,
  });
}

function markFailed(db, outbound, err, options = {}) {
  const errorCode = String(err && (err.code || err.name) || 'SEND_FAILED');
  const errorMessage = String(err && err.message || 'send failed').slice(0, 1000);
  db.prepare(`
    UPDATE outbound_messages
    SET status = 'failed',
        error_code = @errorCode,
        error_message = @errorMessage,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({ id: outbound.id, errorCode, errorMessage });

  const breaker = recordSendFailure(db, outbound.platform, outbound.account, {
    reason: `${errorCode}: ${errorMessage}`,
    failureWindowMs: options.failureWindowMs,
    failureThreshold: options.failureThreshold,
    cooldownMs: options.cooldownMs,
  });
  return { breaker };
}

function recordSendFailure(db, platform, account, {
  reason,
  failureWindowMs = DEFAULT_FAILURE_WINDOW_MS,
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
} = {}) {
  const windowStart = toSqlTimestamp(Date.now() - failureWindowMs);
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM outbound_messages
    WHERE platform = @platform
      AND account = @account
      AND status = 'failed'
      AND updated_at >= @windowStart
  `).get({ platform, account, windowStart });
  const failureCount = row ? Number(row.count || 0) : 0;
  const cooldownUntil = toSqlTimestamp(Date.now() + cooldownMs);
  const status = failureCount >= failureThreshold ? 'cooldown' : 'open';

  db.prepare(`
    INSERT INTO send_circuit_breaker (
      platform, account, status, reason, failure_count, cooldown_until, last_failure_at, updated_at
    )
    VALUES (
      @platform, @account, @status, @reason, @failureCount, @cooldownUntil, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(platform, account) DO UPDATE SET
      status = excluded.status,
      reason = excluded.reason,
      failure_count = excluded.failure_count,
      cooldown_until = excluded.cooldown_until,
      last_failure_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    platform,
    account,
    status,
    reason: reason || 'send failure',
    failureCount,
    cooldownUntil: status === 'cooldown' ? cooldownUntil : null,
  });

  return activeBreaker(db, platform, account);
}

function pausePendingForBreaker(db, { platform, account, reason }) {
  return db.prepare(`
    UPDATE outbound_messages
    SET status = 'paused',
        error_code = 'CIRCUIT_BREAKER',
        error_message = @reason,
        updated_at = CURRENT_TIMESTAMP
    WHERE platform = @platform
      AND account = @account
      AND status = 'pending'
  `).run({ platform, account, reason }).changes;
}

function activeBreaker(db, platform, account) {
  return db.prepare(`
    SELECT *
    FROM send_circuit_breaker
    WHERE platform = @platform
      AND account = @account
      AND status = 'cooldown'
      AND (cooldown_until IS NULL OR cooldown_until > CURRENT_TIMESTAMP)
  `).get({ platform, account });
}

function mapOutboundTask(row) {
  return {
    id: row.id,
    client_msg_id: row.client_msg_id,
    platform: row.platform,
    account: row.account,
    group_id: row.group_id,
    chat_id: row.chat_id || row.group_id,
    text: row.text,
    quote_msg_id: row.quote_msg_id,
    attachment_json: row.attachment_json,
    retry_of: row.retry_of,
    retry_count: row.retry_count,
  };
}

function toSqlTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = {
  activeBreaker,
  claimNextPending,
  createOutboundConsumer,
  markFailed,
  markSent,
  pausePendingForBreaker,
  recoverStaleSending,
  recordSendFailure,
  toSqlTimestamp,
};
