'use strict';

const fs = require('fs');
const path = require('path');

const { DEFAULT_RAW_DB_PATH, upsertServiceAccountProfile } = require('../db/raw-db');
const { DEFAULT_RUNTIME_DB_PATH, openRuntimeDb } = require('../db/runtime-db');
const { resolveDataDir } = require('../db/paths');
const {
  ensureAccountDatabases,
  isAccountDbModeEnabled,
  listAccountRefs,
  normalizeAccountPlatform,
  sanitizeAccountSegment,
} = require('../db/account-db');
const { updateServiceAccountLoginRequest } = require('../lib/service-account-login-store');

const DATA_DIR = resolveDataDir();
const WORKER_PLATFORM = normalizeAccountPlatform(process.env.WORKBENCH_WORKER_PLATFORM);
const WORKER_ACCOUNT = String(process.env.WORKBENCH_WORKER_ACCOUNT || '').trim();
const WORKER_ROLE = String(process.env.WORKBENCH_WORKER_ROLE || 'login-worker').trim();
const ACCOUNT_DB_MODE = isAccountDbModeEnabled(process.env.WORKBENCH_ACCOUNT_DB_MODE);
const ACCOUNT_SCOPED = WORKER_ROLE === 'account-runtime' || Boolean(WORKER_PLATFORM || WORKER_ACCOUNT);
if (ACCOUNT_SCOPED && (!['wa', 'tg'].includes(WORKER_PLATFORM) || !WORKER_ACCOUNT)) {
  throw new Error('WORKBENCH_WORKER_PLATFORM and WORKBENCH_WORKER_ACCOUNT are required for account-runtime worker');
}
const ACCOUNT_PATHS = ACCOUNT_SCOPED
  ? ensureAccountDatabases(WORKER_PLATFORM, WORKER_ACCOUNT)
  : null;
const OUTBOX_DIR = path.resolve(process.env.WORKBENCH_OUTBOX_DIR || path.join(DATA_DIR, 'outbox'));
const RAW_DB_PATH = ACCOUNT_SCOPED
  ? path.resolve(process.env.WORKBENCH_ACCOUNT_RAW_DB_PATH || ACCOUNT_PATHS.rawDbPath)
  : path.resolve(process.env.WORKBENCH_RAW_DB_PATH || DEFAULT_RAW_DB_PATH);
const POLL_INTERVAL_MS = Number(process.env.WORKBENCH_LOGIN_WORKER_POLL_MS || 3000);
const WA_AUTH_DATA_PATH = ACCOUNT_SCOPED && WORKER_PLATFORM === 'wa'
  ? path.resolve(process.env.WORKBENCH_ACCOUNT_SESSION_DIR || ACCOUNT_PATHS.sessionDir)
  : path.resolve(process.env.WORKBENCH_WA_AUTH_DATA_PATH || path.join(DATA_DIR, 'sessions', 'wa'));
const TG_SESSION_DIR = ACCOUNT_SCOPED && WORKER_PLATFORM === 'tg'
  ? path.resolve(process.env.WORKBENCH_ACCOUNT_SESSION_DIR || ACCOUNT_PATHS.sessionDir)
  : path.resolve(process.env.WORKBENCH_TG_SESSION_DIR || path.join(DATA_DIR, 'sessions', 'tg'));
const TERMINAL_STATUSES = new Set(['authenticated', 'failed', 'expired', 'canceled']);
const LEASE_TTL_MS = Number(process.env.WORKBENCH_WORKER_LEASE_TTL_MS || 45000);
const WA_LOGIN_HANDOFF_DELAY_MS = Number(process.env.WORKBENCH_LOGIN_HANDOFF_DELAY_MS || 5000);
const WORKER_HOLDER_ID = process.env.HOSTNAME || `${process.pid}`;
const WORKER_RUN_ID = `${Date.now()}-${process.pid}`;

const runtimeDb = openRuntimeDb(ACCOUNT_SCOPED
  ? path.resolve(process.env.WORKBENCH_ACCOUNT_RUNTIME_DB_PATH || ACCOUNT_PATHS.runtimeDbPath)
  : path.resolve(process.env.WORKBENCH_RUNTIME_DB_PATH || DEFAULT_RUNTIME_DB_PATH));
