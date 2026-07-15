const fs = require('fs');
const Database = require('better-sqlite3');

const { listAccountRefs } = require('../db/account-db');
const { DEFAULT_AUTH_DB_PATH } = require('../db/auth-db');
const { DEFAULT_RAW_DB_PATH } = require('../db/raw-db');
const { DEFAULT_RUNTIME_DB_PATH } = require('../db/runtime-db');
const { DEFAULT_WORKBENCH_DB_PATH } = require('../db/workbench-db');

const paths = new Set([
  DEFAULT_AUTH_DB_PATH,
  DEFAULT_RAW_DB_PATH,
  DEFAULT_WORKBENCH_DB_PATH,
  DEFAULT_RUNTIME_DB_PATH,
]);
listAccountRefs().forEach((ref) => {
  paths.add(ref.paths.rawDbPath);
  paths.add(ref.paths.workbenchDbPath);
  paths.add(ref.paths.runtimeDbPath);
});

const results = [];
for (const dbPath of paths) {
  if (!fs.existsSync(dbPath)) continue;
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((row) => row.name));
    const removedRuntimeEvents = tables.has('runtime_events')
      ? db.prepare(`DELETE FROM runtime_events WHERE created_at < datetime('now', '-30 days')`).run().changes
      : 0;
    const removedChannelEvents = tables.has('channel_events')
      ? db.prepare(`DELETE FROM channel_events WHERE created_at < datetime('now', '-24 hours')`).run().changes
      : 0;
    const checkpoint = db.pragma('wal_checkpoint(PASSIVE)');
    results.push({ db: dbPath, removed_runtime_events: removedRuntimeEvents, removed_channel_events: removedChannelEvents, checkpoint });
  } finally {
    db.close();
  }
}

console.log(JSON.stringify({ ok: true, maintained: results.length, results }));
