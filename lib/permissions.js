const { ensureOperator } = require('../db/workbench-db');
const { accountScopeContains, normalizePlatform } = require('../db/raw-messages');
const {
  listOperatorRoles,
  normalizePermissionCode,
  permissionCodes,
} = require('./access-control');

const ALL_GROUPS = '*';
const UNGROUPED_GROUP = '__ungrouped__';
const CAPABILITIES = ['can_view', 'can_reply', 'can_assign', 'can_manage'];
const DEFAULT_SUPER_ADMIN_IDENTITIES = ['1469'];
const DEFAULT_PORTAL_ACCESS = {
  can_monitor: false,
  can_workbench: false,
  can_admin: false,
  default_entry: 'auto',
  landing: '/entry',
};

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function operatorIdentities(operator = {}) {
  return [
    operator.id,
    operator.username,
    operator.display_name,
    operator.displayName,
    operator.name,
    operator.email,
    operator.mobile,
    operator.department,
    ...(Array.isArray(operator.identities) ? operator.identities : []),
  ].filter(Boolean).map((item) => String(item).trim()).filter(Boolean);
}

function requestUserIdentities(req) {
  const user = req && req.user ? req.user : {};
  return [
    user.id,
    user.username,
    user.display_name,
    user.displayName,
    user.name,
    user.email,
    user.mobile,
    user.department,
  ].filter(Boolean).map((item) => String(item).trim()).filter(Boolean);
}

function resolveWorkbenchOperator(db, req) {
  const user = req && req.user ? req.user : null;
  let id = '';
  let username = '';
  let displayName = '';
  let role = 'agent';
  let identities = [];

  const allowHeaderOperator = req &&
    req.authSource === 'local-dev' &&
    req.header &&
    String(req.header('x-operator-id') || '').trim();

  if (user && !allowHeaderOperator) {
    identities = requestUserIdentities(req);
    id = String(user.id || user.username || user.email || identities[0] || '').trim();
    username = String(user.username || user.email || id || '').trim();
    displayName = String(user.display_name || user.displayName || user.name || username || id).trim();
    role = String(user.role || 'agent').trim() || 'agent';
  } else {
    id = String(req && req.header ? req.header('x-operator-id') : '').trim() || 'demo-operator';
    username = id;
    displayName = String(req && req.header ? req.header('x-operator-name') : '').trim() || id;
    role = String(req && req.header ? req.header('x-operator-role') : '').trim() || 'agent';
    identities = [id, username, displayName];
  }

  const operatorId = ensureOperator(db, id || 'demo-operator', displayName || id || 'demo-operator');
  const stored = db.prepare('SELECT * FROM operators WHERE id = ?').get(operatorId);
  return {
    id: operatorId,
    username: stored && stored.username ? stored.username : username || operatorId,
    display_name: stored && stored.display_name ? stored.display_name : displayName || operatorId,
    role: stored && stored.role ? stored.role : role,
    status: stored && stored.status ? stored.status : 'active',
    user,
    identities: [...new Set([operatorId, username, displayName, ...identities].filter(Boolean))],
    is_super_admin: isWorkbenchSuperAdmin(db, {
      id: operatorId,
      username,
      display_name: displayName,
      role: stored && stored.role ? stored.role : role,
      identities,
    }),
  };
}

function isWorkbenchSuperAdmin(db, operator = {}) {
  const role = String(operator.role || '').trim().toLowerCase();
  if (role === 'super_admin' || role === 'workbench_super_admin') return true;

  const identities = operatorIdentities(operator);
  if (!identities.length) return false;
  const allowed = new Set([
    ...DEFAULT_SUPER_ADMIN_IDENTITIES,
    ...parseList(process.env.WORKBENCH_SUPER_ADMINS),
    ...loadDbSuperAdmins(db),
  ].map((item) => String(item).trim()).filter(Boolean));
  return identities.some((identity) => allowed.has(identity));
}

function loadDbSuperAdmins(db) {
  try {
    const rows = db.prepare(`
      SELECT identity
      FROM workbench_super_admins
      WHERE status = 'active'
    `).all();
    return rows.map((row) => row.identity);
  } catch (err) {
    return [];
  }
}

