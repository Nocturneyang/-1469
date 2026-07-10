const fs = require('fs');
const path = require('path');

const { deleteServiceAccountProfile, ensureRawDb, upsertServiceAccountProfile } = require('../db/raw-db');
const { openRuntimeDb } = require('../db/runtime-db');
const { openWorkbenchDb } = require('../db/workbench-db');
const { resolveDataDir } = require('../db/paths');
const {
  deleteAccountData,
  ensureAccountDatabases,
  isAccountDbModeEnabled,
  listAccountRefs,
  normalizeAccountPlatform,
  resolveAccountPaths,
  sanitizeAccountSegment,
} = require('../db/account-db');
const rawMessages = require('../db/raw-messages');
const {
  createServiceAccountLoginRequest,
  deleteServiceAccountLoginRequest,
  getServiceAccountLoginRequest,
  listServiceAccountLoginRequests,
  updateServiceAccountLoginRequest,
} = require('./service-account-login-store');

function createAccountDataAccess({
  legacyRawDbPath,
  legacyRuntimeDb,
  legacyWorkbenchDb,
  accountDataDir,
  accountDbMode = process.env.WORKBENCH_ACCOUNT_DB_MODE,
} = {}) {
  const isolated = isAccountDbModeEnabled(accountDbMode);

  function refs() {
    return listAccountRefs({ accountDataDir });
  }

  function accountScopeFor(ref) {
    return {
      active: true,
      accounts: [{ platform: ref.platform, account: ref.account }],
    };
  }

  function filterRefs({ accountScope, platforms } = {}) {
    const normalizedPlatforms = rawMessages.normalizePlatformList(platforms);
    return refs().filter((ref) => (
      (!normalizedPlatforms.length || normalizedPlatforms.includes(ref.platform)) &&
      rawMessages.accountScopeContains(accountScope, ref.platform, ref.account)
    ));
  }

  function resolveScope(options = {}) {
    if (!isolated) {
      return rawMessages.resolveAccountScope({ rawDbPath: legacyRawDbPath, ...options });
    }
    const explicitScope = rawMessages.parseAccountScopeList(options.explicitAccounts ??
      process.env.WORKBENCH_VISIBLE_SERVICE_ACCOUNTS ??
      process.env.WORKBENCH_SERVICE_ACCOUNTS ??
      process.env.WORKBENCH_SEND_ACCOUNTS ??
      process.env.WORKBENCH_VISIBLE_ACCOUNTS ??
      '');
    if (explicitScope.active) return { mode: 'explicit', ...explicitScope };
    if (options.filterLoggedIn === false || process.env.WORKBENCH_FILTER_LOGGED_IN_ACCOUNTS === '0') {
      return { mode: 'all', active: false, accounts: [] };
    }
    const accounts = refs().map((ref) => ({ platform: ref.platform, account: ref.account }));
    if (!accounts.length) {
      const fallback = rawMessages.resolveAccountScope({ rawDbPath: legacyRawDbPath, ...options });
      return { mode: fallback.mode === 'all' ? 'account-db' : fallback.mode, ...fallback };
    }
    return {
      mode: 'account-db',
      active: true,
      accounts,
    };
  }

  function withRuntimeDb(platform, account, options, fn) {
    if (!isolated) return fn(legacyRuntimeDb, { isolated: false });
    const paths = options?.create
      ? ensureAccountDatabases(platform, account, { accountDataDir })
      : resolveAccountPaths(platform, account, { accountDataDir });
    const db = openRuntimeDb(paths.runtimeDbPath);
    try {
      return fn(db, { isolated: true, paths });
    } finally {
      db.close();
    }
  }

  function withWorkbenchDb(platform, account, options = {}, fn) {
    if (!isolated) return fn(legacyWorkbenchDb, { isolated: false });
    const paths = options.create
      ? ensureAccountDatabases(platform, account, { accountDataDir })
      : resolveAccountPaths(platform, account, { accountDataDir });
    const db = openWorkbenchDb(paths.workbenchDbPath);
    try {
      return fn(db, { isolated: true, paths, platform: paths.platform, account: paths.account });
    } finally {
      db.close();
    }
  }

  function mapWorkbenchDbs(options = {}, fn) {
    if (!isolated) return [fn(legacyWorkbenchDb, { isolated: false })];
    return filterRefs(options).map((ref) => {
      // 会话列表会一次读取多份账号库。只读路径不再重复执行 schema migration、默认数据写入，
      // 避免与 worker 的写入争锁，也显著缩短首屏聚合时间。
      const db = openWorkbenchDb(ref.paths.workbenchDbPath, { readonly: !options.writable });
      try {
        return fn(db, { isolated: true, paths: ref.paths, platform: ref.platform, account: ref.account });
      } finally {
        db.close();
      }
    });
  }

  function createLoginRequest(options = {}) {
    return withRuntimeDb(options.platform, options.account, { create: true }, (runtimeDb, context) => {
      const request = createServiceAccountLoginRequest({
        ...options,
        runtimeDb,
        account_runtime_db_path: context.paths?.runtimeDbPath,
      });
      return context.paths ? { ...request, account_runtime_db_path: context.paths.runtimeDbPath } : request;
    });
  }

  function listLoginRequests(options = {}) {
    if (!isolated) return listServiceAccountLoginRequests(legacyRuntimeDb, options);
    const requests = [];
    listAccountRefs({ accountDataDir }).forEach((ref) => {
      if (!fs.existsSync(ref.paths.runtimeDbPath)) return;
      const db = openRuntimeDb(ref.paths.runtimeDbPath);
      try {
        requests.push(...listServiceAccountLoginRequests(db, options).map((request) => ({
          ...request,
          account_runtime_db_path: ref.paths.runtimeDbPath,
        })));
      } finally {
        db.close();
      }
    });
    return requests
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || String(b.request_id).localeCompare(String(a.request_id)))
      .slice(0, Math.max(1, Math.min(Number(options.limit) || 30, 100)));
  }

  function findRuntimeDbForRequest(requestId, fn) {
    if (!isolated) return fn(legacyRuntimeDb, { isolated: false });
    for (const ref of listAccountRefs({ accountDataDir })) {
      if (!fs.existsSync(ref.paths.runtimeDbPath)) continue;
      const db = openRuntimeDb(ref.paths.runtimeDbPath);
      try {
        const request = getServiceAccountLoginRequest(db, requestId);
        if (!request) continue;
        return fn(db, { isolated: true, paths: ref.paths, request });
      } finally {
        db.close();
      }
    }
    return fn(null, { isolated: true });
  }

  function getLoginRequest(requestId) {
    return findRuntimeDbForRequest(requestId, (runtimeDb, context) => {
      if (!runtimeDb) return null;
      const request = context.request || getServiceAccountLoginRequest(runtimeDb, requestId);
      return context.paths ? { ...request, account_runtime_db_path: context.paths.runtimeDbPath } : request;
    });
  }

  function updateLoginRequest(requestId, patch) {
    return findRuntimeDbForRequest(requestId, (runtimeDb, context) => {
      if (!runtimeDb) return null;
      const request = updateServiceAccountLoginRequest(runtimeDb, requestId, patch);
      return request && context.paths ? { ...request, account_runtime_db_path: context.paths.runtimeDbPath } : request;
    });
  }

  function deleteLoginRequest(requestId, options = {}) {
    const request = findRuntimeDbForRequest(requestId, (runtimeDb, context) => {
      if (!runtimeDb) return null;
      const deleted = deleteServiceAccountLoginRequest(runtimeDb, requestId, options);
      return deleted && context.paths ? { ...deleted, account_runtime_db_path: context.paths.runtimeDbPath } : deleted;
    });
    if (!request || !options.permanent) return request;
    return {
      ...request,
      permanent_deleted: true,
      deleted_account_data: deleteServiceAccountData(request, options),
    };
  }

  function upsertProfile(options = {}) {
    if (!isolated) return upsertServiceAccountProfile({ dbPath: legacyRawDbPath, ...options });
    const paths = ensureAccountDatabases(options.platform, options.account, { accountDataDir });
    return upsertServiceAccountProfile({ dbPath: paths.rawDbPath, ...options });
  }

  function ensureAccount(platform, account) {
    if (!isolated) return null;
    return ensureAccountDatabases(platform, account, { accountDataDir });
  }

  function deleteServiceAccountData(request, options = {}) {
    const platform = normalizeAccountPlatform(request.platform);
    const account = String(request.account || '').trim();
    const deletedOutbox = deleteAccountOutboxDirs(options.outboxDir, platform, account);
    if (isolated) {
      return {
        mode: 'isolated',
        ...deleteAccountData(platform, account, { accountDataDir }),
        ...deletedOutbox,
      };
    }
    return {
      mode: 'legacy',
      ...deleteLegacyRuntimeRequestsForAccount(platform, account, request.request_id, legacyRuntimeDb),
      ...deleteServiceAccountProfile({ dbPath: legacyRawDbPath, platform, account }),
      ...deleteLegacySessionFiles(platform, account, options),
      ...deletedOutbox,
    };
  }

  function openAccountRawDb(platform, account, options = {}) {
    if (!isolated) return ensureRawDb(legacyRawDbPath);
    const paths = options.create
      ? ensureAccountDatabases(platform, account, { accountDataDir })
      : resolveAccountPaths(platform, account, { accountDataDir });
    return ensureRawDb(paths.rawDbPath);
  }

  function rawDbPathFor(platform, account, options = {}) {
    if (!isolated) return legacyRawDbPath;
    const paths = options.create
      ? ensureAccountDatabases(platform, account, { accountDataDir })
      : resolveAccountPaths(platform, account, { accountDataDir });
    return paths.rawDbPath;
  }

  function listAccountProfiles(options = {}) {
    if (!isolated) return rawMessages.listAccountProfiles({ rawDbPath: legacyRawDbPath, ...options });
    const rows = [];
    filterRefs(options).forEach((ref) => {
      if (!fs.existsSync(ref.paths.rawDbPath)) return;
      rows.push(...rawMessages.listAccountProfiles({
        rawDbPath: ref.paths.rawDbPath,
        accountScope: accountScopeFor(ref),
      }));
    });
    return dedupeByAccount(rows);
  }

  function findAccountProfile(platform, account, accountScope) {
    return listAccountProfiles({ accountScope })
      .find((profile) => profile.platform === platform && profile.account === account) || null;
  }

  function listAccounts(options = {}) {
    if (!isolated) return rawMessages.listAccounts({ rawDbPath: legacyRawDbPath, ...options });
    const rows = [];
    filterRefs(options).forEach((ref) => {
      if (fs.existsSync(ref.paths.rawDbPath)) {
        rows.push(...rawMessages.listAccounts({
          rawDbPath: ref.paths.rawDbPath,
          accountScope: accountScopeFor(ref),
        }));
      }
      if (!rows.some((row) => row.platform === ref.platform && row.account === ref.account)) {
        rows.push({
          platform: ref.platform,
          account: ref.account,
          message_count: 0,
          last_timestamp: null,
          account_display_name: ref.account,
          account_status: '',
          account_role: 'service',
          send_enabled: 1,
          sync_groups_enabled: 0,
          risk_level: 'low',
        });
      }
    });
    return dedupeByAccount(rows)
      .sort((a, b) => a.platform.localeCompare(b.platform) || a.account.localeCompare(b.account));
  }

  function listGroups(options = {}) {
    if (!isolated) return rawMessages.listGroups({ rawDbPath: legacyRawDbPath, ...options });
    const limit = boundedNumber(options.limit, 80, 1, 500);
    const offset = Math.max(0, Number(options.offset) || 0);
    const perAccountLimit = Math.min(limit + offset, 200);
    const rows = [];
    filterRefs(options).forEach((ref) => {
      if (!fs.existsSync(ref.paths.rawDbPath)) return;
      rows.push(...rawMessages.listGroups({
        rawDbPath: ref.paths.rawDbPath,
        platforms: [ref.platform],
        accountScope: accountScopeFor(ref),
        search: options.search,
        limit: perAccountLimit,
        offset: 0,
      }));
    });
    return rows
      .sort(sortRawGroups)
      .slice(offset, offset + limit);
  }

  function listMessagesPage(options = {}) {
    if (!isolated) return rawMessages.listMessagesPage({ rawDbPath: legacyRawDbPath, ...options });
    return rawMessages.listMessagesPage({
      ...options,
      rawDbPath: rawDbPathFor(options.platform, options.account),
      accountScope: accountScopeFor({ platform: options.platform, account: options.account }),
    });
  }

  function countUnread(options = {}) {
    if (!isolated) return rawMessages.countUnread({ rawDbPath: legacyRawDbPath, ...options });
    return rawMessages.countUnread({
      ...options,
      rawDbPath: rawDbPathFor(options.platform, options.account),
      accountScope: accountScopeFor({ platform: options.platform, account: options.account }),
    });
  }

  function countUnreadForGroups(options = {}) {
    if (!isolated) return rawMessages.countUnreadForGroups({ rawDbPath: legacyRawDbPath, ...options });
    const result = new Map();
    const groupsByAccount = new Map();
    (options.groups || []).forEach((group) => {
      if (!rawMessages.accountScopeContains(options.accountScope, group.platform, group.account)) return;
      const key = `${group.platform}:${group.account}`;
      if (!groupsByAccount.has(key)) groupsByAccount.set(key, []);
      groupsByAccount.get(key).push(group);
    });
    groupsByAccount.forEach((groups, key) => {
      const [platform, account] = key.split(':');
      const counts = rawMessages.countUnreadForGroups({
        rawDbPath: rawDbPathFor(platform, account),
        accountScope: accountScopeFor({ platform, account }),
        groups,
      });
      counts.forEach((value, countKey) => result.set(countKey, value));
    });
    return result;
  }

  function withOutboundDb(id, filters = {}, fn) {
    if (!isolated) {
      const outbound = selectOutbound(legacyWorkbenchDb, id);
      return fn(legacyWorkbenchDb, outbound, { isolated: false, ambiguous: false });
    }
    const matches = [];
    filterRefs({
      platforms: filters.platform ? [filters.platform] : undefined,
      accountScope: filters.platform && filters.account
        ? { active: true, accounts: [{ platform: filters.platform, account: filters.account }] }
        : filters.accountScope,
    }).forEach((ref) => {
      const db = openWorkbenchDb(ref.paths.workbenchDbPath);
      try {
        const outbound = selectOutbound(db, id);
        if (!outbound) return;
        if (filters.platform && outbound.platform !== filters.platform) return;
        if (filters.account && outbound.account !== filters.account) return;
        matches.push({ ref, outbound });
      } finally {
        db.close();
      }
    });
    if (matches.length !== 1) {
      return fn(null, null, { isolated: true, ambiguous: matches.length > 1, matches });
    }
    const match = matches[0];
    const db = openWorkbenchDb(match.ref.paths.workbenchDbPath);
    try {
      const outbound = selectOutbound(db, id);
      return fn(db, outbound, {
        isolated: true,
        ambiguous: false,
        paths: match.ref.paths,
        platform: match.ref.platform,
        account: match.ref.account,
      });
    } finally {
      db.close();
    }
  }

  return {
    ensureAccount,
    get isolated() {
      return isolated;
    },
    createLoginRequest,
    deleteServiceAccountData,
    deleteLoginRequest,
    countUnread,
    countUnreadForGroups,
    findAccountProfile,
    getLoginRequest,
    listLoginRequests,
    listAccountProfiles,
    listAccounts,
    listGroups,
    listMessagesPage,
    mapWorkbenchDbs,
    openAccountRawDb,
    rawDbPathFor,
    resolveAccountScope: resolveScope,
    updateLoginRequest,
    upsertProfile,
    withOutboundDb,
    withRuntimeDb,
    withWorkbenchDb,
  };
}

