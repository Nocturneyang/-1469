const Database = require('better-sqlite3');
const { ensureDirectory, resolveDbPath } = require('./paths');

const DEFAULT_RUNTIME_DB_PATH =
  resolveDbPath(['WORKBENCH_RUNTIME_DB_PATH', 'RUNTIME_DB_PATH'], 'runtime.sqlite');

function openRuntimeDb(dbPath = DEFAULT_RUNTIME_DB_PATH) {
  ensureDirectory(dbPath);
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  // API 轮询和 WA/TG worker 会同时打开并写入账号 runtime.sqlite。
  // 先设置等待锁，避免 journal_mode=WAL 在并发打开时直接抛 SQLITE_BUSY。
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS collector_heartbeats (
      account_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      collector_id TEXT NOT NULL,
      run_id TEXT,
      status TEXT,
      phase TEXT,
      health_status TEXT,
      last_error TEXT,
      last_ready_at TEXT,
      last_message_at TEXT,
      started_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (account_id, collector_id)
    );

    CREATE TABLE IF NOT EXISTS runtime_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT,
      platform TEXT,
      source TEXT NOT NULL DEFAULT 'workbench',
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      message TEXT,
      data_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collector_runtime_specs (
      account_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      account_name TEXT NOT NULL,
      desired_state TEXT NOT NULL DEFAULT 'stopped',
      deployment_name TEXT,
      resource_json TEXT,
      session_dir TEXT,
      last_applied_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS channel_sync_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      account TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT,
      reason TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS service_account_login_requests (
      request_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      account TEXT NOT NULL,
      display_name TEXT,
      login_mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested',
      requested_by TEXT,
      credential_hint TEXT,
      qr_payload TEXT,
      worker_message TEXT,
      error_message TEXT,
      expires_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS account_worker_leases (
      platform TEXT NOT NULL,
      account TEXT NOT NULL,
      lease_name TEXT NOT NULL DEFAULT 'account-runtime',
      holder_id TEXT NOT NULL,
      worker_role TEXT NOT NULL,
      run_id TEXT,
      pid INTEGER,
      acquired_at TEXT NOT NULL,
      renewed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      metadata_json TEXT,
      PRIMARY KEY (platform, account, lease_name)
    );

    CREATE TABLE IF NOT EXISTS account_worker_status (
      platform TEXT NOT NULL,
      account TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (platform, account)
    );

    CREATE TABLE IF NOT EXISTS process_heartbeats (
      process_role TEXT PRIMARY KEY,
      holder_id TEXT NOT NULL,
      status TEXT NOT NULL,
      pid INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_runtime_events_account_time
      ON runtime_events(account_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_sync_tasks_status
      ON channel_sync_tasks(platform, account, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_service_account_login_requests_account_time
      ON service_account_login_requests(platform, account, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_account_worker_leases_expiry
      ON account_worker_leases(expires_at);
  `);
  return db;
}

module.exports = {
  DEFAULT_RUNTIME_DB_PATH,
  openRuntimeDb,
};