function requireWorkbenchSuperAdmin(db) {
  return (req, res, next) => {
    const operator = resolveWorkbenchOperator(db, req);
    req.workbenchOperator = operator;
    if (operator.is_super_admin) return next();
    return res.status(403).json({ success: false, ok: false, error: 'Workbench super admin access required' });
  };
}

function legacyRoleCodes(operator = {}) {
  if (operator.is_super_admin || isWorkbenchSuperAdmin(nullSafeDb(operator), operator)) return ['super_admin'];
  const role = String(operator.user && operator.user.role || operator.role || '').trim().toLowerCase();
  if (role === 'admin' || role === 'administrator' || role === 'owner') return ['super_admin'];
  if (role === 'viewer' || role === 'view' || role === 'readonly' || role === 'read_only' || role === 'user') {
    return ['monitor_viewer'];
  }
  if (['super_admin', 'monitor_admin', 'monitor_viewer', 'workbench_manager', 'agent'].includes(role)) {
    return [role];
  }
  return [];
}

function nullSafeDb(operator) {
  return operator && operator.__db ? operator.__db : null;
}

function operatorRoleCodes(db, operator = {}) {
  if (!operator || !operator.id) return [];
  const withDb = { ...operator, __db: db };
  const roles = new Set(legacyRoleCodes(withDb));
  try {
    const identities = operatorIdentities(operator);
    identities.forEach((identity) => {
      listOperatorRoles(db, identity).forEach((roleCode) => roles.add(roleCode));
    });
  } catch (_) {
    // Keep legacy permissions available if the RBAC tables are temporarily unavailable.
  }
  if (operator.is_super_admin || isWorkbenchSuperAdmin(db, operator)) roles.add('super_admin');
  return [...roles].filter(Boolean).sort();
}