function deleteLegacyRuntimeRequestsForAccount(platform, account, excludedRequestId, runtimeDb) {
  if (!runtimeDb) return { deleted_sibling_login_requests: 0 };
  const deleted = runtimeDb.prepare(`
    DELETE FROM service_account_login_requests
    WHERE platform = @platform
      AND account = @account
      AND request_id <> @requestId
  `).run({
    platform,
    account,
    requestId: excludedRequestId,
  }).changes;
  return { deleted_sibling_login_requests: deleted };
}

function deleteAccountOutboxDirs(outboxDir, platform, account) {
  if (!outboxDir) return { deleted_outbox_dirs: 0 };
  const rootDir = path.resolve(outboxDir);
  const segment = sanitizeAccountSegment(account);
  const names = [
    `login-worker-${platform}-${segment}`,
    `worker-${platform}-${segment}`,
    `sync-worker-${platform}-${segment}`,
  ];
  const deleted = names.reduce((count, name) => count + safeRmWithin(rootDir, path.join(rootDir, name)), 0);
  return { deleted_outbox_dirs: deleted };
}

function deleteLegacySessionFiles(platform, account, options = {}) {
  const segment = sanitizeAccountSegment(account);
  const dataDir = resolveDataDir();
  const rootDir = platform === 'wa'
    ? path.resolve(options.waSessionDir || process.env.WORKBENCH_WA_AUTH_DATA_PATH || path.join(dataDir, 'sessions', 'wa'))
    : path.resolve(options.tgSessionDir || process.env.WORKBENCH_TG_SESSION_DIR || path.join(dataDir, 'sessions', 'tg'));
  const targets = platform === 'wa'
    ? [
      path.join(rootDir, `session-${segment}`),
      path.join(rootDir, '.wwebjs_auth', `session-${segment}`),
    ]
    : [
      path.join(rootDir, `${segment}.json`),
      path.join(rootDir, `${segment}.pending-login.json`),
    ];
  const deleted = targets.reduce((count, target) => count + safeRmWithin(rootDir, target), 0);
  return { deleted_session_paths: deleted };
}

