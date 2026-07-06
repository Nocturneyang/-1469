const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_RAW_DB_PATH =
  process.env.RAW_MESSAGES_DB_PATH ||
  process.env.SOCIAL_MONITOR_DB_PATH ||
  path.resolve(__dirname, '..', '..', '社媒监控系统', 'social-monitor', 'db', 'database.sqlite');

const WORKBENCH_PLATFORMS = ['wa', 'tg'];
const WORKBENCH_PLATFORM_SET = new Set(WORKBENCH_PLATFORMS);

const LEGACY_NORMALIZED_MESSAGES_SQL = `
  SELECT
    id,
    CASE lower(COALESCE(platform, ''))
      WHEN 'whatsapp' THEN 'wa'
      WHEN 'wa' THEN 'wa'
      WHEN 'telegram' THEN 'tg'
      WHEN 'tg' THEN 'tg'
      WHEN 'telegram-user' THEN 'tg'
      WHEN 'tg-user' THEN 'tg'
      ELSE lower(COALESCE(platform, 'unknown'))
    END AS platform,
    COALESCE(NULLIF(receiver_account, ''), 'default') AS account,
    message_id,
    COALESCE(NULLIF(group_id, ''), NULLIF(sender_id, ''), message_id) AS group_id,
    COALESCE(NULLIF(group_name, ''), NULLIF(group_id, ''), NULLIF(sender_name, ''), '未命名会话') AS group_name,
    sender_id,
    COALESCE(NULLIF(sender_name, ''), '未知成员') AS sender_name,
    COALESCE(content, '') AS content,
    COALESCE(has_media, 0) AS has_media,
    media_path,
    timestamp,
    raw_data,
    created_at
  FROM messages
`;

function normalizedMessagesSql(db) {
  if (!tableExists(db, 'message_observations')) return LEGACY_NORMALIZED_MESSAGES_SQL;
  return `
    SELECT
      m.id,
      CASE lower(COALESCE(m.platform, ''))
        WHEN 'whatsapp' THEN 'wa'
        WHEN 'wa' THEN 'wa'
        WHEN 'telegram' THEN 'tg'
        WHEN 'tg' THEN 'tg'
        WHEN 'telegram-user' THEN 'tg'
        WHEN 'tg-user' THEN 'tg'
        ELSE lower(COALESCE(m.platform, 'unknown'))
      END AS platform,
      COALESCE(NULLIF(o.observer_account, ''), NULLIF(m.receiver_account, ''), 'default') AS account,
      m.message_id,
      COALESCE(NULLIF(o.native_chat_id, ''), NULLIF(m.group_id, ''), NULLIF(m.sender_id, ''), m.message_id) AS group_id,
      COALESCE(NULLIF(m.group_name, ''), NULLIF(o.native_chat_id, ''), NULLIF(m.group_id, ''), NULLIF(m.sender_name, ''), '未命名会话') AS group_name,
      m.sender_id,
      COALESCE(NULLIF(m.sender_name, ''), '未知成员') AS sender_name,
      COALESCE(m.content, '') AS content,
      COALESCE(m.has_media, 0) AS has_media,
      m.media_path,
      m.timestamp,
      COALESCE(o.raw_json, m.raw_data) AS raw_data,
      m.created_at,
      o.observer_role,
      o.native_message_id
    FROM messages m
    JOIN message_observations o
      ON o.platform = m.platform
     AND o.canonical_message_id = m.message_id
  `;
}

const INBOUND_MESSAGE_FILTER_SQL = `
  AND NOT (
    lower(REPLACE(COALESCE(raw_data, ''), ' ', '')) LIKE '%"fromme":true%'
    OR lower(REPLACE(COALESCE(raw_data, ''), ' ', '')) LIKE '%"is_from_me":true%'
    OR lower(REPLACE(COALESCE(raw_data, ''), ' ', '')) LIKE '%"direction":"outbound"%'
    OR lower(REPLACE(COALESCE(raw_data, ''), ' ', '')) LIKE '%"out":true%'
  )
`;

