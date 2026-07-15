PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workbench_super_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operator_portal_access (
  operator_id TEXT PRIMARY KEY,
  can_monitor INTEGER NOT NULL DEFAULT 0,
  can_workbench INTEGER NOT NULL DEFAULT 0,
  can_admin INTEGER NOT NULL DEFAULT 0,
  default_entry TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS access_permissions (
  code TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS access_roles (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS access_role_permissions (
  role_code TEXT NOT NULL,
  permission_code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_code, permission_code),
  FOREIGN KEY(role_code) REFERENCES access_roles(code) ON DELETE CASCADE,
  FOREIGN KEY(permission_code) REFERENCES access_permissions(code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS operator_roles (
  operator_id TEXT NOT NULL,
  role_code TEXT NOT NULL,
  assigned_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (operator_id, role_code),
  FOREIGN KEY(role_code) REFERENCES access_roles(code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operator_roles_operator
  ON operator_roles(operator_id);

CREATE TABLE IF NOT EXISTS outbound_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_msg_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  chat_id TEXT,
  text TEXT NOT NULL DEFAULT '',
  quote_msg_id TEXT,
  attachment_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  remote_msg_id TEXT,
  created_by TEXT NOT NULL,
  retry_of INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  provider_ack INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sending_started_at TEXT,
  sent_at TEXT,
  delivered_at TEXT,
  read_at TEXT,
  owner_worker_id TEXT,
  lease_expires_at TEXT,
  next_attempt_at TEXT,
  UNIQUE(created_by, client_msg_id),
  FOREIGN KEY(retry_of) REFERENCES outbound_messages(id)
);

CREATE INDEX IF NOT EXISTS idx_outbound_delivery_queue
  ON outbound_messages(platform, account, status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbound_conversation
  ON outbound_messages(platform, account, group_id, created_at);
CREATE TABLE IF NOT EXISTS outbound_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbound_id INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'attempting',
  remote_msg_id TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_expires_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(outbound_id, attempt_number),
  FOREIGN KEY(outbound_id) REFERENCES outbound_messages(id)
);

CREATE INDEX IF NOT EXISTS idx_outbound_attempts_outbound
  ON outbound_attempts(outbound_id, attempt_number);

CREATE TABLE IF NOT EXISTS outbound_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbound_id INTEGER NOT NULL,
  file_key TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(outbound_id, file_key),
  FOREIGN KEY(outbound_id) REFERENCES outbound_messages(id)
);

CREATE INDEX IF NOT EXISTS idx_outbound_attachments_outbound
  ON outbound_attachments(outbound_id);

CREATE TABLE IF NOT EXISTS group_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  assigned_to TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_assignments_active
  ON group_assignments(platform, account, group_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS conversation_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  last_read_message_id INTEGER,
  last_read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(operator_id, platform, account, group_id)
);

CREATE TABLE IF NOT EXISTS agent_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  platform TEXT,
  account TEXT,
  group_id TEXT,
  target_id TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS send_circuit_breaker (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reason TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT,
  last_failure_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, account)
);

CREATE TABLE IF NOT EXISTS conversation_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'normal',
  starred INTEGER NOT NULL DEFAULT 0,
  follow_up_at TEXT,
  internal_display_name TEXT,
  customer_type_id TEXT,
  customer_type TEXT,
  owner_note TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, account, group_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_profiles_status
  ON conversation_profiles(platform, account, status, follow_up_at);

CREATE INDEX IF NOT EXISTS idx_conversation_profiles_starred
  ON conversation_profiles(platform, account, starred, priority);

CREATE TABLE IF NOT EXISTS customer_type_options (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  service_account TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, service_account, name)
);

CREATE INDEX IF NOT EXISTS idx_customer_type_options_account
  ON customer_type_options(platform, service_account, status, sort_order, name);

CREATE TABLE IF NOT EXISTS conversation_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversation_notes_group
  ON conversation_notes(platform, account, group_id, created_at);

CREATE TABLE IF NOT EXISTS conversation_presence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'viewing',
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(operator_id, platform, account, group_id, mode)
);

CREATE INDEX IF NOT EXISTS idx_conversation_presence_group
  ON conversation_presence(platform, account, group_id, expires_at);

CREATE TABLE IF NOT EXISTS conversation_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversation_timeline_group
  ON conversation_timeline(platform, account, group_id, created_at);

CREATE TABLE IF NOT EXISTS channel_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  native_label_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  kind TEXT NOT NULL DEFAULT 'label',
  raw_json TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, account, native_label_id)
);

CREATE TABLE IF NOT EXISTS channel_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'group',
  raw_json TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, account, group_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_groups_account
  ON channel_groups(platform, account, synced_at);

CREATE TABLE IF NOT EXISTS conversation_label_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  native_label_id TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, account, group_id, native_label_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_label_map_group
  ON conversation_label_map(platform, account, group_id);

CREATE TABLE IF NOT EXISTS service_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  service_account TEXT NOT NULL,
  native_group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  parent_native_group_id TEXT,
  group_level INTEGER NOT NULL DEFAULT 1,
  is_manual INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  raw_json TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, service_account, native_group_id)
);

CREATE INDEX IF NOT EXISTS idx_service_groups_account
  ON service_groups(platform, service_account, source, name);

CREATE TABLE IF NOT EXISTS conversation_service_group_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  service_account TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  native_group_id TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, service_account, chat_id, native_group_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_service_group_map_chat
  ON conversation_service_group_map(platform, service_account, chat_id);

CREATE TABLE IF NOT EXISTS operator_service_group_scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  service_account TEXT NOT NULL,
  native_group_id TEXT NOT NULL,
  can_view INTEGER NOT NULL DEFAULT 1,
  can_reply INTEGER NOT NULL DEFAULT 0,
  can_assign INTEGER NOT NULL DEFAULT 0,
  can_manage INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(operator_id, platform, service_account, native_group_id)
);

CREATE INDEX IF NOT EXISTS idx_operator_service_group_scopes_lookup
  ON operator_service_group_scopes(operator_id, platform, service_account);