const activeWaByRequest = new Map();
const activeWaByAccount = new Map();

fs.mkdirSync(OUTBOX_DIR, { recursive: true });
fs.mkdirSync(WA_AUTH_DATA_PATH, { recursive: true });
fs.mkdirSync(TG_SESSION_DIR, { recursive: true });

log(`started, outbox=${OUTBOX_DIR}${ACCOUNT_SCOPED ? `, account=${WORKER_PLATFORM}:${WORKER_ACCOUNT}` : ''}${ACCOUNT_DB_MODE ? ', account-db-mode=isolated' : ''}`);
tick().catch((err) => log(`initial tick failed: ${err.stack || err.message}`));
const pollTimer = setInterval(() => {
  tick().catch((err) => log(`tick failed: ${err.stack || err.message}`));
}, POLL_INTERVAL_MS);

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function tick() {
  if (ACCOUNT_SCOPED && !renewAccountLease()) return;
  expireRequests();
  await processDoorbells();
  resumeWaitingWaRequests();
}

async function processDoorbells() {
  for (const filePath of listDoorbellFiles()) {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (payload.kind !== 'service-account-login') {
        archiveDoorbell(filePath, 'ignored');
        continue;
      }
      await handleLoginPayload(payload);
      archiveDoorbell(filePath, 'processed');
    } catch (err) {
      log(`failed to process ${filePath}: ${err.message}`);
      if (payload?.request_id) {
        patchRequest(payload.request_id, {
          status: 'failed',
          error_message: err.message,
          worker_message: '登录任务处理失败',
        }, payload);
      }
      archiveDoorbell(filePath, 'failed');
    }
  }
}

function listDoorbellFiles() {
  if (!fs.existsSync(OUTBOX_DIR)) return [];
  const result = [];
  if (ACCOUNT_SCOPED) {
    const dir = path.join(OUTBOX_DIR, `login-worker-${WORKER_PLATFORM}-${sanitizeAccountSegment(WORKER_ACCOUNT)}`);
    if (!fs.existsSync(dir)) return [];
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.json')) result.push(path.join(dir, file.name));
    }
    return result.sort();
  }
  for (const entry of fs.readdirSync(OUTBOX_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('login-worker-')) continue;
    const dir = path.join(OUTBOX_DIR, entry.name);
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.json')) result.push(path.join(dir, file.name));
    }
  }
  return result.sort();
}

async function handleLoginPayload(payload) {
  if (ACCOUNT_SCOPED && (payload.platform !== WORKER_PLATFORM || payload.account !== WORKER_ACCOUNT)) {
    return;
  }
  const request = getRequest(payload.request_id, payload);
  if (!request) {
    throw new Error(`login request not found: ${payload.request_id}`);
  }
  if (TERMINAL_STATUSES.has(request.status)) return;

  if (request.platform === 'wa' && request.login_mode === 'wa_qr') {
    startWaLogin(request);
    return;
  }
  if (request.platform === 'tg' && request.login_mode === 'tg_bot_token') {
    await authenticateTgBot(request, payload.credential?.value);
    return;
  }
  if (request.platform === 'tg' && request.login_mode === 'tg_user_session') {
    await authenticateTgUserSession(request, payload.credential?.value);
    return;
  }
  throw new Error(`unsupported login mode: ${request.platform}/${request.login_mode}`);
}

function resumeWaitingWaRequests() {
  if (ACCOUNT_SCOPED && WORKER_PLATFORM !== 'wa') return;
  forEachRuntimeDb((db, context) => {
    const rows = db.prepare(`
      SELECT *
      FROM service_account_login_requests
      WHERE platform = 'wa'
        AND login_mode = 'wa_qr'
        ${ACCOUNT_SCOPED || context.account ? 'AND account = @account' : ''}
        AND status IN ('waiting_qr', 'waiting_verification', 'requested')
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY created_at ASC
      LIMIT 10
    `).all(ACCOUNT_SCOPED || context.account ? { account: WORKER_ACCOUNT || context.account } : {});
    for (const row of rows) {
      startWaLogin(mapRequestRow(row));
    }
  });
}

