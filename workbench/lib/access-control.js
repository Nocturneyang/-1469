const PERMISSIONS = [
  { code: 'monitor:view', category: 'monitor', name: '查看监控系统', description: '访问监控看板、分析结果和知识资产只读页面' },
  { code: 'monitor:raw:view', category: 'monitor', name: '查看原始数据', description: '访问原始消息流、媒体和底层采集数据' },
  { code: 'monitor:config:write', category: 'monitor', name: '管理监控配置', description: '修改 Webhook、AI、区域、价值标签和内部员工配置' },
  { code: 'monitor:accounts:manage', category: 'monitor', name: '管理采集账号', description: '创建、重启、重登和删除 WA/TG/Teams 采集账号' },
  { code: 'monitor:logs:view', category: 'monitor', name: '查看系统日志', description: '查看 PM2 进程和运行日志' },
  { code: 'monitor:assets:write', category: 'monitor', name: '管理知识资产', description: '审核、沉淀、导出和维护知识资产' },
  { code: 'workbench:view', category: 'workbench', name: '进入客服工作台', description: '访问工作台并查看授权范围内的会话' },
  { code: 'workbench:reply', category: 'workbench', name: '工作台回复', description: '在授权服务账号和分组内发送回复' },
  { code: 'workbench:assign', category: 'workbench', name: '工作台分配', description: '认领、移交或释放授权会话' },
  { code: 'workbench:manage', category: 'workbench', name: '工作台管理', description: '同步渠道分组并管理工作台服务范围' },
  { code: 'admin:users:manage', category: 'admin', name: '管理用户', description: '管理本地用户、SSO 管理员和登录兜底账号' },
  { code: 'admin:access:manage', category: 'admin', name: '管理角色权限', description: '管理统一角色、权限项、入口权限和数据范围' },
];

const ROLE_DEFINITIONS = [
  {
    code: 'super_admin',
    name: '超级管理员',
    description: '拥有监控系统、工作台和统一后台的全部权限',
    permissions: ['*'],
  },
  {
    code: 'monitor_admin',
    name: '监控管理员',
    description: '管理监控系统配置、采集账号、日志和知识资产',
    permissions: [
      'monitor:view',
      'monitor:raw:view',
      'monitor:config:write',
      'monitor:accounts:manage',
      'monitor:logs:view',
      'monitor:assets:write',
      'admin:users:manage',
    ],
  },
  {
    code: 'monitor_viewer',
    name: '监控只读',
    description: '查看监控看板、分析结果和知识资产，不可修改配置',
    permissions: ['monitor:view'],
  },
  {
    code: 'workbench_manager',
    name: '工作台主管',
    description: '进入客服工作台，并具备回复、分配和管理工作台范围的能力',
    permissions: ['workbench:view', 'workbench:reply', 'workbench:assign', 'workbench:manage'],
  },
  {
    code: 'agent',
    name: '客服坐席',
    description: '进入客服工作台，具体查看和回复范围由服务账号/分组授权决定',
    permissions: ['workbench:view'],
  },
];

const PERMISSION_CODE_SET = new Set(PERMISSIONS.map((permission) => permission.code));
const ROLE_CODE_SET = new Set(ROLE_DEFINITIONS.map((role) => role.code));

function permissionCodes() {
  return PERMISSIONS.map((permission) => permission.code);
}