function openRawDb(rawDbPath = DEFAULT_RAW_DB_PATH) {
  try {
    return new Database(rawDbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return null;
  }
}

function buildPlatformFilter(platforms, params) {
  const normalized = normalizePlatformList(platforms);
  if (!normalized.length && hasPlatformInput(platforms)) return 'AND 1 = 0';
  const effectivePlatforms = normalized.length ? normalized : WORKBENCH_PLATFORMS;
  const placeholders = effectivePlatforms.map((platform, index) => {
    const key = `platform${index}`;
    params[key] = platform;
    return `@${key}`;
  });
  return `AND platform IN (${placeholders.join(', ')})`;
}

function hasPlatformInput(platforms) {
  if (Array.isArray(platforms)) return platforms.some((platform) => String(platform || '').trim());
  return platforms !== undefined && platforms !== null && String(platforms).trim() !== '';
}

function buildAccountScopeFilter(accountScope, params) {
  const scope = normalizeAccountScope(accountScope);
  if (!scope.active) return '';
  if (!scope.accounts.length) return 'AND 1 = 0';
  const clauses = scope.accounts.map((entry, index) => {
    const platformKey = `scopePlatform${index}`;
    const accountKey = `scopeAccount${index}`;
    params[platformKey] = entry.platform;
    params[accountKey] = entry.account;
    return `(platform = @${platformKey} AND account = @${accountKey})`;
  });
  return `AND (${clauses.join(' OR ')})`;
}

function normalizePlatform(platform) {
  const value = String(platform || '').trim().toLowerCase();
  if (!value) return '';
  if (value === 'whatsapp') return 'wa';
  if (value === 'telegram' || value === 'telegram-user' || value === 'tg-user') return 'tg';
  return value;
}

function isWorkbenchPlatform(platform) {
  return WORKBENCH_PLATFORM_SET.has(normalizePlatform(platform));
}

function normalizePlatformList(platforms) {
  if (!platforms) return [];
  const list = Array.isArray(platforms) ? platforms : String(platforms).split(',');
  return [...new Set(list.map(normalizePlatform).filter(isWorkbenchPlatform))];
}

function inferPlatformFromAccount(account) {
  const value = String(account || '').trim().toLowerCase();
  if (value.startsWith('wa-')) return 'wa';
  if (value.startsWith('tgu-') || value.startsWith('tg-')) return 'tg';
  return '';
}

function normalizeAccountScope(accountScope) {
  if (!accountScope) return { active: false, accounts: [] };
  if (accountScope.active === false) return { active: false, accounts: [] };
  const source = Array.isArray(accountScope) ? accountScope : accountScope.accounts;
  const accounts = (source || [])
    .map((entry) => {
      if (typeof entry === 'string') return parseAccountScopeEntry(entry);
      return {
        platform: normalizePlatform(entry.platform || inferPlatformFromAccount(entry.account)),
        account: String(entry.account || entry.id || '').trim(),
      };
    })
    .filter((entry) => isWorkbenchPlatform(entry.platform) && entry.account);
  const deduped = [];
  const seen = new Set();
  accounts.forEach((entry) => {
    const key = `${entry.platform}:${entry.account}`;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(entry);
  });
  return { active: true, accounts: deduped };
}

function parseAccountScopeEntry(entry) {
  const value = String(entry || '').trim();
  if (!value) return { platform: '', account: '' };
  if (value.includes(':')) {
    const [platform, ...accountParts] = value.split(':');
    return {
      platform: normalizePlatform(platform),
      account: accountParts.join(':').trim(),
    };
  }
  return {
    platform: inferPlatformFromAccount(value),
    account: value,
  };
}

function parseAccountScopeList(value) {
  const entries = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return normalizeAccountScope({ active: entries.length > 0, accounts: entries });
}

function tableExists(db, tableName) {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName);
  return Boolean(row);
}

function tableColumnNames(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name));
}

