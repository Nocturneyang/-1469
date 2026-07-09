'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const { ensureRawDb } = require('../db/raw-db');
const {
  ensureAccountDatabases,
  listAccountRefs,
  normalizeAccountPlatform,
  sanitizeAccountSegment,
} = require('../db/account-db');
const { resolveDataDir } = require('../db/paths');
const { assertChromeMemoryAvailable } = require('../lib/chrome-launch');

const DATA_DIR = resolveDataDir();
const OUTBOX_DIR = path.resolve(process.env.WORKBENCH_OUTBOX_DIR || path.join(DATA_DIR, 'outbox'));
const DISCOVERY_MS = boundedNumber(process.env.WORKBENCH_ACCOUNT_SUPERVISOR_DISCOVERY_MS, 10000, 2000, 300000);
const RESTART_DELAY_MS = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_RESTART_DELAY_MS, 10000, 1000, 300000);
const MAX_WORKERS = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_MAX_WORKERS, 1, 1, 100);
const START_ALL = process.env.WORKBENCH_ACCOUNT_WORKER_START_ALL === '1';
const EXPLICIT_WORKERS = parseExplicitWorkers(process.env.WORKBENCH_ACCOUNT_WORKERS || '');
const RUNNABLE_STATUSES = new Set(['authenticated', 'ready', 'monitoring', 'warmup', 'connected']);

const workerScript = path.join(__dirname, 'account-runtime-worker.js');
const workers = new Map();
let stopping = false;

if (require.main === module) {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  log(`started, discovery=${DISCOVERY_MS}ms, maxWorkers=${MAX_WORKERS}`);
  discover().catch((err) => log(`initial discovery failed: ${err.stack || err.message}`));
  const timer = setInterval(() => {
    discover().catch((err) => log(`discovery failed: ${err.stack || err.message}`));
  }, DISCOVERY_MS);
  process.on('SIGTERM', () => shutdown(timer));
  process.on('SIGINT', () => shutdown(timer));
}

async function discover() {
  if (stopping) return;
  const desired = desiredAccountWorkers({
    refs: listAccountRefs(),
    explicitWorkers: EXPLICIT_WORKERS,
    startAll: START_ALL,
    maxWorkers: MAX_WORKERS,
  });
  const desiredKeys = new Set(desired.map((ref) => accountKey(ref.platform, ref.account)));

  for (const key of [...workers.keys()]) {
    if (!desiredKeys.has(key)) stopWorker(key, 'no longer desired');
  }

  for (const ref of desired) {
    const key = accountKey(ref.platform, ref.account);
    const existing = workers.get(key);
    if (existing?.child && !existing.child.killed) continue;
    if (existing?.nextStartAt && existing.nextStartAt > Date.now()) continue;
    startWorker(ref);
  }
}

function desiredAccountWorkers({
  refs = listAccountRefs(),
  explicitWorkers = EXPLICIT_WORKERS,
  startAll = START_ALL,
  maxWorkers = MAX_WORKERS,
} = {}) {
  const explicit = normalizeExplicitWorkers(explicitWorkers);
  const desired = [];
  refs.forEach((ref) => {
    if (explicit.size && !explicit.has(accountKey(ref.platform, ref.account))) return;
    const control = readAccountControl(ref);
    if (!shouldRunAccountWorker(control, { force: startAll || explicit.has(accountKey(ref.platform, ref.account)) })) return;
    desired.push(ref);
  });
  return desired
    .sort((a, b) => workerSortScore(readAccountControl(b)) - workerSortScore(readAccountControl(a)) ||
      a.platform.localeCompare(b.platform) ||
      a.account.localeCompare(b.account))
    .slice(0, maxWorkers);
}