function operatorPermissionSet(db, operator = {}) {
  const roles = operatorRoleCodes(db, operator);
  const allCodes = permissionCodes();
  if (roles.includes('super_admin')) return new Set(allCodes);
  if (!roles.length) return new Set();
  try {
    const placeholders = roles.map((_, index) => `@role${index}`).join(', ');
    const params = Object.fromEntries(roles.map((roleCode, index) => [`role${index}`, roleCode]));
    const rows = db.prepare(`
      SELECT DISTINCT permission_code
      FROM access_role_permissions
      WHERE role_code IN (${placeholders})
    `).all(params);
    return new Set(rows.map((row) => row.permission_code).filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

function operatorHasPermission(db, operator, permission) {
  const code = normalizePermissionCode(permission);
  if (!code) return false;
  return operatorPermissionSet(db, operator).has(code);
}

function operatorHasAnyPermission(db, operator, permissions = []) {
  const set = operatorPermissionSet(db, operator);
  return permissions.some((permission) => set.has(permission));
}

function hasAdminPermission(permissionSet) {
  return [...permissionSet].some((permission) => String(permission).startsWith('admin:'));
}

function attachAccessContext(db) {
  return (req, res, next) => {
    try {
      const operator = resolveWorkbenchOperator(db, req);
      const roles = operatorRoleCodes(db, operator);
      const permissions = [...operatorPermissionSet(db, operator)].sort();
      const portalAccess = loadPortalAccess(db, operator);
      req.workbenchOperator = operator;
      req.access = {
        operator,
        roles,
        permissions,
        portal_access: portalAccess,
        is_super_admin: operator.is_super_admin || roles.includes('super_admin'),
      };
    } catch (err) {
      console.warn('[access] failed to attach access context:', err.message);
    }
    next();
  };
}

function requirePermission(db, permission) {
  return (req, res, next) => {
    const operator = req.workbenchOperator || resolveWorkbenchOperator(db, req);
    const permissions = operatorPermissionSet(db, operator);
    const code = normalizePermissionCode(permission);
    req.workbenchOperator = operator;
    req.access = {
      ...(req.access || {}),
      operator,
      roles: operatorRoleCodes(db, operator),
      permissions: [...permissions].sort(),
      portal_access: loadPortalAccess(db, operator),
      is_super_admin: operator.is_super_admin || permissions.size === permissionCodes().length,
    };
    if (code && permissions.has(code)) return next();
    return res.status(403).json({ success: false, ok: false, error: `Permission required: ${permission}` });
  };
}

function requireAnyPermission(db, permissions = []) {
  return (req, res, next) => {
    const operator = req.workbenchOperator || resolveWorkbenchOperator(db, req);
    if (operatorHasAnyPermission(db, operator, permissions)) {
      req.workbenchOperator = operator;
      return next();
    }
    return res.status(403).json({ success: false, ok: false, error: `Permission required: ${permissions.join(' or ')}` });
  };
}

function loadOperatorScopes(db, operatorId) {
  return db.prepare(`
    SELECT *
    FROM operator_service_group_scopes
    WHERE operator_id = ?
  `).all(operatorId);
}

function normalizeDefaultEntry(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['monitor', 'workbench', 'admin', 'chooser', 'auto'].includes(normalized)) return normalized;
  return 'auto';
}

function hasAnyWorkbenchScope(db, operatorId) {
  const row = db.prepare(`
    SELECT 1 AS found
    FROM operator_service_group_scopes
    WHERE operator_id = ?
      AND can_view = 1
    LIMIT 1
  `).get(operatorId);
  return Boolean(row);
}

function loadPortalAccess(db, operator = {}) {
  if (!operator || !operator.id) return { ...DEFAULT_PORTAL_ACCESS };
  if (operator.is_super_admin || isWorkbenchSuperAdmin(db, operator)) {
    return resolvePortalLanding({
      can_monitor: true,
      can_workbench: true,
      can_admin: true,
      default_entry: 'chooser',
    });
  }

  const permissions = operatorPermissionSet(db, operator);
  const derived = {
    can_monitor: permissions.has('monitor:view'),
    can_workbench: permissions.has('workbench:view') || hasAnyWorkbenchScope(db, operator.id),
    can_admin: hasAdminPermission(permissions),
  };

  const row = db.prepare(`
    SELECT *
    FROM operator_portal_access
    WHERE operator_id = ?
  `).get(operator.id);

  if (row) {
    return resolvePortalLanding({
      can_monitor: Number(row.can_monitor) === 1 || derived.can_monitor,
      can_workbench: Number(row.can_workbench) === 1 || derived.can_workbench,
      can_admin: Number(row.can_admin) === 1 || derived.can_admin,
      default_entry: normalizeDefaultEntry(row.default_entry),
    });
  }

  const userRole = String(operator.user && operator.user.role || operator.role || '').trim().toLowerCase();
  return resolvePortalLanding({
    can_monitor: derived.can_monitor || ['admin', 'viewer', 'view', 'user'].includes(userRole),
    can_workbench: derived.can_workbench,
    can_admin: derived.can_admin || ['admin'].includes(userRole),
    default_entry: 'auto',
  });
}

function resolvePortalLanding(access) {
  const canMonitor = Boolean(access.can_monitor);
  const canWorkbench = Boolean(access.can_workbench);
  const canAdmin = Boolean(access.can_admin);
  const defaultEntry = normalizeDefaultEntry(access.default_entry);
  let landing = '/entry';
  const allowedCount = [canMonitor, canWorkbench, canAdmin].filter(Boolean).length;
  if (allowedCount === 1 && canWorkbench) landing = '/workbench/';
  else if (allowedCount === 1 && canMonitor) landing = '/';
  else if (allowedCount === 1 && canAdmin) landing = '/admin/users';
  else if (allowedCount > 1) {
    if (defaultEntry === 'workbench') landing = '/workbench/';
    else if (defaultEntry === 'monitor') landing = '/';
    else if (defaultEntry === 'admin') landing = '/admin/users';
    else landing = '/entry';
  }
  return {
    can_monitor: canMonitor,
    can_workbench: canWorkbench,
    can_admin: canAdmin,
    default_entry: defaultEntry,
    landing,
  };
}

function requireMonitorPortalAccess(db) {
  return (req, res, next) => {
    const operator = req.workbenchOperator || resolveWorkbenchOperator(db, req);
    req.workbenchOperator = operator;
    const access = loadPortalAccess(db, operator);
    if (access.can_monitor) return next();
    return res.status(403).json({ success: false, ok: false, error: 'Monitor access is not allowed for this operator' });
  };
}

function requireWorkbenchPortalAccess(db) {
  return (req, res, next) => {
    const operator = req.workbenchOperator || resolveWorkbenchOperator(db, req);
    req.workbenchOperator = operator;
    const access = loadPortalAccess(db, operator);
    if (access.can_workbench) return next();
    return res.status(403).json({ success: false, ok: false, error: 'Workbench access is not allowed for this operator' });
  };
}

function requireAdminPortalAccess(db) {
  return (req, res, next) => {
    const operator = req.workbenchOperator || resolveWorkbenchOperator(db, req);
    req.workbenchOperator = operator;
    const access = loadPortalAccess(db, operator);
    if (access.can_admin) return next();
    return res.status(403).json({ success: false, ok: false, error: 'Admin access is not allowed for this operator' });
  };
}

function scopeCapability(row, capability) {
  if (!CAPABILITIES.includes(capability)) return false;
  return Number(row && row[capability]) === 1;
}

function scopeKey(platform, account) {
  return `${normalizePlatform(platform)}:${String(account || '').trim()}`;
}

function groupScopeMap(scopes) {
  const map = new Map();
  scopes.forEach((scope) => {
    const key = scopeKey(scope.platform, scope.service_account);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(scope);
  });
  return map;
}

function allowedAccountScope(db, operator, baseAccountScope, capability = 'can_view') {
  if (operator && operator.is_super_admin) return baseAccountScope;
  const portalAccess = loadPortalAccess(db, operator);
  if (!portalAccess.can_workbench) {
    return {
      mode: 'operator-no-workbench',
      active: true,
      accounts: [],
    };
  }
  const scopes = loadOperatorScopes(db, operator.id).filter((scope) => scopeCapability(scope, capability));
  const deduped = [];
  const seen = new Set();
  scopes.forEach((scope) => {
    const platform = normalizePlatform(scope.platform);
    const account = String(scope.service_account || '').trim();
    if (!platform || !account) return;
    if (!accountScopeContains(baseAccountScope, platform, account)) return;
    const key = scopeKey(platform, account);
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push({ platform, account });
  });
  return {
    mode: operator && operator.id ? `operator-${capability}` : 'operator',
    active: true,
    accounts: deduped,
  };
}

function nativeGroupIdsForConversation(db, platform, account, groupId) {
  const rows = db.prepare(`
    SELECT native_group_id
    FROM conversation_service_group_map
    WHERE platform = @platform
      AND service_account = @account
      AND chat_id = @groupId
  `).all({
    platform: normalizePlatform(platform),
    account: String(account || '').trim(),
    groupId: String(groupId || '').trim(),
  });
  return rows.map((row) => String(row.native_group_id || '').trim()).filter(Boolean);
}

function groupParentMap(db, platform, account, nativeGroupIds = []) {
  const ids = [...new Set((nativeGroupIds || []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const params = {
    platform: normalizePlatform(platform),
    account: String(account || '').trim(),
  };
  const placeholders = ids.map((id, index) => {
    const key = `id${index}`;
    params[key] = id;
    return `@${key}`;
  });
  const rows = db.prepare(`
    SELECT native_group_id, parent_native_group_id
    FROM service_groups
    WHERE platform = @platform
      AND service_account = @account
      AND native_group_id IN (${placeholders.join(', ')})
  `).all(params);
  return new Map(rows.map((row) => [
    String(row.native_group_id || '').trim(),
    String(row.parent_native_group_id || '').trim(),
  ]));
}

function nativeIdsMatchAllowedScopes(db, platform, account, nativeIds, allowedScopes) {
  const normalizedNativeIds = [...new Set((nativeIds || []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (!normalizedNativeIds.length) return false;
  const allowedIds = new Set(allowedScopes.map((scope) => String(scope.native_group_id || '').trim()).filter(Boolean));
  if (normalizedNativeIds.some((nativeId) => allowedIds.has(nativeId))) return true;
  const parents = groupParentMap(db, platform, account, normalizedNativeIds);
  return normalizedNativeIds.some((nativeId) => {
    const parentId = parents.get(nativeId);
    return parentId && allowedIds.has(parentId);
  });
}

function conversationHasCapability(db, operator, platform, account, groupId, capability = 'can_view', nativeGroupIds = null) {
  if (operator && operator.is_super_admin) return true;
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedAccount = String(account || '').trim();
  const scopes = groupScopeMap(loadOperatorScopes(db, operator.id)).get(scopeKey(normalizedPlatform, normalizedAccount)) || [];
  if (!scopes.length) return false;
  const allowed = scopes.filter((scope) => scopeCapability(scope, capability));
  if (!allowed.length) return false;
  if (allowed.some((scope) => scope.native_group_id === ALL_GROUPS)) return true;
  const nativeIds = nativeGroupIds || nativeGroupIdsForConversation(db, normalizedPlatform, normalizedAccount, groupId);
  if (!nativeIds.length) {
    return allowed.some((scope) => scope.native_group_id === UNGROUPED_GROUP);
  }
  return nativeIdsMatchAllowedScopes(db, normalizedPlatform, normalizedAccount, nativeIds, allowed);
}

function conversationCapabilities(db, operator, group) {
  const nativeIds = (group.labels || [])
    .map((label) => label.native_group_id || label.native_label_id)
    .filter(Boolean)
    .map((item) => String(item));
  return CAPABILITIES.reduce((out, capability) => {
    out[capability] = conversationHasCapability(
      db,
      operator,
      group.platform,
      group.account,
      group.group_id,
      capability,
      nativeIds,
    );
    return out;
  }, {});
}

function filterGroupsByCapability(db, operator, groups, capability = 'can_view') {
  if (operator && operator.is_super_admin) {
    return groups.map((group) => ({
      ...group,
      permissions: conversationCapabilities(db, operator, group),
    }));
  }
  return groups
    .map((group) => ({
      ...group,
      permissions: conversationCapabilities(db, operator, group),
    }))
    .filter((group) => group.permissions && group.permissions[capability]);
}

function requireConversationCapability(db, operator, platform, account, groupId, capability = 'can_view') {
  if (!conversationHasCapability(db, operator, platform, account, groupId, capability)) {
    const label = capability.replace(/^can_/, '');
    const err = new Error(`operator does not have ${label} permission for this conversation`);
    err.statusCode = 403;
    throw err;
  }
}

function serviceGroupVisible(db, operator, group, capability = 'can_view') {
  if (operator && operator.is_super_admin) return true;
  const scopes = groupScopeMap(loadOperatorScopes(db, operator.id)).get(scopeKey(group.platform, group.service_account || group.account)) || [];
  return scopes.some((scope) => (
    scopeCapability(scope, capability) &&
    (
      scope.native_group_id === ALL_GROUPS ||
      scope.native_group_id === group.native_group_id ||
      (group.parent_native_group_id && scope.native_group_id === group.parent_native_group_id)
    )
  ));
}

function capabilitySummary(db, operator, baseAccountScope) {
  const viewScope = allowedAccountScope(db, operator, baseAccountScope, 'can_view');
  const replyScope = allowedAccountScope(db, operator, baseAccountScope, 'can_reply');
  const assignScope = allowedAccountScope(db, operator, baseAccountScope, 'can_assign');
  const manageScope = allowedAccountScope(db, operator, baseAccountScope, 'can_manage');
  return {
    accounts_viewable: viewScope.accounts.length,
    accounts_replyable: replyScope.accounts.length,
    accounts_assignable: assignScope.accounts.length,
    accounts_manageable: manageScope.accounts.length,
  };
}

module.exports = {
  ALL_GROUPS,
  UNGROUPED_GROUP,
  allowedAccountScope,
  attachAccessContext,
  capabilitySummary,
  conversationCapabilities,
  conversationHasCapability,
  filterGroupsByCapability,
  isWorkbenchSuperAdmin,
  loadPortalAccess,
  nativeGroupIdsForConversation,
  operatorHasAnyPermission,
  operatorHasPermission,
  operatorIdentities,
  operatorPermissionSet,
  operatorRoleCodes,
  requireAdminPortalAccess,
  requireAnyPermission,
  requireConversationCapability,
  requireMonitorPortalAccess,
  requirePermission,
  requireWorkbenchPortalAccess,
  requireWorkbenchSuperAdmin,
  resolveWorkbenchOperator,
  resolvePortalLanding,
  serviceGroupVisible,
};
