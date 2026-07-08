const fs = require('fs');
const path = require('path');

const { ensureRawDb } = require('./raw-db');
const { openRuntimeDb } = require('./runtime-db');
const { openWorkbenchDb } = require('./workbench-db');
const { assertNotMonitorDbPath, resolveDataDir } = require('./paths');

const ACCOUNT_DB_MODE_VALUES = new Set(['1', 'true', 'yes', 'on', 'isolated', 'account']);
const WORKBENCH_PLATFORMS = new Set(['wa', 'tg']);

function isAccountDbModeEnabled(value = process.env.WORKBENCH_ACCOUNT_DB_MODE) {
  return ACCOUNT_DB_MODE_VALUES.has(String(value || '').trim().toLowerCase());
}

function resolveAccountDataDir() {
  return path.resolve(process.env.WORKBENCH_ACCOUNT_DATA_DIR || path.join(resolveDataDir(), 'accounts'));
}

function normalizeAccountPlatform(platform) {
  const value = String(platform || '').trim().toLowerCase();
  if (value === 'whatsapp') return 'wa';
  if (value === 'telegram' || value === 'telegram-user' || value === 'tg-user') return 'tg';
  return value;
}

function sanitizeAccountSegment(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function assertAccountRef(platform, account) {
  const normalizedPlatform = normalizeAccountPlatform(platform);
  const normalizedAccount = String(account || '').trim();
  if (!WORKBENCH_PLATFORMS.has(normalizedPlatform)) throw new Error('platform must be one of wa, tg');
  if (!normalizedAccount) throw new Error('account is required');
  return { platform: normalizedPlatform, account: normalizedAccount };
}

function resolveAccountPaths(platform, account, options = {}) {
  const ref = assertAccountRef(platform, account);
  const rootDir = path.resolve(options.accountDataDir || resolveAccountDataDir());
  const accountDir = path.join(rootDir, ref.platform, sanitizeAccountSegment(ref.account));
  const paths = {
    platform: ref.platform,
    account: ref.account,
    accountDir,
    rawDbPath: path.join(accountDir, 'raw.sqlite'),
    runtimeDbPath: path.join(accountDir, 'runtime.sqlite'),
    workbenchDbPath: path.join(accountDir, 'workbench.sqlite'),
    sessionDir: path.join(accountDir, 'session'),
    outboxDir: path.join(accountDir, 'outbox'),
  };
  Object.entries(paths).forEach(([key, value]) => {
    if (key.endsWith('Path')) assertNotMonitorDbPath(value, `${ref.platform}:${ref.account}:${key}`);
  });
  return paths;
}

function ensureAccountDirs(platform, account, options = {}) {
  const paths = resolveAccountPaths(platform, account, options);
  fs.mkdirSync(paths.accountDir, { recursive: true });
  fs.mkdirSync(paths.sessionDir, { recursive: true });
  fs.mkdirSync(paths.outboxDir, { recursive: true });
  writeAccountMetadata(paths);
  return paths;
}

function ensureAccountDatabases(platform, account, options = {}) {
  const paths = ensureAccountDirs(platform, account, options);
  const rawDb = ensureRawDb(paths.rawDbPath);
  const runtimeDb = openRuntimeDb(paths.runtimeDbPath);
  const workbenchDb = openWorkbenchDb(paths.workbenchDbPath);
  rawDb.close();
  runtimeDb.close();
  workbenchDb.close();
  return paths;
}

function listAccountRefs(options = {}) {
  const rootDir = path.resolve(options.accountDataDir || resolveAccountDataDir());
  const refs = [];
  for (const platform of ['wa', 'tg']) {
    const platformDir = path.join(rootDir, platform);
    if (!fs.existsSync(platformDir)) continue;
    for (const entry of fs.readdirSync(platformDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metadata = readAccountMetadata(path.join(platformDir, entry.name, 'account.json'));
      const account = metadata && metadata.platform === platform && metadata.account
        ? metadata.account
        : entry.name;
      refs.push({
        platform,
        account,
        paths: resolveAccountPaths(platform, account, { accountDataDir: rootDir }),
      });
    }
  }
  return refs.sort((a, b) => a.platform.localeCompare(b.platform) || a.account.localeCompare(b.account));
}

function writeAccountMetadata(paths) {
  const metadataPath = path.join(paths.accountDir, 'account.json');
  const metadata = {
    platform: paths.platform,
    account: paths.account,
    account_dir: path.basename(paths.accountDir),
    updated_at: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  } catch (_) {
    // Metadata is a recovery hint; DB paths remain authoritative if this write fails.
  }
}

function readAccountMetadata(metadataPath) {
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function accountDbExists(platform, account, kind, options = {}) {
  const paths = resolveAccountPaths(platform, account, options);
  const key = `${kind}DbPath`;
  return Boolean(paths[key] && fs.existsSync(paths[key]));
}

module.exports = {
  accountDbExists,
  assertAccountRef,
  ensureAccountDatabases,
  ensureAccountDirs,
  isAccountDbModeEnabled,
  listAccountRefs,
  normalizeAccountPlatform,
  resolveAccountDataDir,
  resolveAccountPaths,
  sanitizeAccountSegment,
};
