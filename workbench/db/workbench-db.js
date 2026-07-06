const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  migrateAccessControlSchema,
  seedAccessControl,
  setOperatorRoles,
} = require('../lib/access-control');

const DEFAULT_WORKBENCH_DB_PATH =
  process.env.WORKBENCH_DB_PATH || path.join(__dirname, 'workbench.sqlite');
const schemaPath = path.join(__dirname, 'schema.sql');

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function openWorkbenchDb(dbPath = DEFAULT_WORKBENCH_DB_PATH) {
  ensureDirectory(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrateAccessControlSchema(db);
  seedAccessControl(db);
  migrateLegacyLabels(db);
  seedDefaultSuperAdmin(db);
  seedDefaultOperator(db);
  return db;
}

function migrateLegacyLabels(db) {
  db.prepare(`
    INSERT OR IGNORE INTO service_groups (
      platform, service_account, native_group_id, name, source, color, raw_json, synced_at
    )
    SELECT
      platform,
      account,
      native_label_id,
      name,
      CASE WHEN platform = 'wa' THEN 'wa_label' ELSE kind END,
      color,
      raw_json,
      synced_at
    FROM channel_labels
  `).run();

  db.prepare(`
    INSERT OR IGNORE INTO conversation_service_group_map (
      platform, service_account, chat_id, native_group_id, synced_at
    )
    SELECT
      platform,
      account,
      group_id,
      native_label_id,
      synced_at
    FROM conversation_label_map
  `).run();
}

function seedDefaultOperator(db) {
  db.prepare(`
    INSERT INTO operators (id, username, display_name, role, status)
    VALUES ('demo-operator', 'demo', '值班坐席', 'agent', 'active')
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      status = 'active',
      updated_at = CURRENT_TIMESTAMP
  `).run();
}

function seedDefaultSuperAdmin(db) {
  const defaults = ['1469', '杨杰'];
  const insertSuperAdmin = db.prepare(`
    INSERT INTO workbench_super_admins (identity, display_name, status, created_by)
    VALUES (?, ?, 'active', 'system')
    ON CONFLICT(identity) DO NOTHING
  `);
  const insertPortalAccess = db.prepare(`
    INSERT INTO operator_portal_access (operator_id, can_monitor, can_workbench, can_admin, default_entry)
    VALUES (?, 1, 1, 1, 'chooser')
    ON CONFLICT(operator_id) DO NOTHING
  `);

  defaults.forEach((identity) => {
    insertSuperAdmin.run(identity, identity);
    insertPortalAccess.run(identity);
    setOperatorRoles(db, identity, ['super_admin'], 'system');
  });
}

function ensureOperator(db, operatorId, displayName = operatorId) {
  const id = String(operatorId || 'demo-operator').trim() || 'demo-operator';
  db.prepare(`
    INSERT INTO operators (id, username, display_name, role, status)
    VALUES (@id, @username, @displayName, 'agent', 'active')
    ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `).run({
    id,
    username: id,
    displayName: displayName || id,
  });
  return id;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function safeJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

module.exports = {
  DEFAULT_WORKBENCH_DB_PATH,
  ensureOperator,
  openWorkbenchDb,
  parseJson,
  safeJson,
};
