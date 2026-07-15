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
  resolveAccountPaths,
  sanitizeAccountSegment,
} = require('../db/account-db');
const {
  buildChromeLaunchConfig,
  buildWaWebVersionOptions,
  enrichChromeLaunchError,
  prepareWaChromeProfile,
} = require('../lib/chrome-launch');
const {
  ACTIVE_LOGIN_STATUSES,
  cancelSupersededLoginRequests,
  updateServiceAccountLoginRequest,
} = require('../lib/service-account-login-store');
const { installProcessGuards, logEvent } = require('../lib/runtime-observability');

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
let pollTimer = null;
let stopping = false;
installProcessGuards({
  processName: 'service-login-worker',
  runtimeDb,
  shutdown: (reason, options) => shutdown(reason, options),
  context: { platform: WORKER_PLATFORM || null, account: WORKER_ACCOUNT || null, pid: process.pid },
});
const activeWaByRequest = new Map();
const activeWaByAccount = new Map();

fs.mkdirSync(OUTBOX_DIR, { recursive: true });
fs.mkdirSync(WA_AUTH_DATA_PATH, { recursive: true });
fs.mkdirSync(TG_SESSION_DIR, { recursive: true });

log(`started, outbox=${OUTBOX_DIR}${ACCOUNT_SCOPED ? `, account=${WORKER_PLATFORM}:${WORKER_ACCOUNT}` : ''}${ACCOUNT_DB_MODE ? ', account-db-mode=isolated' : ''}`);
tick().catch((err) => log(`initial tick failed: ${err.stack || err.message}`));
pollTimer = setInterval(() => {
  tick().catch((err) => log(`tick failed: ${err.stack || err.message}`));
}, POLL_INTERVAL_MS);

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function tick() {
  if (!ACCOUNT_SCOPED) reportProcessHeartbeat('running');
  if (ACCOUNT_SCOPED && !renewAccountLease()) return;
  expireRequests();
  await processDoorbells();
  resumeWaitingWaRequests();
}

function reportProcessHeartbeat(status) {
  runtimeDb.prepare(`
    INSERT INTO process_heartbeats (process_role, holder_id, status, pid, updated_at)
    VALUES ('login-worker', ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(process_role) DO UPDATE SET holder_id = excluded.holder_id,
      status = excluded.status, pid = excluded.pid, updated_at = CURRENT_TIMESTAMP
  `).run(WORKER_HOLDER_ID, status, process.pid);
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
    await authenticateTgUserSession(request, payload.credential);
    return;
  }
  if (request.platform === 'tg' && request.login_mode === 'tg_user_phone') {
    if (payload.action === 'verify' || payload.credential?.phase === 'verify') {
      await completeTgUserPhoneLogin(request, payload.credential || {});
    } else {
      await startTgUserPhoneLogin(request, payload.credential || {});
    }
    return;
  }
  throw new Error(`unsupported login mode: ${request.platform}/${request.login_mode}`);
}

function resumeWaitingWaRequests() {
  if (ACCOUNT_SCOPED && WORKER_PLATFORM !== 'wa') return;
  forEachRuntimeDb((db, context) => {
    const activeStatusSql = ACTIVE_LOGIN_STATUSES.map((status) => `'${status}'`).join(', ');
    const rows = db.prepare(`
      SELECT *
      FROM service_account_login_requests
      WHERE platform = 'wa'
        AND login_mode = 'wa_qr'
        ${ACCOUNT_SCOPED || context.account ? 'AND account = @account' : ''}
        AND status IN (${activeStatusSql})
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY created_at DESC, request_id DESC
      LIMIT 50
    `).all(ACCOUNT_SCOPED || context.account ? { account: WORKER_ACCOUNT || context.account } : {});
    const newestByAccount = new Set();
    for (const row of rows) {
      const accountKey = `${row.platform}:${row.account}`;
      if (newestByAccount.has(accountKey)) {
        patchRequest(row.request_id, {
          status: 'canceled',
          qr_payload: '',
          worker_message: '已被新的登录任务取代',
          error_message: '',
        }, row);
        continue;
      }
      newestByAccount.add(accountKey);
      cancelSupersededLoginRequests(db, row);
      startWaLogin(mapRequestRow(row));
    }
  });
}