function expireRequests() {
  forEachRuntimeDb((db, context) => {
    const rows = db.prepare(`
      SELECT request_id, platform, account, display_name, login_mode
      FROM service_account_login_requests
      WHERE status IN ('requested', 'waiting_qr', 'waiting_verification')
        ${ACCOUNT_SCOPED || context.account ? 'AND platform = @platform AND account = @account' : ''}
        AND expires_at IS NOT NULL
        AND julianday(expires_at) <= julianday('now')
    `).all(ACCOUNT_SCOPED || context.account ? {
      platform: WORKER_PLATFORM || context.platform,
      account: WORKER_ACCOUNT || context.account,
    } : {});
    for (const row of rows) {
      patchRequest(row.request_id, {
        status: 'expired',
        qr_payload: '',
        worker_message: '登录任务已过期，请重新发起登录',
      }, row);
      stopWaRequest(row.request_id);
    }
  });
}

function startWaLogin(request) {
  if (activeWaByRequest.has(request.request_id)) return;

  const previous = activeWaByAccount.get(request.account);
  if (previous && previous.requestId !== request.request_id) {
    stopWaRequest(previous.requestId);
  }

  let wa;
  try {
    wa = loadWhatsAppRuntime();
  } catch (err) {
    patchRequest(request.request_id, {
      status: 'failed',
      error_message: `WA 登录依赖不可用: ${err.message}`,
      worker_message: '生产镜像缺少 WA 登录依赖或 Chromium',
    }, request);
    return;
  }
  const waSessionDir = waSessionDirFor(request);

  const client = new wa.Client({
    authStrategy: new wa.LocalAuth({
      clientId: sanitizeSegment(request.account),
      dataPath: waSessionDir,
      rmMaxRetries: 10,
    }),
    authTimeoutMs: Number(process.env.WORKBENCH_WA_AUTH_TIMEOUT_MS || 300000),
    qrMaxRetries: Number(process.env.WORKBENCH_WA_QR_MAX_RETRIES || 0),
    puppeteer: buildChromeLaunchConfig(waSessionDir),
  });

  const state = {
    requestId: request.request_id,
    account: request.account,
    client,
    ready: false,
    intentionalStop: false,
  };
  activeWaByRequest.set(request.request_id, state);
  activeWaByAccount.set(request.account, state);

  patchRequest(request.request_id, {
    status: 'waiting_qr',
    worker_message: 'WA 登录 worker 已启动，正在生成二维码',
  }, request);

  client.on('qr', (qr) => {
    patchRequest(request.request_id, {
      status: 'waiting_qr',
      qr_payload: qr,
      worker_message: '请使用 WhatsApp 扫描二维码登录',
      error_message: '',
    }, request);
    log(`WA QR ready for ${request.account}`);
  });

  client.on('authenticated', () => {
    patchRequest(request.request_id, {
      status: 'waiting_verification',
      qr_payload: '',
      worker_message: '二维码已扫描，正在等待 WhatsApp 完成登录',
      error_message: '',
    }, request);
  });

  client.on('ready', () => {
    state.ready = true;
    const displayName = client.info?.pushname || client.info?.wid?.user || request.display_name || request.account;
    patchRequest(request.request_id, {
      status: 'authenticated',
      qr_payload: '',
      worker_message: `WA 已登录：${displayName}`,
      error_message: '',
    }, { ...request, display_name: displayName });
    log(`WA authenticated for ${request.account}`);
    if (WA_LOGIN_HANDOFF_DELAY_MS >= 0) {
      setTimeout(() => {
        const active = activeWaByRequest.get(request.request_id);
        if (!active || active.intentionalStop) return;
        active.intentionalStop = true;
        log(`WA login handoff for ${request.account}; releasing login client`);
        stopWaRequest(request.request_id);
      }, WA_LOGIN_HANDOFF_DELAY_MS);
    }
  });

  client.on('auth_failure', (message) => {
    patchRequest(request.request_id, {
      status: 'failed',
      qr_payload: '',
      error_message: String(message || 'WA 认证失败'),
      worker_message: 'WA 认证失败，请重新发起扫码登录',
    }, request);
    stopWaRequest(request.request_id);
  });

  client.on('disconnected', (reason) => {
    if (state.intentionalStop) {
      log(`WA login client released for ${request.account}`);
      return;
    }
    upsertProfile(request, 'disconnected', request.display_name);
    if (!state.ready) {
      patchRequest(request.request_id, {
        status: 'failed',
        qr_payload: '',
        error_message: `WA 已断开：${reason || 'unknown'}`,
        worker_message: 'WA 登录中断，请重新发起登录',
      }, request);
    }
    activeWaByRequest.delete(request.request_id);
    if (activeWaByAccount.get(request.account)?.requestId === request.request_id) {
      activeWaByAccount.delete(request.account);
    }
  });

  client.initialize().catch((err) => {
    patchRequest(request.request_id, {
      status: 'failed',
      qr_payload: '',
      error_message: err.message,
      worker_message: 'WA 客户端启动失败',
    }, request);
    stopWaRequest(request.request_id);
  });
}