function normalizeCode(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePermissionCode(value) {
  const code = normalizeCode(value);
  return PERMISSION_CODE_SET.has(code) ? code : '';
}

function normalizeRoleCode(value) {
  const code = normalizeCode(value);
  if (!code) return '';
  if (/^[a-z][a-z0-9_:-]{1,63}$/.test(code)) return code;
  return ROLE_CODE_SET.has(code) ? code : '';
}

function rolePermissionCodes(role) {
  const permissions = Array.isArray(role?.permissions) ? role.permissions : [];
  if (permissions.includes('*')) return permissionCodes();
  return permissions.map(normalizePermissionCode).filter(Boolean);
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}

function migrateAccessControlSchema(db) {
  ensureColumn(db, 'operator_portal_access', 'can_admin', 'can_admin INTEGER NOT NULL DEFAULT 0');
}

function seedAccessControl(db) {
  const insertPermission = db.prepare(`
    INSERT INTO access_permissions (code, category, name, description, is_system)
    VALUES (@code, @category, @name, @description, 1)
    ON CONFLICT(code) DO UPDATE SET
      category = excluded.category,
      name = excluded.name,
      description = excluded.description,
      is_system = 1,
      updated_at = CURRENT_TIMESTAMP
  `);
  PERMISSIONS.forEach((permission) => insertPermission.run(permission));

  const insertRole = db.prepare(`
    INSERT INTO access_roles (code, name, description, is_system)
    VALUES (@code, @name, @description, 1)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      is_system = 1,
      updated_at = CURRENT_TIMESTAMP
  `);
  const insertRolePermission = db.prepare(`
    INSERT OR IGNORE INTO access_role_permissions (role_code, permission_code)
    VALUES (?, ?)
  `);
  ROLE_DEFINITIONS.forEach((role) => {
    insertRole.run(role);
    rolePermissionCodes(role).forEach((permissionCode) => {
      insertRolePermission.run(role.code, permissionCode);
    });
  });
}

function listPermissions(db) {
  return db.prepare(`
    SELECT code, category, name, description, is_system, created_at, updated_at
    FROM access_permissions
    ORDER BY category ASC, code ASC
  `).all();
}

function listRoles(db) {
  const roles = db.prepare(`
    SELECT code, name, description, is_system, created_at, updated_at
    FROM access_roles
    ORDER BY is_system DESC, code ASC
  `).all();
  const permissionsByRole = db.prepare(`
    SELECT role_code, permission_code
    FROM access_role_permissions
    ORDER BY permission_code ASC
  `).all().reduce((out, row) => {
    if (!out[row.role_code]) out[row.role_code] = [];
    out[row.role_code].push(row.permission_code);
    return out;
  }, {});
  return roles.map((role) => ({
    ...role,
    permissions: permissionsByRole[role.code] || [],
  }));
}

function setRolePermissions(db, roleCode, permissions) {
  const code = normalizeRoleCode(roleCode);
  if (!code) throw new Error('invalid role code');
  const validPermissions = [...new Set((permissions || []).map(normalizePermissionCode).filter(Boolean))];
  const role = db.prepare('SELECT code FROM access_roles WHERE code = ?').get(code);
  if (!role) throw new Error(`role not found: ${code}`);
  const save = db.transaction(() => {
    db.prepare('DELETE FROM access_role_permissions WHERE role_code = ?').run(code);
    const insert = db.prepare(`
      INSERT INTO access_role_permissions (role_code, permission_code)
      VALUES (?, ?)
    `);
    validPermissions.forEach((permissionCode) => insert.run(code, permissionCode));
    db.prepare('UPDATE access_roles SET updated_at = CURRENT_TIMESTAMP WHERE code = ?').run(code);
  });
  save();
  return db.prepare('SELECT * FROM access_roles WHERE code = ?').get(code);
}

function createRole(db, input = {}) {
  const code = normalizeRoleCode(input.code);
  if (!code) throw new Error('invalid role code');
  const name = String(input.name || code).trim();
  const description = String(input.description || '').trim();
  db.prepare(`
    INSERT INTO access_roles (code, name, description, is_system)
    VALUES (?, ?, ?, 0)
  `).run(code, name, description);
  setRolePermissions(db, code, input.permissions || []);
  return db.prepare('SELECT * FROM access_roles WHERE code = ?').get(code);
}

function listOperatorRoles(db, operatorId) {
  return db.prepare(`
    SELECT role_code
    FROM operator_roles
    WHERE operator_id = ?
    ORDER BY role_code ASC
  `).all(operatorId).map((row) => row.role_code);
}

function setOperatorRoles(db, operatorId, roles, assignedBy = 'system') {
  const id = String(operatorId || '').trim();
  if (!id) throw new Error('operator_id is required');
  const validRoles = [...new Set((roles || []).map(normalizeRoleCode).filter(Boolean))];
  const existing = new Set(db.prepare('SELECT code FROM access_roles').all().map((row) => row.code));
  const filtered = validRoles.filter((roleCode) => existing.has(roleCode));
  const save = db.transaction(() => {
    db.prepare('DELETE FROM operator_roles WHERE operator_id = ?').run(id);
    const insert = db.prepare(`
      INSERT INTO operator_roles (operator_id, role_code, assigned_by)
      VALUES (?, ?, ?)
    `);
    filtered.forEach((roleCode) => insert.run(id, roleCode, assignedBy));
  });
  save();
  return listOperatorRoles(db, id);
}

module.exports = {
  PERMISSIONS,
  ROLE_DEFINITIONS,
  createRole,
  listOperatorRoles,
  listPermissions,
  listRoles,
  migrateAccessControlSchema,
  normalizePermissionCode,
  normalizeRoleCode,
  permissionCodes,
  seedAccessControl,
  setOperatorRoles,
  setRolePermissions,
};