function safeRmWithin(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to delete outside workbench data root: ${target}`);
  }
  if (!fs.existsSync(target)) return 0;
  fs.rmSync(target, { recursive: true, force: true });
  return 1;
}

function selectOutbound(db, id) {
  return db.prepare('SELECT * FROM outbound_messages WHERE id = ?').get(Number(id)) || null;
}

function accountKey(row) {
  return `${row.platform}:${row.account}`;
}

function dedupeByAccount(rows) {
  const map = new Map();
  rows.forEach((row) => {
    const key = accountKey(row);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, row);
      return;
    }
    map.set(key, {
      ...existing,
      ...row,
      message_count: Math.max(Number(existing.message_count || 0), Number(row.message_count || 0)),
      last_timestamp: Math.max(Number(existing.last_timestamp || 0), Number(row.last_timestamp || 0)) || null,
      account_display_name: row.account_display_name || existing.account_display_name,
      account_status: row.account_status || existing.account_status,
      account_role: row.account_role || existing.account_role,
      send_enabled: row.send_enabled ?? existing.send_enabled,
      sync_groups_enabled: row.sync_groups_enabled ?? existing.sync_groups_enabled,
      risk_level: row.risk_level || existing.risk_level,
    });
  });
  return [...map.values()];
}

function boundedNumber(value, fallback, min, max) {
  return Math.max(min, Math.min(Number(value) || fallback, max));
}

function sortRawGroups(a, b) {
  const timeA = Number(a.timestamp || 0);
  const timeB = Number(b.timestamp || 0);
  if (timeA !== timeB) return timeB - timeA;
  return Number(b.id || 0) - Number(a.id || 0);
}

module.exports = {
  createAccountDataAccess,
};