async function authenticateTgBot(request, token) {
  const secret = String(token || '').trim();
  if (!secret) throw new Error('TG Bot Token is missing from worker handoff file');
  let TelegramBot;
  try {
    TelegramBot = require('node-telegram-bot-api');
  } catch (err) {
    throw new Error(`TG Bot 登录依赖不可用: ${err.message}`);
  }

  patchRequest(request.request_id, {
    status: 'requested',
    worker_message: 'TG Bot Token 校验中',
  }, request);

  const bot = new TelegramBot(secret, { polling: false });
  try {
    const me = await bot.getMe();
    const name = me.first_name + (me.username ? ` (@${me.username})` : '');
    saveTgCredential(request, {
      login_mode: 'tg_bot_token',
      token: secret,
      bot: me,
    });
    patchRequest(request.request_id, {
      status: 'authenticated',
      worker_message: `TG Bot 已登录：${name}`,
      error_message: '',
    }, { ...request, display_name: name || request.display_name });
  } catch (err) {
    patchRequest(request.request_id, {
      status: 'failed',
      error_message: err.message,
      worker_message: 'TG Bot Token 校验失败',
    }, request);
  } finally {
    if (typeof bot.close === 'function') bot.close().catch(() => {});
  }
}

async function authenticateTgUserSession(request, sessionString) {
  const secret = String(sessionString || '').trim();
  if (!secret) throw new Error('TG user session is missing from worker handoff file');
  const accountKey = request.account.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const apiId = Number(
    process.env[`WORKBENCH_TG_API_ID_${accountKey}`] ||
    process.env.WORKBENCH_TG_API_ID ||
    process.env.TG_API_ID ||
    0
  );
  const apiHash =
    process.env[`WORKBENCH_TG_API_HASH_${accountKey}`] ||
    process.env.WORKBENCH_TG_API_HASH ||
    process.env.TG_API_HASH ||
    '';
  if (!apiId || !apiHash) {
    patchRequest(request.request_id, {
      status: 'failed',
      error_message: 'WORKBENCH_TG_API_ID / WORKBENCH_TG_API_HASH 未配置',
      worker_message: 'TG 用户 Session 登录需要 API ID 和 API Hash',
    }, request);
    return;
  }

  let TelegramClient;
  let StringSession;
  try {
    ({ TelegramClient } = require('telegram'));
    ({ StringSession } = require('telegram/sessions'));
  } catch (err) {
    throw new Error(`TG 用户 Session 登录依赖不可用: ${err.message}`);
  }

  patchRequest(request.request_id, {
    status: 'requested',
    worker_message: 'TG 用户 Session 校验中',
  }, request);

  const client = new TelegramClient(new StringSession(secret), apiId, apiHash, {
    connectionRetries: 2,
    useWSS: false,
  });
  try {
    await client.connect();
    const me = await client.getMe();
    const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || request.display_name || request.account;
    saveTgCredential(request, {
      login_mode: 'tg_user_session',
      session: client.session.save(),
      user: {
        id: me.id?.toString?.() || String(me.id || ''),
        username: me.username || '',
        first_name: me.firstName || '',
        last_name: me.lastName || '',
      },
    });
    patchRequest(request.request_id, {
      status: 'authenticated',
      worker_message: `TG 用户账号已登录：${name}`,
      error_message: '',
    }, { ...request, display_name: name });
  } catch (err) {
    patchRequest(request.request_id, {
      status: 'failed',
      error_message: err.message,
      worker_message: 'TG 用户 Session 校验失败',
    }, request);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

function loadWhatsAppRuntime() {
  const vanillaPuppeteer = require('puppeteer');
  try {
    const { PuppeteerExtra } = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    const puppeteer = new PuppeteerExtra(vanillaPuppeteer);
    puppeteer.use(StealthPlugin());
    require.cache[require.resolve('puppeteer')] = { exports: puppeteer };
  } catch (err) {
    log(`puppeteer stealth plugin unavailable, continuing with vanilla puppeteer: ${err.message}`);
  }
  return require('whatsapp-web.js');
}

function buildChromeLaunchConfig(sessionDir = WA_AUTH_DATA_PATH) {
  const executablePath = existingPath(process.env.PUPPETEER_EXECUTABLE_PATH) ||
    existingPath('/usr/bin/chromium') ||
    existingPath('/usr/bin/google-chrome') ||
    undefined;
  const chromeStateDir = path.join(sessionDir, '.chromium');
  const xdgConfigDir = path.join(chromeStateDir, 'config');
  const xdgCacheDir = path.join(chromeStateDir, 'cache');
  const xdgRuntimeDir = path.join(chromeStateDir, 'runtime');
  fs.mkdirSync(xdgConfigDir, { recursive: true });
  fs.mkdirSync(xdgCacheDir, { recursive: true });
  fs.mkdirSync(xdgRuntimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(xdgRuntimeDir, 0o700);
  return {
    headless: true,
    executablePath,
    pipe: true,
    timeout: Number(process.env.WORKBENCH_WA_PUPPETEER_TIMEOUT_MS || 120000),
    protocolTimeout: Number(process.env.WORKBENCH_WA_PUPPETEER_PROTOCOL_TIMEOUT_MS || 120000),
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfigDir,
      XDG_CACHE_HOME: xdgCacheDir,
      XDG_RUNTIME_DIR: xdgRuntimeDir,
    },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--disable-features=Translate,MediaRouter,OptimizationHints,AudioServiceOutOfProcess',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-ipc-flooding-protection',
      '--disable-hang-monitor',
      '--renderer-process-limit=4',
      '--process-per-site',
      '--no-zygote',
      '--disable-site-isolation-trials',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
      '--use-mock-keychain',
      '--window-size=1280,960',
    ],
  };
}

function existingPath(filePath) {
  return filePath && fs.existsSync(filePath) ? filePath : '';
}

function renewAccountLease() {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + Math.max(15000, LEASE_TTL_MS)).toISOString();
  const current = runtimeDb.prepare(`
    SELECT *
    FROM account_worker_leases
    WHERE platform = @platform
      AND account = @account
      AND lease_name = 'account-runtime'
  `).get({
    platform: WORKER_PLATFORM,
    account: WORKER_ACCOUNT,
  });
  const heldByMe = current && current.holder_id === WORKER_HOLDER_ID && current.run_id === WORKER_RUN_ID;
  const expired = !current || Date.parse(current.expires_at) <= Date.now();
  if (!heldByMe && !expired) {
    log(`account lease held by ${current.holder_id}, waiting until ${current.expires_at}`);
    return false;
  }
  runtimeDb.prepare(`
    INSERT INTO account_worker_leases (
      platform, account, lease_name, holder_id, worker_role, run_id, pid,
      acquired_at, renewed_at, expires_at, metadata_json
    )
    VALUES (
      @platform, @account, 'account-runtime', @holderId, @workerRole, @runId, @pid,
      @now, @now, @expiresAt, @metadataJson
    )
    ON CONFLICT(platform, account, lease_name) DO UPDATE SET
      holder_id = excluded.holder_id,
      worker_role = excluded.worker_role,
      run_id = excluded.run_id,
      pid = excluded.pid,
      renewed_at = excluded.renewed_at,
      expires_at = excluded.expires_at,
      metadata_json = excluded.metadata_json
  `).run({
    platform: WORKER_PLATFORM,
    account: WORKER_ACCOUNT,
    holderId: WORKER_HOLDER_ID,
    workerRole: WORKER_ROLE,
    runId: WORKER_RUN_ID,
    pid: process.pid,
    now: nowIso,
    expiresAt,
    metadataJson: JSON.stringify({
      raw_db_path: RAW_DB_PATH,
      runtime_db_path: ACCOUNT_SCOPED
        ? (process.env.WORKBENCH_ACCOUNT_RUNTIME_DB_PATH || ACCOUNT_PATHS.runtimeDbPath)
        : (process.env.WORKBENCH_RUNTIME_DB_PATH || DEFAULT_RUNTIME_DB_PATH),
      session_dir: WORKER_PLATFORM === 'wa' ? WA_AUTH_DATA_PATH : TG_SESSION_DIR,
    }),
  });
  return true;
}