function accountProfileKey(platform, account) {
  return `${normalizePlatform(platform)}:${String(account || '').trim()}`;
}

function registryRowsByAccount(db) {
  if (!tableExists(db, 'channel_account_registry')) return new Map();
  const rows = db.prepare(`
    SELECT *
    FROM channel_account_registry
  `).all();
  return new Map(rows.map((row) => [String(row.account || '').trim(), row]));
}

function isWorkbenchServiceRegistry(row) {
  if (!row) return false;
  const role = String(row.account_role || '').toLowerCase();
  return (role === 'service' || role === 'both') && Number(row.workbench_visible) !== 0;
}

function loadAccountProfilesFromDb(db, accountScope) {
  if (!tableExists(db, 'accounts')) return [];
  const registry = registryRowsByAccount(db);
  const columns = tableColumnNames(db, 'accounts');
  const platformExpr = columns.has('platform') ? 'platform' : "''";
  const statusExpr = columns.has('status') ? 'status' : "''";
  const displayExpr = columns.has('display_name') ? "NULLIF(display_name, '')" : 'NULL';
  const pushnameExpr = columns.has('pushname') ? "NULLIF(pushname, '')" : 'NULL';
  const rows = db.prepare(`
    SELECT
      id AS account,
      ${platformExpr} AS platform,
      ${statusExpr} AS status,
      COALESCE(${displayExpr}, ${pushnameExpr}, NULLIF(id, ''), 'default') AS display_name
    FROM accounts
    ORDER BY platform ASC, id ASC
  `).all();
  return rows
    .map((row) => {
      const account = String(row.account || '').trim();
      const platform = normalizePlatform(row.platform || inferPlatformFromAccount(account));
      const registryRow = registry.get(account);
      return {
        platform,
        account,
        status: row.status,
        display_name: String((registryRow && registryRow.display_name) || row.display_name || account).trim() || account,
        account_role: registryRow ? registryRow.account_role : null,
        workbench_visible: registryRow ? Number(registryRow.workbench_visible) : 0,
        send_enabled: registryRow ? Number(registryRow.send_enabled) : 0,
        sync_groups_enabled: registryRow ? Number(registryRow.sync_groups_enabled) : 0,
        risk_level: registryRow ? registryRow.risk_level : 'low',
      };
    })
    .filter((row) => isWorkbenchPlatform(row.platform) && row.account)
    .filter((row) => {
      const scope = normalizeAccountScope(accountScope);
      if (scope.active) return true;
      return isWorkbenchServiceRegistry(registry.get(row.account)) || process.env.WORKBENCH_ALLOW_LEGACY_ACCOUNTS === '1';
    })
    .filter((row) => accountScopeContains(accountScope, row.platform, row.account));
}

function listAccountProfiles({ rawDbPath = DEFAULT_RAW_DB_PATH, accountScope } = {}) {
  const db = openRawDb(rawDbPath);
  if (!db) return [];
  try {
    return loadAccountProfilesFromDb(db, accountScope);
  } finally {
    db.close();
  }
}

function listLoggedInAccounts({
  rawDbPath = DEFAULT_RAW_DB_PATH,
  statuses = ['authenticated', 'ready', 'warmup', 'monitoring'],
} = {}) {
  const db = openRawDb(rawDbPath);
  if (!db) return { active: false, accounts: [] };
  try {
    if (!tableExists(db, 'accounts')) return { active: false, accounts: [] };
    const registry = registryRowsByAccount(db);
    const params = {};
    const placeholders = statuses.map((status, index) => {
      const key = `status${index}`;
      params[key] = String(status).toLowerCase();
      return `@${key}`;
    });
    const rows = db.prepare(`
      SELECT id AS account, platform, status
      FROM accounts
      WHERE lower(COALESCE(status, '')) IN (${placeholders.join(', ')})
      ORDER BY platform ASC, id ASC
    `).all(params);
    const scopedRows = rows.filter((row) => {
      const registryRow = registry.get(String(row.account || '').trim());
      return isWorkbenchServiceRegistry(registryRow) || process.env.WORKBENCH_ALLOW_LEGACY_ACCOUNTS === '1';
    });
    return normalizeAccountScope({
      active: true,
      accounts: scopedRows.map((row) => ({
        platform: normalizePlatform(row.platform || inferPlatformFromAccount(row.account)),
        account: row.account,
      })),
    });
  } finally {
    db.close();
  }
}