function expireRequests() {
  forEachRuntimeDb((db, context) => {
    const rows = db.prepare(`
      SELECT request_id, platform, account, display_name, login_mode
      FROM service_account_login_requests
      WHERE status IN ('requested', 'waiting_qr', 'waiting_verification', 'waiting_code', 'waiting_password')
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
      cleanupPendingTgPhoneLogin(row);
    }
  });
}

function startWaLogin(request) {
  if (activeWaByRequest.has(request.request_id)) return;

  const previous = activeWaByAccount.get(request.account);
  if (previous && previous.requestId !== request.request_id) {
    stopWaRequest(previous.requestId);
  }

  if (waitForAccountRuntimeRelease(request)) return;

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
  const clientId = sanitizeSegment(request.account);

  let puppeteerConfig;
  let waWebVersionOptions;
  try {
    prepareWaChromeProfile(waSessionDir, clientId, { log });
    puppeteerConfig = buildChromeLaunchConfig(waSessionDir, {
      log,
      puppeteer: require('puppeteer'),
    });
    waWebVersionOptions = buildWaWebVersionOptions(waSessionDir, { log });
  } catch (err) {
    patchRequest(request.request_id, {
      status: 'failed',
      qr_payload: '',
      error_message: err.message,
      worker_message: 'WA 浏览器启动环境不可用',
    }, request);
    log(`WA browser preflight unavailable for ${request.account}: ${err.stack || err.message}`);
    return;
  }

  const client = new wa.Client({
    authStrategy: new wa.LocalAuth({
      clientId,
      dataPath: waSessionDir,
      rmMaxRetries: 10,
    }),
    authTimeoutMs: Number(process.env.WORKBENCH_WA_AUTH_TIMEOUT_MS || 300000),
    qrMaxRetries: Number(process.env.WORKBENCH_WA_QR_MAX_RETRIES || 0),
    takeoverOnConflict: envFlag(process.env.WORKBENCH_WA_TAKEOVER_ON_CONFLICT, true),
    takeoverTimeoutMs: boundedNumber(process.env.WORKBENCH_WA_TAKEOVER_TIMEOUT_MS, 5000, 0, 60000),
    ...waWebVersionOptions,
    puppeteer: puppeteerConfig,
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

  client.on('loading_screen', (percent, message) => {
    const progress = Number.isFinite(Number(percent)) ? `${percent}%` : String(percent || '');
    patchRequest(request.request_id, {
      status: 'waiting_verification',
      worker_message: `WA 正在加载${progress ? ` ${progress}` : ''}${message ? `：${message}` : ''}`,
      error_message: '',
    }, request);
  });

  client.on('change_state', (stateName) => {
    patchRequest(request.request_id, {
      worker_message: `WA 连接状态：${stateName || 'unknown'}`,
      error_message: '',
    }, request);
    log(`WA state for ${request.account}: ${stateName || 'unknown'}`);
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
    const launchErr = enrichChromeLaunchError(err, puppeteerConfig);
    patchRequest(request.request_id, {
      status: 'failed',
      qr_payload: '',
      error_message: launchErr.message,
      worker_message: 'WA 客户端启动失败',
    }, request);
    log(`WA client start failed for ${request.account}: ${launchErr.stack || launchErr.message}`);
    stopWaRequest(request.request_id);
  });
}

function waitForAccountRuntimeRelease(request) {
  if (!ACCOUNT_DB_MODE || ACCOUNT_SCOPED || normalizeAccountPlatform(request.platform) !== 'wa') return false;
  const lease = getActiveAccountRuntimeLease(request);
  if (!lease) return false;
  patchRequest(request.request_id, {
    status: 'waiting_qr',
    qr_payload: '',
    error_message: '',
    worker_message: `正在释放 ${request.account} 的 WA runtime session，释放后自动生成二维码`,
  }, request);
  log(`waiting for account-runtime lease before WA login ${request.account}: holder=${lease.holder_id || '-'} expires=${lease.expires_at || '-'}`);
  return true;
}

function getActiveAccountRuntimeLease(request) {
  return withRuntimeDbFor(request, (db) => {
    const row = db.prepare(`
      SELECT holder_id, worker_role, run_id, pid, renewed_at, expires_at
      FROM account_worker_leases
      WHERE platform = @platform
        AND account = @account
        AND lease_name = 'account-runtime'
    `).get({
      platform: normalizeAccountPlatform(request.platform),
      account: request.account,
    });
    if (!row) return null;
    const expiresAt = Date.parse(row.expires_at || '');
    return Number.isFinite(expiresAt) && expiresAt > Date.now() ? row : null;
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

async function authenticateTgUserSession(request, credentialPayload) {
  const secret = String(
    credentialPayload && typeof credentialPayload === 'object'
      ? credentialPayload.value
      : credentialPayload || ''
  ).trim();
  if (!secret) throw new Error('TG user session is missing from worker handoff file');
  const accountKey = request.account.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const submittedApiId = Number(
    credentialPayload?.api_id ||
    credentialPayload?.apiId ||
    credentialPayload?.tg_api_id ||
    0
  );
  const submittedApiHash = String(
    credentialPayload?.api_hash ||
    credentialPayload?.apiHash ||
    credentialPayload?.tg_api_hash ||
    ''
  ).trim();
  const apiId = Number(
    submittedApiId ||
    process.env[`WORKBENCH_TG_API_ID_${accountKey}`] ||
    process.env.WORKBENCH_TG_API_ID ||
    process.env.TG_API_ID ||
    0
  );
  const apiHash =
    submittedApiHash ||
    process.env[`WORKBENCH_TG_API_HASH_${accountKey}`] ||
    process.env.WORKBENCH_TG_API_HASH ||
    process.env.TG_API_HASH ||
    '';
  if (!apiId || !apiHash) {
    patchRequest(request.request_id, {
      status: 'failed',
      error_message: 'TG 用户 Session 登录需要 API ID 和 App api_hash',
      worker_message: 'TG 用户 Session 登录需要 API ID 和 App api_hash',
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
      api_id: apiId,
      api_hash: apiHash,
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

async function startTgUserPhoneLogin(request, credentialPayload) {
  const credential = normalizeTgPhoneCredential(request, credentialPayload);
  const { TelegramClient, StringSession, Api } = loadTelegramUserRuntime();
  const client = new TelegramClient(new StringSession(''), credential.apiId, credential.apiHash, {
    connectionRetries: 2,
    useWSS: false,
  });

  patchRequest(request.request_id, {
    status: 'requested',
    worker_message: 'TG 用户号登录初始化中',
    error_message: '',
  }, request);

  try {
    await client.connect();
    const sent = await client.invoke(new Api.auth.SendCode({
      phoneNumber: credential.phoneNumber,
      apiId: credential.apiId,
      apiHash: credential.apiHash,
      settings: new Api.CodeSettings({}),
    }));
    const phoneCodeHash = sent.phoneCodeHash || sent.phone_code_hash || '';
    if (!phoneCodeHash) throw new Error('Telegram did not return phone_code_hash');
    savePendingTgPhoneLogin(request, {
      request_id: request.request_id,
      api_id: credential.apiId,
      api_hash: credential.apiHash,
      phone_number: credential.phoneNumber,
      phone_code_hash: phoneCodeHash,
      session: client.session.save(),
      needs_password: false,
      expires_at: request.expires_at,
    });
    patchRequest(request.request_id, {
      status: 'waiting_code',
      worker_message: `验证码已发送到 ${maskPhoneNumber(credential.phoneNumber)}，请输入 Telegram 收到的验证码`,
      error_message: '',
    }, request);
  } catch (err) {
    cleanupPendingTgPhoneLogin(request);
    patchRequest(request.request_id, {
      status: 'failed',
      error_message: err.message,
      worker_message: 'TG 用户号验证码发送失败',
    }, request);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function completeTgUserPhoneLogin(request, credentialPayload) {
  const pending = readPendingTgPhoneLogin(request);
  if (!pending) {
    patchRequest(request.request_id, {
      status: 'failed',
      error_message: 'TG 登录中间态不存在或已过期，请重新发起登录',
      worker_message: 'TG 用户号登录状态丢失',
    }, request);
    return;
  }

  const code = String(credentialPayload.code || credentialPayload.phone_code || credentialPayload.phoneCode || '').trim();
  const password = String(credentialPayload.password || credentialPayload.two_factor_password || credentialPayload.twoFactorPassword || '');
  if (!pending.needs_password && !code) {
    patchRequest(request.request_id, {
      status: 'waiting_code',
      error_message: '请输入 Telegram 验证码',
      worker_message: '等待 Telegram 验证码',
    }, request);
    return;
  }
  if (pending.needs_password && !password) {
    patchRequest(request.request_id, {
      status: 'waiting_password',
      error_message: '请输入 Telegram 二步验证密码',
      worker_message: '该账号启用了二步验证',
    }, request);
    return;
  }

  const { TelegramClient, StringSession, Api, computeCheck } = loadTelegramUserRuntime({ password: true });
  const client = new TelegramClient(new StringSession(pending.session || ''), Number(pending.api_id), pending.api_hash, {
    connectionRetries: 2,
    useWSS: false,
  });

  try {
    await client.connect();
    if (pending.needs_password) {
      await submitTgPassword(client, Api, computeCheck, password);
    } else {
      try {
        await client.invoke(new Api.auth.SignIn({
          phoneNumber: pending.phone_number,
          phoneCodeHash: pending.phone_code_hash,
          phoneCode: code,
        }));
      } catch (err) {
        if (!isTgTwoFactorNeeded(err)) throw err;
        const nextPending = {
          ...pending,
          session: client.session.save(),
          needs_password: true,
          updated_at: new Date().toISOString(),
        };
        savePendingTgPhoneLogin(request, nextPending);
        if (password) {
          await submitTgPassword(client, Api, computeCheck, password);
        } else {
          patchRequest(request.request_id, {
            status: 'waiting_password',
            error_message: '',
            worker_message: '该账号启用了 Telegram 二步验证，请输入二步密码',
          }, request);
          return;
        }
      }
    }

    const me = await client.getMe();
    const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || request.display_name || request.account;
    saveTgCredential(request, {
      login_mode: 'tg_user_session',
      session: client.session.save(),
      api_id: Number(pending.api_id),
      api_hash: pending.api_hash,
      user: {
        id: me.id?.toString?.() || String(me.id || ''),
        username: me.username || '',
        first_name: me.firstName || '',
        last_name: me.lastName || '',
      },
    });
    cleanupPendingTgPhoneLogin(request);
    patchRequest(request.request_id, {
      status: 'authenticated',
      worker_message: `TG 用户账号已登录：${name}`,
      error_message: '',
    }, { ...request, display_name: name });
  } catch (err) {
    if (!pending.needs_password && isTgInvalidCode(err)) {
      patchRequest(request.request_id, {
        status: 'waiting_code',
        error_message: readableTgLoginError(err, '验证码无效或已过期'),
        worker_message: '验证码校验失败，可重新输入',
      }, request);
      return;
    }
    if (pending.needs_password && isTgInvalidPassword(err)) {
      patchRequest(request.request_id, {
        status: 'waiting_password',
        error_message: readableTgLoginError(err, '二步密码错误'),
        worker_message: '二步密码校验失败，可重新输入',
      }, request);
      return;
    }
    patchRequest(request.request_id, {
      status: 'failed',
      error_message: readableTgLoginError(err, err.message),
      worker_message: 'TG 用户号登录校验失败',
    }, request);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

function loadTelegramUserRuntime({ password = false } = {}) {
  let TelegramClient;
  let StringSession;
  let Api;
  let computeCheck = null;
  try {
    ({ TelegramClient, Api } = require('telegram'));
    ({ StringSession } = require('telegram/sessions'));
    if (password) ({ computeCheck } = require('telegram/Password'));
  } catch (err) {
    throw new Error(`TG 用户号登录依赖不可用: ${err.message}`);
  }
  return { TelegramClient, StringSession, Api, computeCheck };
}

function normalizeTgPhoneCredential(request, credentialPayload = {}) {
  const accountKey = request.account.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const apiId = Number(
    credentialPayload.api_id ||
    credentialPayload.apiId ||
    credentialPayload.tg_api_id ||
    process.env[`WORKBENCH_TG_API_ID_${accountKey}`] ||
    process.env.WORKBENCH_TG_API_ID ||
    process.env.TG_API_ID ||
    0
  );
  const apiHash = String(
    credentialPayload.api_hash ||
    credentialPayload.apiHash ||
    credentialPayload.tg_api_hash ||
    process.env[`WORKBENCH_TG_API_HASH_${accountKey}`] ||
    process.env.WORKBENCH_TG_API_HASH ||
    process.env.TG_API_HASH ||
    ''
  ).trim();
  const phoneNumber = normalizePhoneNumber(
    credentialPayload.phone_number ||
    credentialPayload.phoneNumber ||
    credentialPayload.tg_phone_number ||
    ''
  );
  if (!apiId || !apiHash) throw new Error('TG 用户号登录需要 API ID 和 App api_hash');
  if (!phoneNumber) throw new Error('TG 用户号登录需要手机号');
  return { apiId, apiHash, phoneNumber };
}

async function submitTgPassword(client, Api, computeCheck, password) {
  if (typeof computeCheck !== 'function') throw new Error('TG 二步验证依赖不可用');
  const passwordInfo = await client.invoke(new Api.account.GetPassword());
  const passwordCheck = await computeCheck(passwordInfo, password);
  await client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));
}

function pendingTgPhoneLoginPath(requestLike = {}) {
  const sessionDir = tgSessionDirFor(requestLike);
  return path.join(sessionDir, `${sanitizeSegment(requestLike.account)}.pending-login.json`);
}

function savePendingTgPhoneLogin(request, state) {
  const filePath = pendingTgPhoneLoginPath(request);
  fs.writeFileSync(filePath, JSON.stringify({
    platform: 'tg',
    account: request.account,
    login_mode: 'tg_user_phone',
    updated_at: new Date().toISOString(),
    ...state,
  }, null, 2), { mode: 0o600 });
}

function readPendingTgPhoneLogin(request) {
  try {
    return JSON.parse(fs.readFileSync(pendingTgPhoneLoginPath(request), 'utf8'));
  } catch (_) {
    return null;
  }
}

function cleanupPendingTgPhoneLogin(request) {
  if (!request || normalizeAccountPlatform(request.platform) !== 'tg') return;
  try {
    fs.unlinkSync(pendingTgPhoneLoginPath(request));
  } catch (_) {}
}

function normalizePhoneNumber(value) {
  return String(value || '').trim().replace(/[^\d+]/g, '');
}

function maskPhoneNumber(value) {
  const phone = normalizePhoneNumber(value);
  if (!phone) return '-';
  if (phone.length <= 6) return `${phone.slice(0, 2)}***`;
  return `${phone.slice(0, Math.min(4, phone.length - 4))}***${phone.slice(-4)}`;
}

function tgErrorText(err) {
  return String(err?.errorMessage || err?.message || err || '').toUpperCase();
}

function isTgTwoFactorNeeded(err) {
  return tgErrorText(err).includes('SESSION_PASSWORD_NEEDED');
}

function isTgInvalidCode(err) {
  const text = tgErrorText(err);
  return text.includes('PHONE_CODE_INVALID') || text.includes('PHONE_CODE_EXPIRED') || text.includes('PHONE_CODE_EMPTY');
}

function isTgInvalidPassword(err) {
  return tgErrorText(err).includes('PASSWORD_HASH_INVALID') || tgErrorText(err).includes('PASSWORD_EMPTY');
}

function readableTgLoginError(err, fallback) {
  const text = tgErrorText(err);
  if (text.includes('PHONE_CODE_INVALID')) return '验证码错误';
  if (text.includes('PHONE_CODE_EXPIRED')) return '验证码已过期，请重新发起登录';
  if (text.includes('PHONE_NUMBER_INVALID')) return '手机号格式无效';
  if (text.includes('FLOOD')) return 'Telegram 限流，请稍后再试';
  if (text.includes('PASSWORD_HASH_INVALID')) return '二步密码错误';
  return fallback || err?.message || 'TG 登录失败';
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
    const paths = resolveAccountPaths(requestLike.platform, requestLike.account);
    if (!fs.existsSync(paths.runtimeDbPath)) return null;
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

function pathsFor(requestLike = {}, options = {}) {
  if (ACCOUNT_SCOPED) return ACCOUNT_PATHS;
  if (ACCOUNT_DB_MODE && requestLike.platform && requestLike.account) {
    if (options.create) return ensureAccountDatabases(requestLike.platform, requestLike.account);
    const paths = resolveAccountPaths(requestLike.platform, requestLike.account);
    return fs.existsSync(paths.accountDir) ? paths : null;
  }
  return ACCOUNT_PATHS;
}

function rawDbPathFor(requestLike = {}) {
  const paths = pathsFor(requestLike);
  return paths ? paths.rawDbPath : RAW_DB_PATH;
}

function waSessionDirFor(requestLike = {}) {
  const paths = pathsFor(requestLike);
  if (ACCOUNT_DB_MODE && !ACCOUNT_SCOPED && requestLike.platform && requestLike.account && !paths) {
    throw new Error(`account data has been deleted for ${requestLike.platform}:${requestLike.account}`);
  }
  const sessionDir = paths && normalizeAccountPlatform(requestLike.platform) === 'wa'
    ? paths.sessionDir
    : WA_AUTH_DATA_PATH;
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function tgSessionDirFor(requestLike = {}) {
  const paths = pathsFor(requestLike);
  if (ACCOUNT_DB_MODE && !ACCOUNT_SCOPED && requestLike.platform && requestLike.account && !paths) {
    throw new Error(`account data has been deleted for ${requestLike.platform}:${requestLike.account}`);
  }
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

async function stopWaRequest(requestId) {
  const state = activeWaByRequest.get(requestId);
  if (!state) return;
  activeWaByRequest.delete(requestId);
  if (activeWaByAccount.get(state.account)?.requestId === requestId) {
    activeWaByAccount.delete(state.account);
  }
  try {
    await state.client.destroy();
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

function boundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function envFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function log(message) {
  logEvent('info', 'service-login-worker', 'runtime', message, {
    platform: WORKER_PLATFORM || undefined,
    account: WORKER_ACCOUNT || undefined,
  });
}

async function shutdown(_reason = 'signal', { exitCode = 0 } = {}) {
  if (stopping) return;
  stopping = true;
  log('stopping');
  clearInterval(pollTimer);
  if (!ACCOUNT_SCOPED) reportProcessHeartbeat('stopped');
  await Promise.all([...activeWaByRequest.keys()].map((requestId) => stopWaRequest(requestId)));
  releaseAccountLease();
  runtimeDb.close();
  process.exit(exitCode);
}
