'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { listAccountRefs, sanitizeAccountSegment } = require('../db/account-db');

function recoverStartupState({ runtimeDb, workbenchDb, outboxDir } = {}) {
  const report = { expired_login_requests: 0, restored_doorbells: 0, removed_temp_files: 0 };
  report.expired_login_requests += expireLoginRequests(runtimeDb);
  report.restored_doorbells += restorePendingDoorbells(workbenchDb, outboxDir);
  for (const ref of listAccountRefs()) {
    if (fs.existsSync(ref.paths.runtimeDbPath)) {
      const db = new Database(ref.paths.runtimeDbPath);
      try { report.expired_login_requests += expireLoginRequests(db); } finally { db.close(); }
    }
    if (fs.existsSync(ref.paths.workbenchDbPath)) {
      const db = new Database(ref.paths.workbenchDbPath);
      try { report.restored_doorbells += restorePendingDoorbells(db, outboxDir); } finally { db.close(); }
    }
  }
  report.removed_temp_files = removeResidualTempFiles(outboxDir);
  return report;
}

function expireLoginRequests(db) {
  if (!db || !tableExists(db, 'service_account_login_requests')) return 0;
  return db.prepare(`
    UPDATE service_account_login_requests
    SET status = 'expired', error_message = COALESCE(error_message, 'login request expired during restart'),
        completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE status NOT IN ('authenticated', 'failed', 'expired', 'canceled')
      AND expires_at IS NOT NULL
      AND datetime(expires_at) <= datetime('now')
  `).run().changes;
}

function restorePendingDoorbells(db, outboxDir) {
  if (!db || !outboxDir || !tableExists(db, 'outbound_messages')) return 0;
  let restored = 0;
  const rows = db.prepare(`
    SELECT id, platform, account, status FROM outbound_messages WHERE status = 'pending'
  `).all();
  rows.forEach((row) => {
    const dir = path.join(outboxDir, `worker-${row.platform}-${sanitizeAccountSegment(row.account)}`);
    const finalPath = path.join(dir, `${row.id}.json`);
    if (fs.existsSync(finalPath)) return;
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${finalPath}.${process.pid}.startup.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ outbound_id: row.id, platform: row.platform, account: row.account, status: row.status }));
    fs.renameSync(tempPath, finalPath);
    restored += 1;
  });
  return restored;
}

function removeResidualTempFiles(root) {
  if (!root || !fs.existsSync(root)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      removed += removeResidualTempFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
      fs.rmSync(full, { force: true });
      removed += 1;
    }
  }
  return removed;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

module.exports = {
  expireLoginRequests,
  recoverStartupState,
  removeResidualTempFiles,
  restorePendingDoorbells,
};
