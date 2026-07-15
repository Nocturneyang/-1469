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
const { DEFAULT_RUNTIME_DB_PATH, openRuntimeDb } = require('../db/runtime-db');
const { assertChromeMemoryAvailable } = require('../lib/chrome-launch');
const { installProcessGuards, logEvent, sendOperationalAlert } = require('../lib/runtime-observability');

const DATA_DIR = resolveDataDir();
const OUTBOX_DIR = path.resolve(process.env.WORKBENCH_OUTBOX_DIR || path.join(DATA_DIR, 'outbox'));
const DISCOVERY_MS = boundedNumber(process.env.WORKBENCH_ACCOUNT_SUPERVISOR_DISCOVERY_MS, 10000, 2000, 300000);
const RESTART_DELAY_MS = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_RESTART_DELAY_MS, 10000, 1000, 300000);
const RESTART_MAX_DELAY_MS = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_RESTART_MAX_DELAY_MS, 120000, RESTART_DELAY_MS, 600000);
const RESTART_LIMIT = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_RESTART_LIMIT, 10, 1, 100);
const RESTART_RESET_MS = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_RESTART_RESET_MS, 60 * 60 * 1000, 60000, 24 * 60 * 60 * 1000);
const MAX_WORKERS = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_MAX_WORKERS, 5, 1, 100);
const MAX_WA_WORKERS = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_MAX_WA, 1, 0, 100);
const MAX_TG_WORKERS = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_MAX_TG, 4, 0, 100);
const START_ALL = process.env.WORKBENCH_ACCOUNT_WORKER_START_ALL === '1';
const EXPLICIT_WORKERS = parseExplicitWorkers(process.env.WORKBENCH_ACCOUNT_WORKERS || '');
const RUNNABLE_STATUSES = new Set(['authenticated', 'ready', 'monitoring', 'warmup', 'connected']);

const workerScript = path.join(__dirname, 'account-runtime-worker.js');
const workers = new Map();
const controlRuntimeDb = require.main === module
  ? openRuntimeDb(process.env.WORKBENCH_RUNTIME_DB_PATH || DEFAULT_RUNTIME_DB_PATH)
  : null;
let stopping = false;
let supervisorTimer = null;

if (require.main === module) {
  installProcessGuards({
    processName: 'account-worker-supervisor',
    runtimeDb: controlRuntimeDb,
    shutdown: () => shutdown(supervisorTimer),
    context: { pid: process.pid },
  });
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  log(`started, discovery=${DISCOVERY_MS}ms, maxWorkers=${MAX_WORKERS}`);
  discover().catch((err) => log(`initial discovery failed: ${err.stack || err.message}`));
  supervisorTimer = setInterval(() => {
    discover().catch((err) => log(`discovery failed: ${err.stack || err.message}`));
  }, DISCOVERY_MS);
  process.on('SIGTERM', () => shutdown(supervisorTimer));
  process.on('SIGINT', () => shutdown(supervisorTimer));
}

