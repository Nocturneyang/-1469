const EVENT_RETENTION_HOURS = 24;

function recordChannelEvent(db, {
  platform,
  account,
  groupId = null,
  eventType,
  payload = null,
} = {}) {
  if (!db || !platform || !account || !eventType) return null;
  const result = db.prepare(`
    INSERT INTO channel_events (platform, account, group_id, event_type, payload_json)
    VALUES (@platform, @account, @groupId, @eventType, @payloadJson)
  `).run({
    platform: String(platform),
    account: String(account),
    groupId: groupId ? String(groupId) : null,
    eventType: String(eventType),
    payloadJson: payload ? JSON.stringify(payload) : null,
  });
  if (Number(result.lastInsertRowid) % 100 === 0) pruneChannelEvents(db);
  return Number(result.lastInsertRowid);
}

function listChannelEvents(db, { afterId = 0, limit = 200 } = {}) {
  return db.prepare(`
    SELECT id, platform, account, group_id, event_type, payload_json, created_at
    FROM channel_events
    WHERE id > @afterId
    ORDER BY id ASC
    LIMIT @limit
  `).all({
    afterId: Math.max(0, Number(afterId) || 0),
    limit: Math.max(1, Math.min(Number(limit) || 200, 500)),
  }).map((row) => ({
    ...row,
    payload: parsePayload(row.payload_json),
  }));
}

function latestChannelEventId(db) {
  return Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM channel_events').get()?.id || 0);
}

function pruneChannelEvents(db, { retentionHours = EVENT_RETENTION_HOURS } = {}) {
  const hours = Math.max(1, Math.min(Number(retentionHours) || EVENT_RETENTION_HOURS, 24 * 30));
  return db.prepare(`DELETE FROM channel_events WHERE created_at < datetime('now', ?)`).run(`-${hours} hours`).changes;
}

function parsePayload(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

module.exports = {
  latestChannelEventId,
  listChannelEvents,
  pruneChannelEvents,
  recordChannelEvent,
};
