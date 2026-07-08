const Database = require('better-sqlite3');
const { ensureDirectory, resolveDbPath } = require('./paths');

const DEFAULT_RAW_DB_PATH =
  resolveDbPath(['WORKBENCH_RAW_DB_PATH', 'RAW_MESSAGES_DB_PATH'], 'raw.sqlite');

function ensureRawDb(dbPath = DEFAULT_RAW_DB_PATH) {
  ensureDirectory(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      receiver_account TEXT,
      message_id TEXT NOT NULL,
      group_id TEXT,
      group_name TEXT,
      sender_id TEXT,
      sender_name TEXT,
      content TEXT,
      has_media INTEGER NOT NULL DEFAULT 0,
      media_path TEXT,
      timestamp INTEGER,
      raw_data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(platform, message_id)
    );

    CREATE TABLE IF NOT EXISTS message_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      canonical_message_id TEXT NOT NULL,
      observer_account TEXT NOT NULL,
      observer_role TEXT NOT NULL DEFAULT 'service',
      native_chat_id TEXT,
      native_message_id TEXT,
      observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT,
      UNIQUE(platform, canonical_message_id, observer_account)
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      status TEXT NOT NULL,
      pushname TEXT,
      display_name TEXT,
      health_status TEXT,
      session_status TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS channel_account_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      account TEXT NOT NULL UNIQUE,
      display_name TEXT,
      login_type TEXT NOT NULL DEFAULT 'unknown',
      account_role TEXT NOT NULL DEFAULT 'service',
      workbench_visible INTEGER NOT NULL DEFAULT 1,
      collect_enabled INTEGER NOT NULL DEFAULT 1,
      send_enabled INTEGER NOT NULL DEFAULT 1,
      sync_groups_enabled INTEGER NOT NULL DEFAULT 0,
      risk_level TEXT NOT NULL DEFAULT 'low',
      owner_team TEXT,
      status TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_platform_timestamp
      ON messages(platform, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_group
      ON messages(platform, group_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_message_observations_observer_chat
      ON message_observations(platform, observer_account, native_chat_id, canonical_message_id);
    CREATE INDEX IF NOT EXISTS idx_channel_account_registry_platform_role
      ON channel_account_registry(platform, account_role, workbench_visible);
  `);
  migrateRawDbSchema(db);
  return db;
}

function migrateRawDbSchema(db) {
  ensureColumn(db, 'accounts', 'display_name', 'TEXT');
  ensureColumn(db, 'accounts', 'health_status', 'TEXT');
  ensureColumn(db, 'accounts', 'session_status', 'TEXT');
  ensureColumn(db, 'accounts', 'updated_at', 'TEXT');
  ensureColumn(db, 'channel_account_registry', 'login_type', "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(db, 'channel_account_registry', 'account_role', "TEXT NOT NULL DEFAULT 'service'");
  ensureColumn(db, 'channel_account_registry', 'workbench_visible', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'channel_account_registry', 'collect_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'channel_account_registry', 'send_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'channel_account_registry', 'sync_groups_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'channel_account_registry', 'risk_level', "TEXT NOT NULL DEFAULT 'low'");
  ensureColumn(db, 'channel_account_registry', 'status', 'TEXT');
  ensureColumn(db, 'channel_account_registry', 'updated_at', 'TEXT');
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name));
  if (columns.has(columnName)) return;
  db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
}

function upsertServiceAccountProfile({
  dbPath = DEFAULT_RAW_DB_PATH,
  platform,
  account,
  displayName,
  loginType = 'workbench_login',
  status = 'login_requested',
  accountRole = 'service',
  sendEnabled = 1,
} = {}) {
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedAccount = String(account || '').trim();
  if (!['wa', 'tg'].includes(normalizedPlatform)) throw new Error('platform must be one of wa, tg');
  if (!normalizedAccount) throw new Error('account is required');
  const db = ensureRawDb(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accounts (id, platform, status, pushname, display_name, session_status, updated_at)
      VALUES (@account, @platform, @status, @displayName, @displayName, @status, @now)
      ON CONFLICT(id) DO UPDATE SET
        platform = excluded.platform,
        status = excluded.status,
        display_name = COALESCE(NULLIF(excluded.display_name, ''), accounts.display_name),
        session_status = excluded.session_status,
        updated_at = excluded.updated_at
    `).run({
      account: normalizedAccount,
      platform: normalizedPlatform,
      status,
      displayName: String(displayName || normalizedAccount).trim() || normalizedAccount,
      now,
    });
    db.prepare(`
      INSERT INTO channel_account_registry (
        platform, account, display_name, login_type, account_role,
        workbench_visible, collect_enabled, send_enabled, sync_groups_enabled, risk_level, status, updated_at
      )
      VALUES (
        @platform, @account, @displayName, @loginType, @accountRole,
        1, 1, @sendEnabled, 1, 'low', @status, @now
      )
      ON CONFLICT(account) DO UPDATE SET
        platform = excluded.platform,
        display_name = COALESCE(NULLIF(excluded.display_name, ''), channel_account_registry.display_name),
        login_type = excluded.login_type,
        account_role = excluded.account_role,
        workbench_visible = 1,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run({
      platform: normalizedPlatform,
      account: normalizedAccount,
      displayName: String(displayName || normalizedAccount).trim() || normalizedAccount,
      loginType,
      accountRole,
      sendEnabled: Number(sendEnabled) === 0 ? 0 : 1,
      status,
      now,
    });
  } finally {
    db.close();
  }
}

function upsertRawMessage({
  db,
  dbPath = DEFAULT_RAW_DB_PATH,
  platform,
  account,
  messageId,
  groupId,
  groupName,
  senderId,
  senderName,
  content = '',
  hasMedia = 0,
  mediaPath = null,
  timestamp,
  rawData = null,
  nativeChatId,
  nativeMessageId,
  observerRole = 'service',
} = {}) {
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedAccount = String(account || '').trim();
  const normalizedMessageId = String(messageId || '').trim();
  if (!['wa', 'tg'].includes(normalizedPlatform)) throw new Error('platform must be one of wa, tg');
  if (!normalizedAccount) throw new Error('account is required');
  if (!normalizedMessageId) throw new Error('messageId is required');

  const rawDb = db || ensureRawDb(dbPath);
  const closeOwned = !db;
  const row = {
    platform: normalizedPlatform,
    account: normalizedAccount,
    messageId: normalizedMessageId,
    groupId: String(groupId || nativeChatId || '').trim() || null,
    groupName: String(groupName || groupId || nativeChatId || '').trim() || null,
    senderId: String(senderId || '').trim() || null,
    senderName: String(senderName || '').trim() || null,
    content: String(content || ''),
    hasMedia: hasMedia ? 1 : 0,
    mediaPath: mediaPath || null,
    timestamp: normalizeMessageTimestamp(timestamp),
    rawJson: safeJson(rawData),
    nativeChatId: String(nativeChatId || groupId || '').trim() || null,
    nativeMessageId: String(nativeMessageId || messageId || '').trim() || normalizedMessageId,
    observerRole: String(observerRole || 'service').trim() || 'service',
  };

  try {
    return rawDb.transaction(() => {
      rawDb.prepare(`
        INSERT INTO messages (
          platform, receiver_account, message_id, group_id, group_name,
          sender_id, sender_name, content, has_media, media_path, timestamp, raw_data
        )
        VALUES (
          @platform, @account, @messageId, @groupId, @groupName,
          @senderId, @senderName, @content, @hasMedia, @mediaPath, @timestamp, @rawJson
        )
        ON CONFLICT(platform, message_id) DO UPDATE SET
          receiver_account = excluded.receiver_account,
          group_id = excluded.group_id,
          group_name = COALESCE(NULLIF(excluded.group_name, ''), messages.group_name),
          sender_id = COALESCE(NULLIF(excluded.sender_id, ''), messages.sender_id),
          sender_name = COALESCE(NULLIF(excluded.sender_name, ''), messages.sender_name),
          content = excluded.content,
          has_media = excluded.has_media,
          media_path = COALESCE(excluded.media_path, messages.media_path),
          timestamp = COALESCE(excluded.timestamp, messages.timestamp),
          raw_data = COALESCE(excluded.raw_data, messages.raw_data)
      `).run(row);

      rawDb.prepare(`
        INSERT INTO message_observations (
          platform, canonical_message_id, observer_account, observer_role,
          native_chat_id, native_message_id, raw_json
        )
        VALUES (
          @platform, @messageId, @account, @observerRole,
          @nativeChatId, @nativeMessageId, @rawJson
        )
        ON CONFLICT(platform, canonical_message_id, observer_account) DO UPDATE SET
          observer_role = excluded.observer_role,
          native_chat_id = excluded.native_chat_id,
          native_message_id = excluded.native_message_id,
          observed_at = CURRENT_TIMESTAMP,
          raw_json = COALESCE(excluded.raw_json, message_observations.raw_json)
      `).run(row);

      return rawDb.prepare(`
        SELECT id
        FROM messages
        WHERE platform = @platform AND message_id = @messageId
      `).get(row).id;
    })();
  } finally {
    if (closeOwned) rawDb.close();
  }
}

function normalizePlatform(platform) {
  const value = String(platform || '').trim().toLowerCase();
  if (value === 'whatsapp') return 'wa';
  if (value === 'telegram' || value === 'telegram-user' || value === 'tg-user') return 'tg';
  return value;
}

function normalizeMessageTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Math.floor(Date.now() / 1000);
  return numeric > 1000000000000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function safeJson(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return JSON.stringify({ unserializable: true });
  }
}

module.exports = {
  DEFAULT_RAW_DB_PATH,
  ensureRawDb,
  upsertRawMessage,
  upsertServiceAccountProfile,
};