async function discover() {
  if (stopping) return;
  reportProcessHeartbeat('running');
  const selection = selectAccountWorkers({
    refs: listAccountRefs(),
    explicitWorkers: EXPLICIT_WORKERS,
    startAll: START_ALL,
    maxWorkers: MAX_WORKERS,
  });
  const desired = selection.desired;
  updateCapacityStatuses(selection);
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

function reportProcessHeartbeat(status) {
  if (!controlRuntimeDb) return;
  controlRuntimeDb.prepare(`
    INSERT INTO process_heartbeats (process_role, holder_id, status, pid, updated_at)
    VALUES ('account-supervisor', ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(process_role) DO UPDATE SET holder_id = excluded.holder_id,
      status = excluded.status, pid = excluded.pid, updated_at = CURRENT_TIMESTAMP
  `).run(process.env.HOSTNAME || String(process.pid), status, process.pid);
}

function desiredAccountWorkers({
  refs = listAccountRefs(),
  explicitWorkers = EXPLICIT_WORKERS,
  startAll = START_ALL,
  maxWorkers = MAX_WORKERS,
  maxWaWorkers = MAX_WA_WORKERS,
  maxTgWorkers = MAX_TG_WORKERS,
} = {}) {
  return selectAccountWorkers({ refs, explicitWorkers, startAll, maxWorkers, maxWaWorkers, maxTgWorkers }).desired;
}

function selectAccountWorkers({
  refs = listAccountRefs(),
  explicitWorkers = EXPLICIT_WORKERS,
  startAll = START_ALL,
  maxWorkers = MAX_WORKERS,
  maxWaWorkers = MAX_WA_WORKERS,
  maxTgWorkers = MAX_TG_WORKERS,
} = {}) {
  const explicit = normalizeExplicitWorkers(explicitWorkers);
  const eligible = [];
  refs.forEach((ref) => {
    if (explicit.size && !explicit.has(accountKey(ref.platform, ref.account))) return;
    const control = readAccountControl(ref);
    if (!shouldRunAccountWorker(control, { force: startAll || explicit.has(accountKey(ref.platform, ref.account)) })) return;
    eligible.push(ref);
  });
  const platformCounts = { wa: 0, tg: 0 };
  const ordered = eligible
    .sort((a, b) => workerSortScore(readAccountControl(b)) - workerSortScore(readAccountControl(a)) ||
      a.platform.localeCompare(b.platform) ||
      a.account.localeCompare(b.account));
  const desired = [];
  const waiting = [];
  ordered.forEach((ref) => {
      const limit = ref.platform === 'wa' ? maxWaWorkers : maxTgWorkers;
      if (platformCounts[ref.platform] >= limit || desired.length >= maxWorkers) {
        waiting.push(ref);
        return;
      }
      platformCounts[ref.platform] += 1;
      desired.push(ref);
    });
  return { desired, waiting, eligible, refs };
}

function updateCapacityStatuses({ desired, waiting, refs }) {
  const desiredKeys = new Set(desired.map((ref) => accountKey(ref.platform, ref.account)));
  const waitingKeys = new Set(waiting.map((ref) => accountKey(ref.platform, ref.account)));
  refs.forEach((ref) => {
    if (!fs.existsSync(ref.paths.runtimeDbPath)) return;
    const key = accountKey(ref.platform, ref.account);
    const status = waitingKeys.has(key) ? 'capacity_waiting' : (desiredKeys.has(key) ? 'scheduled' : 'inactive');
    const reason = waitingKeys.has(key) ? 'platform_or_global_worker_capacity' : null;
    const db = openRuntimeDb(ref.paths.runtimeDbPath);
    try {
      db.prepare(`
        INSERT INTO account_worker_status (platform, account, status, reason, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(platform, account) DO UPDATE SET
          status = excluded.status,
          reason = excluded.reason,
          updated_at = CURRENT_TIMESTAMP
      `).run(ref.platform, ref.account, status, reason);
    } finally {
      db.close();
    }
  });
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
        restartCount: 0,
        restartWindowStartedAt: Date.now(),
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
  const previous = workers.get(key) || {};
  workers.set(key, {
    child,
    startedAt: Date.now(),
    nextStartAt: 0,
    restartCount: Number(previous.restartCount || 0),
    restartWindowStartedAt: Number(previous.restartWindowStartedAt || Date.now()),
  });
  log(`started worker ${key} pid=${child.pid}`);
  child.on('exit', (code, signal) => {
    const current = workers.get(key);
    if (!current || current.child !== child) return;
    const now = Date.now();
    const stableRun = now - Number(current.startedAt || now) >= RESTART_RESET_MS;
    const expiredWindow = now - Number(current.restartWindowStartedAt || now) >= RESTART_RESET_MS;
    const restartCount = stableRun || expiredWindow ? 1 : Number(current.restartCount || 0) + 1;
    const restartWindowStartedAt = stableRun || expiredWindow ? now : current.restartWindowStartedAt;
    const delay = Math.min(RESTART_MAX_DELAY_MS, Math.round(RESTART_DELAY_MS * (1.5 ** Math.max(0, restartCount - 1))));
    if (restartCount > RESTART_LIMIT) {
      workers.set(key, {
        child: null,
        startedAt: current.startedAt,
        nextStartAt: Number.MAX_SAFE_INTEGER,
        restartCount,
        restartWindowStartedAt,
      });
      updateWorkerRestartStatus(ref, 'restart_exhausted', `restart limit ${RESTART_LIMIT} exceeded`);
      sendOperationalAlert({
        severity: 'error',
        title: `${key} worker restart limit exceeded`,
        message: `code=${code} signal=${signal} restarts=${restartCount}`,
        platform: ref.platform,
        account: ref.account,
      }).catch(() => {});
      log(`worker ${key} restart limit exceeded; automatic restart paused`);
      return;
    }
    workers.set(key, {
      child: null,
      startedAt: current.startedAt,
      nextStartAt: now + delay,
      restartCount,
      restartWindowStartedAt,
    });
    updateWorkerRestartStatus(ref, 'restart_wait', `restart ${restartCount}/${RESTART_LIMIT} in ${delay}ms`);
    log(`worker ${key} exited code=${code} signal=${signal}; restart ${restartCount}/${RESTART_LIMIT} after ${delay}ms`);
  });
}

function updateWorkerRestartStatus(ref, status, reason) {
  const db = openRuntimeDb(ref.paths.runtimeDbPath);
  try {
    db.prepare(`
      INSERT INTO account_worker_status (platform, account, status, reason, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(platform, account) DO UPDATE SET
        status = excluded.status, reason = excluded.reason, updated_at = CURRENT_TIMESTAMP
    `).run(ref.platform, ref.account, status, reason);
  } finally {
    db.close();
  }
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
  logEvent('info', 'account-worker-supervisor', 'runtime', message);
}

function shutdown(timer) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  reportProcessHeartbeat('stopped');
  if (controlRuntimeDb) controlRuntimeDb.close();
  log('stopping');
  for (const key of [...workers.keys()]) stopWorker(key, 'supervisor shutdown');
  setTimeout(() => process.exit(0), 500).unref();
}

module.exports = {
  accountKey,
  desiredAccountWorkers,
  selectAccountWorkers,
  parseExplicitWorkers,
  readAccountControl,
  shouldRunAccountWorker,
  sanitizeAccountSegment,
};