function resolveAccountScope({
  rawDbPath = DEFAULT_RAW_DB_PATH,
  explicitAccounts = process.env.WORKBENCH_VISIBLE_SERVICE_ACCOUNTS ||
    process.env.WORKBENCH_SERVICE_ACCOUNTS ||
    process.env.WORKBENCH_SEND_ACCOUNTS ||
    process.env.WORKBENCH_VISIBLE_ACCOUNTS ||
    '',
  filterLoggedIn = process.env.WORKBENCH_FILTER_LOGGED_IN_ACCOUNTS !== '0',
} = {}) {
  const explicitScope = parseAccountScopeList(explicitAccounts);
  if (explicitScope.active) return { mode: 'explicit', ...explicitScope };
  if (!filterLoggedIn) return { mode: 'all', active: false, accounts: [] };
  const loggedInScope = listLoggedInAccounts({ rawDbPath });
  return { mode: loggedInScope.active ? 'logged-in' : 'all', ...loggedInScope };
}

function accountScopeContains(accountScope, platform, account) {
  const scope = normalizeAccountScope(accountScope);
  const normalizedPlatform = normalizePlatform(platform);
  if (!isWorkbenchPlatform(normalizedPlatform)) return false;
  if (!scope.active) return true;
  const normalizedAccount = String(account || '').trim();
  return scope.accounts.some((entry) => entry.platform === normalizedPlatform && entry.account === normalizedAccount);
}

function listAccounts({ rawDbPath = DEFAULT_RAW_DB_PATH, accountScope } = {}) {
  const db = openRawDb(rawDbPath);
  if (!db) return [];
  const params = {};
  const platformFilter = buildPlatformFilter(null, params);
  const accountFilter = buildAccountScopeFilter(accountScope, params);
  try {
    const profiles = new Map(loadAccountProfilesFromDb(db, accountScope).map((profile) => [
      accountProfileKey(profile.platform, profile.account),
      profile,
    ]));
    return db.prepare(`
      WITH normalized AS (${normalizedMessagesSql(db)})
      SELECT
        platform,
        account,
        COUNT(*) AS message_count,
        MAX(COALESCE(timestamp, 0)) AS last_timestamp
      FROM normalized
      WHERE group_id IS NOT NULL
        ${platformFilter}
        ${accountFilter}
      GROUP BY platform, account
      ORDER BY platform ASC, account ASC
    `).all(params).map((account) => {
      const profile = profiles.get(accountProfileKey(account.platform, account.account));
      const displayName = profile && profile.display_name ? profile.display_name : account.account;
      return {
        ...account,
        account_display_name: displayName,
      };
    });
  } finally {
    db.close();
  }
}

