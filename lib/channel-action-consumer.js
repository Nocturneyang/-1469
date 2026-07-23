'use strict';

// A small, deliberately separate ledger for native channel actions.  Message
// delivery keeps its stricter outbound queue; presence/reaction/chat actions
// use the same DB-first + worker-only execution boundary without pretending to
// be outbound messages.
const os = require('os');

const STALE_EXECUTING_MS = 60 * 1000;
const LEASE_MS = 45 * 1000;
const TRANSIENT_RETRIES = 2;

function createChannelActionConsumer({ db, platform, account, performAction, workerId = `${os.hostname()}-${process.pid}-${platform}-${account}` } = {}) {
  if (!db) throw new Error('db is required');
  if (!platform || !account) throw new Error('platform and account are required');
  if (typeof performAction !== 'function') throw new Error('performAction is required');
  let activeRun = null;

  async function runOnce() {
    if (activeRun) return activeRun;
    activeRun = (async () => {
      recoverStaleActions(db, { platform, account });
      const task = claimNextAction(db, { platform, account, workerId });
      if (!task) return { status: 'idle' };
      try {
        const result = await performAction(mapTask(task));
        markActionCompleted(db, task.id, result, workerId);
        return { status: 'completed', action_id: task.id, action_type: task.action_type, group_id: task.group_id };
      } catch (error) {
        const status = markActionFailed(db, task, error, workerId);
        return { status, action_id: task.id, action_type: task.action_type, group_id: task.group_id };
      }
    })();
    try {
      return await activeRun;
    } finally {
      activeRun = null;
    }
  }

  return { runOnce };
}

function recoverStaleActions(db, { platform, account, staleMs = STALE_EXECUTING_MS } = {}) {
  return db.prepare(`
    UPDATE channel_action_tasks
    SET status = 'pending', executing_started_at = NULL, owner_worker_id = NULL,
        lease_expires_at = NULL, next_attempt_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE platform = @platform AND account = @account AND status = 'executing'
      AND (lease_expires_at IS NULL OR lease_expires_at < @cutoff)
  `).run({ platform, account, cutoff: sqlTime(Date.now() - staleMs) }).changes;
}

function claimNextAction(db, { platform, account, workerId, leaseMs = LEASE_MS } = {}) {
  return db.transaction(() => {
    const task = db.prepare(`
      SELECT * FROM channel_action_tasks
      WHERE platform = @platform AND account = @account AND status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
      ORDER BY created_at ASC, id ASC LIMIT 1
    `).get({ platform, account });
    if (!task) return null;
    const changed = db.prepare(`
      UPDATE channel_action_tasks
      SET status = 'executing', executing_started_at = CURRENT_TIMESTAMP,
          owner_worker_id = @workerId, lease_expires_at = @leaseExpiresAt,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id AND status = 'pending'
    `).run({ id: task.id, workerId, leaseExpiresAt: sqlTime(Date.now() + leaseMs) }).changes;
    return changed ? db.prepare('SELECT * FROM channel_action_tasks WHERE id = ?').get(task.id) : null;
  })();
}

function markActionCompleted(db, id, result, workerId) {
  return db.prepare(`
    UPDATE channel_action_tasks
    SET status = 'completed', result_json = @resultJson, error_code = NULL, error_message = NULL,
        completed_at = CURRENT_TIMESTAMP, executing_started_at = NULL, owner_worker_id = NULL,
        lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = @id AND status = 'executing' AND owner_worker_id = @workerId
  `).run({ id, workerId, resultJson: JSON.stringify(result || {}) }).changes;
}

function markActionFailed(db, task, error, workerId) {
  const code = String(error?.code || error?.name || 'CHANNEL_ACTION_FAILED').slice(0, 120);
  const message = String(error?.message || 'channel action failed').slice(0, 1000);
  const retryable = !['ACTION_UNSUPPORTED', 'MESSAGE_ID_INVALID', 'CHAT_NOT_FOUND', 'ACTION_FORBIDDEN'].includes(code);
  const shouldRetry = retryable && Number(task.retry_count || 0) < TRANSIENT_RETRIES;
  db.prepare(`
    UPDATE channel_action_tasks
    SET status = @status, retry_count = retry_count + 1, error_code = @code, error_message = @message,
        executing_started_at = NULL, owner_worker_id = NULL, lease_expires_at = NULL,
        next_attempt_at = @nextAttemptAt, updated_at = CURRENT_TIMESTAMP
    WHERE id = @id AND status = 'executing' AND owner_worker_id = @workerId
  `).run({
    id: task.id,
    workerId,
    status: shouldRetry ? 'pending' : 'failed',
    code,
    message,
    nextAttemptAt: shouldRetry ? sqlTime(Date.now() + 1500 * (Number(task.retry_count || 0) + 1)) : null,
  });
  return shouldRetry ? 'retrying' : 'failed';
}

function mapTask(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch (_) { payload = {}; }
  return { ...row, chat_id: row.chat_id || row.group_id, payload };
}

function sqlTime(value) {
  return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { claimNextAction, createChannelActionConsumer, recoverStaleActions };