function startWorker(ref) {
  const paths = ensureAccountDatabases(ref.platform, ref.account);
  const key = accountKey(ref.platform, ref.account);
  if (ref.platform === 'wa') {
    try {
      assertChromeMemoryAvailable({ env: process.env, log: (message) => log(`${key} ${message}`) });
    } catch (err) {
      workers.set(key, {
        child: null,
        startedAt: 0,
        nextStartAt: Date.now() + RESTART_DELAY_MS,
      });
      log(`delaying worker ${key}: ${err.message}`);
      return;
    }
  }
  const env = {
    ...process.env,
    WORKBENCH_ACCOUNT_DB_MODE: 'isolated',
    WORKBENCH_WORKER_ROLE: 'account-runtime',
    WORKBENCH_WORKER_PLATFORM: ref.platform,
    WORKBENCH_WORKER_ACCOUNT: ref.account,
    WORKBENCH_ACCOUNT_RAW_DB_PATH: paths.rawDbPath,
    WORKBENCH_ACCOUNT_RUNTIME_DB_PATH: paths.runtimeDbPath,
    WORKBENCH_ACCOUNT_WORKBENCH_DB_PATH: paths.workbenchDbPath,
    WORKBENCH_ACCOUNT_SESSION_DIR: paths.sessionDir,
    WORKBENCH_OUTBOX_DIR: OUTBOX_DIR,
  };
  const child = fork(workerScript, [], {
    env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  workers.set(key, {
    child,
    startedAt: Date.now(),
    nextStartAt: 0,
  });
  log(`started worker ${key} pid=${child.pid}`);
  child.on('exit', (code, signal) => {
    const current = workers.get(key);
    if (!current || current.child !== child) return;
    workers.set(key, {
      child: null,
      startedAt: current.startedAt,
      nextStartAt: Date.now() + RESTART_DELAY_MS,
    });
    log(`worker ${key} exited code=${code} signal=${signal}; restart after ${RESTART_DELAY_MS}ms`);
  });
}

function stopWorker(key, reason) {
  const current = workers.get(key);
  if (!current) return;
  workers.delete(key);
  if (current.child && !current.child.killed) {
    log(`stopping worker ${key}: ${reason}`);
    current.child.kill('SIGTERM');
    setTimeout(() => {
      if (!current.child.killed) current.child.kill('SIGKILL');
    }, 10000).unref();
  }
}

function readAccountControl(ref) {
  if (!ref?.paths?.rawDbPath || !fs.existsSync(ref.paths.rawDbPath)) {
    return {
      platform: ref.platform,
      account: ref.account,
      status: '',
      collect_enabled: 1,
      message_count: 0,
      last_timestamp: 0,
    };
  }
  const db = ensureRawDb(ref.paths.rawDbPath);
  try {
    const account = db.prepare(`
      SELECT id, platform, status, session_status, updated_at
      FROM accounts
      WHERE id = ?
    `).get(ref.account) || {};
    const registry = db.prepare(`
      SELECT collect_enabled, workbench_visible, status
      FROM channel_account_registry
      WHERE account = ?
    `).get(ref.account) || {};
    const messages = db.prepare(`
      SELECT COUNT(*) AS message_count, MAX(COALESCE(timestamp, 0)) AS last_timestamp
      FROM messages
      WHERE platform = @platform
        AND COALESCE(NULLIF(receiver_account, ''), @account) = @account
    `).get({ platform: ref.platform, account: ref.account }) || {};
    return {
      platform: normalizeAccountPlatform(account.platform || ref.platform),
      account: ref.account,
      status: String(registry.status || account.status || account.session_status || '').toLowerCase(),
      collect_enabled: registry.collect_enabled === undefined ? 1 : Number(registry.collect_enabled),
      workbench_visible: registry.workbench_visible === undefined ? 1 : Number(registry.workbench_visible),
      message_count: Number(messages.message_count || 0),
      last_timestamp: Number(messages.last_timestamp || 0),
    };
  } finally {
    db.close();
  }
}

function shouldRunAccountWorker(control, { force = false } = {}) {
  if (!control) return false;
  if (force) return true;
  if (Number(control.collect_enabled) === 0) return false;
  if (Number(control.workbench_visible) === 0) return false;
  return RUNNABLE_STATUSES.has(String(control.status || '').toLowerCase());
}

function workerSortScore(control) {
  if (!control) return 0;
  return Number(control.last_timestamp || 0) + Number(control.message_count || 0);
}

function parseExplicitWorkers(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [platform, ...accountParts] = item.includes(':') ? item.split(':') : ['', item];
      const normalizedPlatform = normalizeAccountPlatform(platform);
      const account = accountParts.join(':').trim();
      return normalizedPlatform && account ? { platform: normalizedPlatform, account } : null;
    })
    .filter(Boolean);
}

function normalizeExplicitWorkers(value) {
  const list = Array.isArray(value) ? value : parseExplicitWorkers(value);
  return new Set(list.map((entry) => accountKey(entry.platform, entry.account)));
}

function accountKey(platform, account) {
  return `${normalizeAccountPlatform(platform)}:${String(account || '').trim()}`;
}

function boundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function log(message) {
  console.log(`[workbench-account-supervisor] ${message}`);
}

function shutdown(timer) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  log('stopping');
  for (const key of [...workers.keys()]) stopWorker(key, 'supervisor shutdown');
  setTimeout(() => process.exit(0), 500).unref();
}

module.exports = {
  accountKey,
  desiredAccountWorkers,
  parseExplicitWorkers,
  readAccountControl,
  shouldRunAccountWorker,
  sanitizeAccountSegment,
};
