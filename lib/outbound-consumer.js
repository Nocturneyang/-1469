const os = require('os');
const { openWorkbenchDb } = require('../db/workbench-db');

const DEFAULT_STALE_SENDING_MS = 60 * 1000;
const DEFAULT_SEND_LEASE_MS = 45 * 1000;
const DEFAULT_SEND_LEASE_RENEW_MS = 15 * 1000;
const DEFAULT_MAX_AUTOMATIC_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 5 * 60 * 1000;
const DEFAULT_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const NON_RETRYABLE_CODES = new Set([
  'ATTACHMENT_INVALID',
  'ATTACHMENT_DATA_INVALID',
  'CHAT_NOT_FOUND',
  'PEER_ID_INVALID',
  'MESSAGE_ID_INVALID',
  'MENTION_ID_INVALID',
]);

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
  minIntervalMs = platform === 'wa' ? 2500 : 1000,
  perMinuteLimit = platform === 'wa' ? 20 : 30,
  workerId = `${os.hostname()}-${process.pid}-${platform}-${account}`,
  leaseMs = DEFAULT_SEND_LEASE_MS,
  leaseRenewMs = DEFAULT_SEND_LEASE_RENEW_MS,
  maxAutomaticRetries = DEFAULT_MAX_AUTOMATIC_RETRIES,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
} = {}) {
  if (!platform) throw new Error('platform is required');
  if (!account) throw new Error('account is required');
  if (typeof sendMessage !== 'function') throw new Error('sendMessage function is required');
  const ownedDb = db ? null : openWorkbenchDb(dbPath);
  const workbenchDb = db || ownedDb;
  let lastAttemptAt = 0;
  const recentAttempts = [];
  let activeRun = null;

  async function runOnce(options = {}) {
    if (activeRun) return activeRun;
    activeRun = runOnceInternal(options);
    try {
      return await activeRun;
    } finally {
      activeRun = null;
    }
  }

  async function runOnceInternal(options = {}) {
    recoverStaleSending(workbenchDb, { platform, account, staleSendingMs });
    const breaker = activeBreaker(workbenchDb, platform, account);
    if (breaker) {
      const paused = pausePendingForBreaker(workbenchDb, { platform, account, reason: breaker.reason || 'account cooldown' });
      return { status: 'paused', paused, breaker };
    }

    const retryAfterMs = nextSendDelay({ lastAttemptAt, recentAttempts, minIntervalMs, perMinuteLimit });
    if (retryAfterMs > 0) return { status: 'rate_limited', retry_after_ms: retryAfterMs };

    const outboundId = normalizeOutboundId(options.outboundId);
    const outbound = outboundId
      ? claimPendingById(workbenchDb, { platform, account, outboundId, workerId, leaseMs })
      : claimNextPending(workbenchDb, { platform, account, workerId, leaseMs });
    if (!outbound) return { status: 'idle' };
    lastAttemptAt = Date.now();
    recentAttempts.push(lastAttemptAt);

    const renewTimer = setInterval(() => {
      renewSendingLease(workbenchDb, { outboundId: outbound.id, workerId, leaseMs });
    }, Math.max(1000, Math.min(leaseRenewMs, Math.floor(leaseMs / 2))));
    renewTimer.unref?.();
    try {
      const result = await sendMessage(mapOutboundTask(outbound));
      markSent(workbenchDb, outbound.id, result || {}, { workerId, attemptId: outbound.attempt_id });
      return { status: 'sent', outbound_id: outbound.id, remote_msg_id: result && result.remote_msg_id };
    } catch (err) {
      const failure = markFailed(workbenchDb, outbound, err, {
        failureWindowMs,
        failureThreshold,
        cooldownMs,
        maxAutomaticRetries,
        retryBaseMs,
        retryMaxMs,
      });
      return {
        status: failure.status || 'failed',
        outbound_id: outbound.id,
        breaker: failure.breaker,
        retry_after_ms: failure.retryAfterMs || 0,
      };
    } finally {
      clearInterval(renewTimer);
    }
  }

  async function drainCurrent(timeoutMs = 30000) {
    if (!activeRun) return true;
    let timer;
    try {
      return await Promise.race([
        activeRun.then(() => true, () => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(1, Number(timeoutMs) || 30000));
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function close() {
    if (ownedDb) ownedDb.close();
  }

  return { close, drainCurrent, runOnce };
}

function recoverStaleSending(db, { platform, account, staleSendingMs = DEFAULT_STALE_SENDING_MS }) {
  const cutoff = toSqlTimestamp(Date.now() - staleSendingMs);
  const recoveredKnown = db.prepare(`
    UPDATE outbound_messages
    SET status = 'sent',
        error_code = 'STALE_SENDING_REMOTE_CONFIRMED',
        error_message = 'Worker restarted after channel returned a remote message id',
        sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP),
        sending_started_at = NULL,
        owner_worker_id = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE platform = @platform
      AND account = @account
      AND status = 'sending'
      AND remote_msg_id IS NOT NULL
      AND (
        (lease_expires_at IS NOT NULL AND lease_expires_at < CURRENT_TIMESTAMP)
        OR (lease_expires_at IS NULL AND sending_started_at IS NOT NULL AND sending_started_at < @cutoff)
      )
  `).run({ platform, account, cutoff }).changes;
  const recoveredUnknown = db.prepare(`
    UPDATE outbound_messages
    SET status = 'paused',
        error_code = 'DELIVERY_OUTCOME_UNKNOWN',
        error_message = 'Worker stopped before the channel result was recorded; verify before retrying',
        sending_started_at = NULL,
        owner_worker_id = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE platform = @platform
      AND account = @account
      AND status = 'sending'
      AND remote_msg_id IS NULL
      AND (
        (lease_expires_at IS NOT NULL AND lease_expires_at < CURRENT_TIMESTAMP)
        OR (lease_expires_at IS NULL AND sending_started_at IS NOT NULL AND sending_started_at < @cutoff)
      )
  `).run({ platform, account, cutoff }).changes;
  if (recoveredUnknown > 0) {
    try {
      db.prepare(`
        INSERT INTO agent_actions (operator_id, action_type, platform, account, payload_json)
        VALUES ('system', 'outbound.delivery_unknown', @platform, @account, @payload)
      `).run({ platform, account, payload: JSON.stringify({ recovered: recoveredUnknown }) });
    } catch (_) {}
  }
  return recoveredKnown + recoveredUnknown;
}

function claimPendingById(db, {
  platform,
  account,
  outboundId,
  workerId = `${os.hostname()}-${process.pid}`,
  leaseMs = DEFAULT_SEND_LEASE_MS,
}) {
  const id = normalizeOutboundId(outboundId);
  if (!id) return null;
  const tx = db.transaction(() => {
    const outbound = db.prepare(`
      SELECT *
      FROM outbound_messages
      WHERE id = @id
        AND platform = @platform
        AND account = @account
        AND status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
      LIMIT 1
    `).get({ id, platform, account });
    if (!outbound) return null;
    const result = db.prepare(`
      UPDATE outbound_messages
      SET status = 'sending',
          sending_started_at = CURRENT_TIMESTAMP,
          owner_worker_id = @workerId,
          lease_expires_at = @leaseExpiresAt,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
        AND platform = @platform
        AND account = @account
        AND status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
    `).run({ id, platform, account, workerId, leaseExpiresAt: toSqlTimestamp(Date.now() + leaseMs) });
    if (!result.changes) return null;
    const attemptNumber = Number(db.prepare(`
      SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt
      FROM outbound_attempts WHERE outbound_id = ?
    `).get(id)?.next_attempt || 1);
    const attempt = db.prepare(`
      INSERT INTO outbound_attempts (
        outbound_id, attempt_number, worker_id, status, lease_expires_at
      ) VALUES (?, ?, ?, 'attempting', ?)
    `).run(id, attemptNumber, workerId, toSqlTimestamp(Date.now() + leaseMs));
    const claimed = db.prepare('SELECT * FROM outbound_messages WHERE id = ?').get(id);
    return { ...claimed, attempt_id: Number(attempt.lastInsertRowid), attempt_number: attemptNumber };
  });
  return tx();
}

function claimNextPending(db, { platform, account, workerId = `${os.hostname()}-${process.pid}`, leaseMs = DEFAULT_SEND_LEASE_MS }) {
  const tx = db.transaction(() => {
    const outbound = db.prepare(`
      SELECT *
      FROM outbound_messages
      WHERE platform = @platform
        AND account = @account
        AND status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get({ platform, account });
    if (!outbound) return null;
    const result = db.prepare(`
      UPDATE outbound_messages
      SET status = 'sending',
          sending_started_at = CURRENT_TIMESTAMP,
          owner_worker_id = @workerId,
          lease_expires_at = @leaseExpiresAt,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id AND status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
    `).run({ id: outbound.id, workerId, leaseExpiresAt: toSqlTimestamp(Date.now() + leaseMs) });
    if (!result.changes) return null;
    const attemptNumber = Number(db.prepare(`
      SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt
      FROM outbound_attempts WHERE outbound_id = ?
    `).get(outbound.id)?.next_attempt || 1);
    const attempt = db.prepare(`
      INSERT INTO outbound_attempts (
        outbound_id, attempt_number, worker_id, status, lease_expires_at
      ) VALUES (?, ?, ?, 'attempting', ?)
    `).run(outbound.id, attemptNumber, workerId, toSqlTimestamp(Date.now() + leaseMs));
    const claimed = db.prepare('SELECT * FROM outbound_messages WHERE id = ?').get(outbound.id);
    return { ...claimed, attempt_id: Number(attempt.lastInsertRowid), attempt_number: attemptNumber };
  });
  return tx();
}

function normalizeOutboundId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function renewSendingLease(db, { outboundId, workerId, leaseMs = DEFAULT_SEND_LEASE_MS }) {
  const leaseExpiresAt = toSqlTimestamp(Date.now() + leaseMs);
  const changed = db.prepare(`
    UPDATE outbound_messages
    SET lease_expires_at = @leaseExpiresAt, updated_at = CURRENT_TIMESTAMP
    WHERE id = @outboundId AND status = 'sending' AND owner_worker_id = @workerId
  `).run({ outboundId, workerId, leaseExpiresAt }).changes;
  if (changed) {
    db.prepare(`
      UPDATE outbound_attempts SET lease_expires_at = @leaseExpiresAt
      WHERE outbound_id = @outboundId AND worker_id = @workerId AND status = 'attempting'
    `).run({ outboundId, workerId, leaseExpiresAt });
  }
  return changed;
}

function markSent(db, outboundId, result = {}, { workerId = null, attemptId = null } = {}) {
  const remoteMsgId = result.remote_msg_id || result.message_id || null;
  const save = db.transaction(() => {
    const changed = db.prepare(`
      UPDATE outbound_messages
      SET status = 'sent',
          remote_msg_id = COALESCE(@remoteMsgId, remote_msg_id),
          error_code = NULL,
          error_message = NULL,
          sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP),
          sending_started_at = NULL,
          owner_worker_id = NULL,
          lease_expires_at = NULL,
          next_attempt_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @outboundId AND status = 'sending'
        AND (@workerId IS NULL OR owner_worker_id = @workerId)
    `).run({ outboundId, remoteMsgId, workerId }).changes;
    if (attemptId) {
      db.prepare(`
        UPDATE outbound_attempts
        SET status = 'sent', remote_msg_id = @remoteMsgId, completed_at = CURRENT_TIMESTAMP
        WHERE id = @attemptId
      `).run({ attemptId, remoteMsgId });
    }
    return changed;
  });
  return save();
}

function markFailed(db, outbound, err, options = {}) {
  const errorCode = String(err && (err.code || err.name) || 'SEND_FAILED');
  const errorMessage = String(err && err.message || 'send failed').slice(0, 1000);
  const rateLimit = classifyTelegramRateLimit(errorCode, errorMessage);
  if (rateLimit) {
    return pauseForRateLimit(db, outbound, { errorCode, errorMessage, ...rateLimit });
  }
  const automaticRetryCount = Number(outbound.retry_count || 0);
  const terminal = NON_RETRYABLE_CODES.has(errorCode.toUpperCase()) ||
    automaticRetryCount >= Math.max(0, Number(options.maxAutomaticRetries ?? DEFAULT_MAX_AUTOMATIC_RETRIES));
  const retryAfterMs = terminal ? 0 : retryDelayMs(automaticRetryCount + 1, options);
  const status = terminal ? 'dead' : 'pending';
  const save = db.transaction(() => {
    db.prepare(`
      UPDATE outbound_messages
      SET status = @status,
          retry_count = retry_count + 1,
          next_attempt_at = @nextAttemptAt,
          error_code = @errorCode,
          error_message = @errorMessage,
          sending_started_at = NULL,
          owner_worker_id = NULL,
          lease_expires_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({
      id: outbound.id,
      errorCode,
      errorMessage,
      status,
      nextAttemptAt: retryAfterMs ? toSqlTimestamp(Date.now() + retryAfterMs) : null,
    });
    if (outbound.attempt_id) {
      db.prepare(`
        UPDATE outbound_attempts
        SET status = @attemptStatus, error_code = @errorCode, error_message = @errorMessage,
            completed_at = CURRENT_TIMESTAMP
        WHERE id = @attemptId
      `).run({
        attemptId: outbound.attempt_id,
        attemptStatus: terminal ? 'dead' : 'retry_scheduled',
        errorCode,
        errorMessage,
      });
    }
  });
  save();

  const breaker = NON_RETRYABLE_CODES.has(errorCode.toUpperCase()) ? null : recordSendFailure(
    db,
    outbound.platform,
    outbound.account,
    {
      reason: `${errorCode}: ${errorMessage}`,
      failureWindowMs: options.failureWindowMs,
      failureThreshold: options.failureThreshold,
      cooldownMs: options.cooldownMs,
    },
  );
  return {
    breaker,
    status: breaker ? 'paused' : (terminal ? 'dead' : 'retry_scheduled'),
    retryAfterMs: breaker ? 0 : retryAfterMs,
  };
}

function retryDelayMs(attempt, options = {}) {
  const base = Math.max(0, Number(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS));
  const max = Math.max(base, Number(options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS));
  if (base === 0) return 0;
  const exponential = Math.min(max, base * (2 ** Math.max(0, Number(attempt) - 1)));
  return Math.min(max, Math.round(exponential + Math.random() * Math.min(500, Math.max(1, base))));
}

function classifyTelegramRateLimit(errorCode, errorMessage) {
  const text = `${errorCode} ${errorMessage}`;
  if (/peer[_ ]?flood/i.test(text)) return { kind: 'peer_flood', cooldownMs: 24 * 60 * 60 * 1000 };
  if (/flood[_ ]?wait/i.test(text)) {
    const seconds = Number(text.match(/(?:flood[_ ]?wait|wait)[^0-9]*(\d+)/i)?.[1] || 60);
    return { kind: 'flood_wait', cooldownMs: Math.max(60, seconds) * 1000 };
  }
  return null;
}

function pauseForRateLimit(db, outbound, { errorCode, errorMessage, kind, cooldownMs }) {
  const cooldownUntil = toSqlTimestamp(Date.now() + cooldownMs);
  const save = db.transaction(() => {
    db.prepare(`
      UPDATE outbound_messages
      SET status = 'paused', error_code = @errorCode, error_message = @errorMessage,
          sending_started_at = NULL, owner_worker_id = NULL, lease_expires_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({ id: outbound.id, errorCode, errorMessage });
    db.prepare(`
      INSERT INTO send_circuit_breaker (
        platform, account, status, reason, failure_count, cooldown_until, last_failure_at, updated_at
      ) VALUES (@platform, @account, 'cooldown', @reason, 1, @cooldownUntil, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(platform, account) DO UPDATE SET
        status = 'cooldown', reason = excluded.reason,
        failure_count = send_circuit_breaker.failure_count + 1,
        cooldown_until = excluded.cooldown_until,
        last_failure_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    `).run({
      platform: outbound.platform,
      account: outbound.account,
      reason: `${kind}: ${errorMessage}`,
      cooldownUntil,
    });
    pausePendingForBreaker(db, { platform: outbound.platform, account: outbound.account, reason: `${kind}: ${errorMessage}` });
    if (outbound.attempt_id) {
      db.prepare(`
        UPDATE outbound_attempts
        SET status = 'paused', error_code = @errorCode, error_message = @errorMessage,
            completed_at = CURRENT_TIMESTAMP
        WHERE id = @attemptId
      `).run({ attemptId: outbound.attempt_id, errorCode, errorMessage });
    }
  });
  save();
  return { breaker: activeBreaker(db, outbound.platform, outbound.account), paused: true, status: 'paused' };
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
    FROM outbound_attempts attempts
    JOIN outbound_messages outbound ON outbound.id = attempts.outbound_id
    WHERE outbound.platform = @platform
      AND outbound.account = @account
      AND attempts.status IN ('retry_scheduled', 'dead')
      AND attempts.completed_at >= @windowStart
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
    mentions_json: row.mentions_json,
    attachment_json: row.attachment_json,
    retry_of: row.retry_of,
    retry_count: row.retry_count,
  };
}

function markDeliveredByRemoteId(db, { platform, account, remoteMsgId }) {
  return markProviderAckByRemoteId(db, { platform, account, remoteMsgId, ack: 2 });
}

function markProviderAckByRemoteId(db, { platform, account, remoteMsgId, ack }) {
  const id = String(remoteMsgId || '').trim();
  if (!id) return 0;
  const normalizedAck = Math.max(0, Math.min(Number(ack) || 0, 4));
  return db.prepare(`
    UPDATE outbound_messages
    SET provider_ack = MAX(COALESCE(provider_ack, 0), @ack),
        status = CASE
          WHEN @ack >= 3 THEN 'read'
          WHEN @ack >= 2 AND status <> 'read' THEN 'delivered'
          WHEN @ack >= 1 AND status IN ('sending', 'sent') THEN 'sent'
          ELSE status
        END,
        sent_at = CASE WHEN @ack >= 1 THEN COALESCE(sent_at, CURRENT_TIMESTAMP) ELSE sent_at END,
        delivered_at = CASE WHEN @ack >= 2 THEN COALESCE(delivered_at, CURRENT_TIMESTAMP) ELSE delivered_at END,
        read_at = CASE WHEN @ack >= 3 THEN COALESCE(read_at, CURRENT_TIMESTAMP) ELSE read_at END,
        sending_started_at = CASE WHEN @ack >= 1 THEN NULL ELSE sending_started_at END,
        owner_worker_id = CASE WHEN @ack >= 1 THEN NULL ELSE owner_worker_id END,
        lease_expires_at = CASE WHEN @ack >= 1 THEN NULL ELSE lease_expires_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE platform = @platform AND account = @account
      AND remote_msg_id = @remoteMsgId
      AND status IN ('sending', 'sent', 'delivered', 'read')
  `).run({ platform, account, remoteMsgId: id, ack: normalizedAck }).changes;
}

function nextSendDelay({ lastAttemptAt, recentAttempts, minIntervalMs, perMinuteLimit }) {
  const now = Date.now();
  while (recentAttempts.length && recentAttempts[0] <= now - 60 * 1000) recentAttempts.shift();
  const intervalDelay = lastAttemptAt ? Math.max(0, Number(minIntervalMs || 0) - (now - lastAttemptAt)) : 0;
  const minuteDelay = recentAttempts.length >= Math.max(1, Number(perMinuteLimit) || 1)
    ? Math.max(0, recentAttempts[0] + 60 * 1000 - now)
    : 0;
  return Math.max(intervalDelay, minuteDelay);
}

function toSqlTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = {
  activeBreaker,
  claimPendingById,
  claimNextPending,
  createOutboundConsumer,
  markFailed,
  markDeliveredByRemoteId,
  markProviderAckByRemoteId,
  markSent,
  pausePendingForBreaker,
  recoverStaleSending,
  renewSendingLease,
  recordSendFailure,
  classifyTelegramRateLimit,
  toSqlTimestamp,
};
