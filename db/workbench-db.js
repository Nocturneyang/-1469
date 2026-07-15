const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { ensureDirectory, resolveDbPath } = require('./paths');
const {
  migrateAccessControlSchema,
  seedAccessControl,
  setOperatorRoles,
} = require('../lib/access-control');

const DEFAULT_WORKBENCH_DB_PATH =
  resolveDbPath('WORKBENCH_DB_PATH', 'workbench.sqlite');
const schemaPath = path.join(__dirname, 'schema.sql');

function openWorkbenchDb(dbPath = DEFAULT_WORKBENCH_DB_PATH, options = {}) {
  if (options.readonly) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // 列表查询和渠道 worker 会并发访问账号库；读连接不应参与迁移或抢写锁。
    db.pragma('busy_timeout = 3000');
    return db;
  }
  ensureDirectory(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_autocheckpoint = 2000');
  db.pragma('busy_timeout = 5000');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrateOutboundReliability(db);
  migrateAccessControlSchema(db);
  seedAccessControl(db);
  migrateManualServiceGroups(db);
  migrateLegacyLabels(db);
  migrateCustomerTypes(db);
  seedDefaultSuperAdmin(db);
  seedDefaultOperator(db);
  return db;
}

function migrateOutboundReliability(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(outbound_messages)').all().map((column) => column.name));
  const addColumn = (name, definition) => {
    if (!columns.has(name)) db.prepare(`ALTER TABLE outbound_messages ADD COLUMN ${name} ${definition}`).run();
  };
  addColumn('provider_ack', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('read_at', 'TEXT');
  addColumn('owner_worker_id', 'TEXT');
  addColumn('lease_expires_at', 'TEXT');
  addColumn('next_attempt_at', 'TEXT');
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_outbound_claimable
      ON outbound_messages(platform, account, status, next_attempt_at, created_at)
  `).run();
}

function migrateCustomerTypes(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(conversation_profiles)').all().map((column) => column.name));
  if (!columns.has('customer_type_id')) {
    db.prepare('ALTER TABLE conversation_profiles ADD COLUMN customer_type_id TEXT').run();
  }
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_conversation_profiles_customer_type
      ON conversation_profiles(platform, account, customer_type_id)
  `).run();

  const rows = db.prepare(`
    SELECT DISTINCT platform, account, TRIM(customer_type) AS name
    FROM conversation_profiles
    WHERE TRIM(COALESCE(customer_type, '')) <> ''
  `).all();
  const insert = db.prepare(`
    INSERT INTO customer_type_options (
      id, platform, service_account, name, status, created_by, updated_by
    ) VALUES (@id, @platform, @account, @name, 'active', 'migration', 'migration')
    ON CONFLICT(platform, service_account, name) DO NOTHING
  `);
  const find = db.prepare(`
    SELECT id FROM customer_type_options
    WHERE platform = @platform AND service_account = @account AND name = @name
  `);
  const update = db.prepare(`
    UPDATE conversation_profiles
    SET customer_type_id = @id
    WHERE platform = @platform
      AND account = @account
      AND TRIM(COALESCE(customer_type, '')) = @name
      AND COALESCE(customer_type_id, '') = ''
  `);
  const save = db.transaction(() => {
    rows.forEach((row) => {
      const id = `ctype-${crypto.createHash('sha256').update(`${row.platform}:${row.account}:${row.name}`).digest('hex').slice(0, 20)}`;
      insert.run({ ...row, id });
      const stored = find.get(row);
      if (stored) update.run({ ...row, id: stored.id });
    });
  });
  save();
}

function migrateManualServiceGroups(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(service_groups)').all().map((column) => column.name));
  const addColumn = (name, definition) => {
    if (!columns.has(name)) db.prepare(`ALTER TABLE service_groups ADD COLUMN ${name} ${definition}`).run();
  };
  addColumn('parent_native_group_id', 'TEXT');
  addColumn('group_level', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('is_manual', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('created_by', 'TEXT');
  addColumn('updated_by', 'TEXT');
  db.prepare(`
    UPDATE service_groups
    SET
      group_level = CASE WHEN source = 'manual_l2' THEN 2 ELSE COALESCE(NULLIF(group_level, 0), 1) END,
      is_manual = CASE WHEN source IN ('manual', 'manual_l1', 'manual_l2') THEN 1 ELSE COALESCE(is_manual, 0) END
  `).run();
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_service_groups_parent
      ON service_groups(platform, service_account, parent_native_group_id)
  `).run();
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
  const defaults = splitList(
    process.env.WORKBENCH_BOOTSTRAP_ADMIN ||
    process.env.WORKBENCH_SUPER_ADMINS ||
    (process.env.LOCAL_DEV_AUTH_BYPASS === '1' ? process.env.WORKBENCH_LOCAL_DEV_ADMIN_ID : ''),
  );
  const insertSuperAdmin = db.prepare(`
    INSERT INTO workbench_super_admins (identity, display_name, status, created_by)
    VALUES (?, ?, 'active', 'system')
    ON CONFLICT(identity) DO NOTHING
  `);
  const insertPortalAccess = db.prepare(`
    INSERT INTO operator_portal_access (operator_id, can_monitor, can_workbench, can_admin, default_entry)
    VALUES (?, 0, 1, 1, 'workbench')
    ON CONFLICT(operator_id) DO NOTHING
  `);
  const insertOperator = db.prepare(`
    INSERT INTO operators (id, username, display_name, role, status)
    VALUES (?, ?, ?, 'super_admin', 'active')
    ON CONFLICT(id) DO UPDATE SET
      role = 'super_admin',
      status = 'active',
      updated_at = CURRENT_TIMESTAMP
  `);

  defaults.forEach((identity) => {
    insertOperator.run(identity, identity, identity);
    insertSuperAdmin.run(identity, identity);
    insertPortalAccess.run(identity);
    setOperatorRoles(db, identity, ['super_admin'], 'system');
  });
}

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
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
