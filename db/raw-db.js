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
      send_enabled INTEGER NOT NULL DEFAULT 0,
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
  return db;
}

module.exports = {
  DEFAULT_RAW_DB_PATH,
  ensureRawDb,
};