function listGroups({
  rawDbPath = DEFAULT_RAW_DB_PATH,
  platforms,
  accountScope,
  search,
  limit = 80,
  offset = 0,
} = {}) {
  const db = openRawDb(rawDbPath);
  if (!db) return [];
  const params = {
    limit: Math.max(1, Math.min(Number(limit) || 80, 200)),
    offset: Math.max(0, Number(offset) || 0),
  };
  const platformFilter = buildPlatformFilter(platforms, params);
  const accountFilter = buildAccountScopeFilter(accountScope, params);
  let searchFilter = '';
  if (search && String(search).trim()) {
    params.search = `%${String(search).trim()}%`;
    searchFilter = `
      AND (
        group_name LIKE @search
        OR group_id LIKE @search
        OR sender_name LIKE @search
        OR content LIKE @search
        OR account LIKE @search
      )
    `;
  }

  try {
    return db.prepare(`
      WITH normalized AS (${normalizedMessagesSql(db)}),
      filtered AS (
        SELECT *
        FROM normalized
        WHERE group_id IS NOT NULL
        ${platformFilter}
        ${accountFilter}
        ${searchFilter}
      ),
      ranked AS (
        SELECT
          *,
          ROW_NUMBER() OVER (
            PARTITION BY platform, account, group_id
            ORDER BY COALESCE(timestamp, 0) DESC, id DESC
          ) AS rn,
          COUNT(*) OVER (PARTITION BY platform, account, group_id) AS message_count
        FROM filtered
      )
      SELECT *
      FROM ranked
      WHERE rn = 1
      ORDER BY COALESCE(timestamp, 0) DESC, id DESC
      LIMIT @limit OFFSET @offset
    `).all(params);
  } finally {
    db.close();
  }
}

function listMessages({
  rawDbPath = DEFAULT_RAW_DB_PATH,
  platform,
  account,
  accountScope,
  groupId,
  beforeId,
  limit = 80,
} = {}) {
  const db = openRawDb(rawDbPath);
  if (!db) return [];
  if (!accountScopeContains(accountScope, platform, account)) return [];
  if (!isWorkbenchPlatform(platform)) return [];
  const params = {
    platform: normalizePlatform(platform),
    account: String(account || 'default'),
    groupId: String(groupId || ''),
    limit: Math.max(1, Math.min(Number(limit) || 80, 200)),
  };
  let beforeFilter = '';
  if (beforeId) {
    params.beforeId = Number(beforeId);
    beforeFilter = 'AND id < @beforeId';
  }
  try {
    return db.prepare(`
      WITH normalized AS (${normalizedMessagesSql(db)})
      SELECT *
      FROM normalized
      WHERE platform = @platform
        AND account = @account
        AND group_id = @groupId
        ${beforeFilter}
      ORDER BY COALESCE(timestamp, 0) DESC, id DESC
      LIMIT @limit
    `).all(params).reverse();
  } finally {
    db.close();
  }
}

function listMessagesPage(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 80, 200));
  const rows = listMessages({ ...options, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const messages = hasMore ? rows.slice(1) : rows;
  return {
    messages,
    paging: {
      has_more: hasMore,
      before_id: messages.length ? messages[0].id : null,
    },
  };
}

function countUnread({
  rawDbPath = DEFAULT_RAW_DB_PATH,
  platform,
  account,
  accountScope,
  groupId,
  lastReadMessageId,
} = {}) {
  const db = openRawDb(rawDbPath);
  if (!db) return 0;
  if (!accountScopeContains(accountScope, platform, account)) return 0;
  if (!isWorkbenchPlatform(platform)) return 0;
  const params = {
    platform: normalizePlatform(platform),
    account: String(account || 'default'),
    groupId: String(groupId || ''),
    lastReadMessageId: Number(lastReadMessageId) || 0,
  };
  try {
    const row = db.prepare(`
      WITH normalized AS (${normalizedMessagesSql(db)})
      SELECT COUNT(*) AS count
      FROM normalized
      WHERE platform = @platform
        AND account = @account
        AND group_id = @groupId
        AND id > @lastReadMessageId
        ${INBOUND_MESSAGE_FILTER_SQL}
    `).get(params);
    return row ? row.count : 0;
  } finally {
    db.close();
  }
}

module.exports = {
  DEFAULT_RAW_DB_PATH,
  WORKBENCH_PLATFORMS,
  accountScopeContains,
  countUnread,
  inferPlatformFromAccount,
  isWorkbenchPlatform,
  listAccountProfiles,
  listAccounts,
  listGroups,
  listLoggedInAccounts,
  listMessages,
  listMessagesPage,
  normalizePlatform,
  normalizeAccountScope,
  normalizePlatformList,
  openRawDb,
  parseAccountScopeList,
  resolveAccountScope,
};