function releaseAccountLease() {
  if (!ACCOUNT_SCOPED) return;
  try {
    runtimeDb.prepare(`
      DELETE FROM account_worker_leases
      WHERE platform = @platform
        AND account = @account
        AND lease_name = 'account-runtime'
        AND holder_id = @holderId
        AND run_id = @runId
    `).run({
      platform: WORKER_PLATFORM,
      account: WORKER_ACCOUNT,
      holderId: WORKER_HOLDER_ID,
      runId: WORKER_RUN_ID,
    });
  } catch (err) {
    log(`failed to release account lease: ${err.message}`);
  }
}

function saveTgCredential(request, data) {
  const sessionDir = tgSessionDirFor(request);
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `${sanitizeSegment(request.account)}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    platform: 'tg',
    account: request.account,
    display_name: request.display_name,
    updated_at: new Date().toISOString(),
    ...data,
  }, null, 2), { mode: 0o600 });
}

function patchRequest(requestId, patch, requestLike = {}) {
  return withRuntimeDbFor(requestLike, (db) => {
    const request = updateServiceAccountLoginRequest(db, requestId, patch);
    if (request) {
      upsertProfile({
        platform: request.platform,
        account: request.account,
        display_name: requestLike.display_name || request.display_name,
        login_mode: request.login_mode,
      }, request.status, requestLike.display_name || request.display_name);
      reportHeartbeat(db, request, patch.error_message ? 'error' : request.status, patch.worker_message || patch.error_message || '');
    }
    return request;
  });
}

function upsertProfile(request, status, displayName) {
  upsertServiceAccountProfile({
    dbPath: rawDbPathFor(request),
    platform: request.platform,
    account: request.account,
    displayName: displayName || request.display_name || request.account,
    loginType: request.login_mode,
    status,
  });
}

function reportHeartbeat(db, request, status, message) {
  const accountId = `${request.platform}-${request.account}`;
  db.prepare(`
    INSERT INTO collector_heartbeats (
      account_id, platform, collector_id, run_id, status, phase, health_status,
      last_error, last_ready_at, started_at, updated_at
    )
    VALUES (
      @account_id, @platform, @collector_id, @run_id, @status, @phase, @health_status,
      @last_error, @last_ready_at, @started_at, CURRENT_TIMESTAMP
    )
    ON CONFLICT(account_id, collector_id) DO UPDATE SET
      status = excluded.status,
      phase = excluded.phase,
      health_status = excluded.health_status,
      last_error = excluded.last_error,
      last_ready_at = COALESCE(excluded.last_ready_at, collector_heartbeats.last_ready_at),
      updated_at = CURRENT_TIMESTAMP
  `).run({
    account_id: accountId,
    platform: request.platform,
    collector_id: `workbench-login:${request.platform}:${request.account}`,
    run_id: `${process.pid}`,
    status,
    phase: status,
    health_status: status,
    last_error: status === 'error' ? message : '',
    last_ready_at: status === 'authenticated' ? new Date().toISOString() : null,
    started_at: new Date().toISOString(),
  });
}

function forEachRuntimeDb(fn) {
  if (ACCOUNT_DB_MODE && !ACCOUNT_SCOPED) {
    for (const ref of listAccountRefs()) {
      if (!fs.existsSync(ref.paths.runtimeDbPath)) continue;
      const db = openRuntimeDb(ref.paths.runtimeDbPath);
      try {
        fn(db, { platform: ref.platform, account: ref.account, paths: ref.paths });
      } finally {
        db.close();
      }
    }
    return;
  }
  fn(runtimeDb, {
    platform: WORKER_PLATFORM,
    account: WORKER_ACCOUNT,
    paths: ACCOUNT_PATHS,
  });
}

function withRuntimeDbFor(requestLike = {}, fn) {
  if (ACCOUNT_DB_MODE && !ACCOUNT_SCOPED && requestLike.platform && requestLike.account) {
    const paths = ensureAccountDatabases(requestLike.platform, requestLike.account);
    const db = openRuntimeDb(paths.runtimeDbPath);
    try {
      return fn(db, { platform: paths.platform, account: paths.account, paths });
    } finally {
      db.close();
    }
  }
  return fn(runtimeDb, {
    platform: WORKER_PLATFORM,
    account: WORKER_ACCOUNT,
    paths: ACCOUNT_PATHS,
  });
}

function pathsFor(requestLike = {}) {
  if ((ACCOUNT_DB_MODE || ACCOUNT_SCOPED) && requestLike.platform && requestLike.account) {
    return ensureAccountDatabases(requestLike.platform, requestLike.account);
  }
  return ACCOUNT_PATHS;
}

function rawDbPathFor(requestLike = {}) {
  const paths = pathsFor(requestLike);
  return paths ? paths.rawDbPath : RAW_DB_PATH;
}

function waSessionDirFor(requestLike = {}) {
  const paths = pathsFor(requestLike);
  const sessionDir = paths && normalizeAccountPlatform(requestLike.platform) === 'wa'
    ? paths.sessionDir
    : WA_AUTH_DATA_PATH;
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function tgSessionDirFor(requestLike = {}) {
  const paths = pathsFor(requestLike);
  const sessionDir = paths && normalizeAccountPlatform(requestLike.platform) === 'tg'
    ? paths.sessionDir
    : TG_SESSION_DIR;
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function getRequest(requestId, requestLike = {}) {
  if (ACCOUNT_DB_MODE && !ACCOUNT_SCOPED && (!requestLike.platform || !requestLike.account)) {
    for (const ref of listAccountRefs()) {
      if (!fs.existsSync(ref.paths.runtimeDbPath)) continue;
      const db = openRuntimeDb(ref.paths.runtimeDbPath);
      try {
        const row = db.prepare(`
          SELECT *
          FROM service_account_login_requests
          WHERE request_id = ?
        `).get(requestId);
        if (row) return mapRequestRow(row);
      } finally {
        db.close();
      }
    }
    return null;
  }
  return withRuntimeDbFor(requestLike, (db) => {
    const row = db.prepare(`
      SELECT *
      FROM service_account_login_requests
      WHERE request_id = ?
    `).get(requestId);
    return row ? mapRequestRow(row) : null;
  });
}

function mapRequestRow(row) {
  return {
    request_id: row.request_id,
    platform: row.platform,
    account: row.account,
    display_name: row.display_name,
    login_mode: row.login_mode,
    status: row.status,
    qr_payload: row.qr_payload,
    expires_at: row.expires_at,
  };
}

function stopWaRequest(requestId) {
  const state = activeWaByRequest.get(requestId);
  if (!state) return;
  activeWaByRequest.delete(requestId);
  if (activeWaByAccount.get(state.account)?.requestId === requestId) {
    activeWaByAccount.delete(state.account);
  }
  try {
    state.client.destroy();
  } catch (_) {}
}

function archiveDoorbell(filePath, bucket) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    log(`failed to remove ${bucket} doorbell ${filePath}: ${err.message}`);
  }
}

function sanitizeSegment(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function log(message) {
  console.log(`[workbench-login-worker] ${message}`);
}

function shutdown() {
  log('stopping');
  clearInterval(pollTimer);
  for (const requestId of [...activeWaByRequest.keys()]) stopWaRequest(requestId);
  releaseAccountLease();
  runtimeDb.close();
  process.exit(0);
}
