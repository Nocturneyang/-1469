const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const express = require('express');
const cors = require('cors');
const { DEFAULT_RAW_DB_PATH } = require('../db/raw-messages');
const { DEFAULT_AUTH_DB_PATH, openAuthDb } = require('../db/auth-db');
const { createAuthSession, revokeAuthSession } = require('../db/auth-db');
const { ensureRawDb } = require('../db/raw-db');
const { DEFAULT_RUNTIME_DB_PATH, openRuntimeDb } = require('../db/runtime-db');
const { DEFAULT_WORKBENCH_DB_PATH, openWorkbenchDb } = require('../db/workbench-db');
const createAuthRouter = require('../routes/auth');
const { clearAuthCookies, setAuthCookies } = require('../routes/auth');
const {
  createAuthMiddleware,
  isLocalDevAuthBypass,
  isSsoEnabled,
} = require('../middleware/auth');
const { createWorkbenchRouter, getActiveGlobalSseClients } = require('./routes/workbench');
const { listAccountRefs } = require('../db/account-db');
const { recoverStartupState } = require('../lib/startup-recovery');
const { installProcessGuards, logEvent } = require('../lib/runtime-observability');

function createApp(options = {}) {
  const app = express();
  const startedAt = new Date();
  const authDb = options.authDb || openAuthDb(options.authDbPath || DEFAULT_AUTH_DB_PATH);
  const rawDbPath = options.rawDbPath || DEFAULT_RAW_DB_PATH;
  const rawDb = options.rawDb || ensureRawDb(rawDbPath);
  const workbenchDb = options.workbenchDb || openWorkbenchDb(options.workbenchDbPath || DEFAULT_WORKBENCH_DB_PATH);
  const runtimeDb = options.runtimeDb || openRuntimeDb(options.runtimeDbPath || DEFAULT_RUNTIME_DB_PATH);
  const outboxDir = options.outboxDir || process.env.WORKBENCH_OUTBOX_DIR || path.join(__dirname, '..', 'outbox');
  const { authenticateToken, requireCsrf, resolveAuthenticatedUser, resolveSsoCallbackUser } = createAuthMiddleware({ authDb });
  const recovery = recoverStartupState({ runtimeDb, workbenchDb, outboxDir });
  if (Object.values(recovery).some((value) => Number(value) > 0)) {
    console.log(`[workbench] startup recovery ${JSON.stringify(recovery)}`);
  }

  app.locals.authDb = authDb;
  app.locals.rawDb = rawDb;
  app.locals.workbenchDb = workbenchDb;
  app.locals.runtimeDb = runtimeDb;
  app.use(securityHeaders);
  app.use(cors({ origin: corsOriginPolicy(), credentials: true }));
  app.use(express.json({ limit: '18mb' }));

  app.get('/healthz', (req, res) => {
    res.json({
      ok: true,
      status: 'live',
      service: 'social-workbench',
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get(['/readyz', '/api/health'], (req, res) => {
    const report = buildReadyReport({ authDb, rawDb, workbenchDb, runtimeDb, rawDbPath, startedAt });
    res.status(report.ok ? 200 : 503).json(report);
  });

  app.get('/metrics', (req, res) => {
    if (!envFlag('WORKBENCH_METRICS_ENABLED')) return res.status(404).send('Not found');
    res.type('text/plain; version=0.0.4').send(buildPrometheusMetrics({ workbenchDb, runtimeDb }));
  });

  app.get('/runtime-config.js', (req, res) => sendRuntimeConfig(req, res));
  app.get('/auth/sso/start', (req, res) => startSso(req, res));
  app.get('/auth/sso/callback', async (req, res) => {
    const user = await resolveSsoCallbackUser(req);
    if (!user) return res.status(401).json({ success: false, error: 'SSO callback validation failed' });
    const session = createAuthSession(authDb, user, { source: 'sso' });
    setAuthCookies(res, session);
    res.redirect(302, safeReturnUrl(req, req.query.redirect || '/'));
  });
  app.get('/auth/sso/logout', (req, res) => {
    revokeAuthSession(authDb, readCookie(req, 'workbench_session'));
    clearAuthCookies(res);
    logoutSso(req, res);
  });
  app.get(['/token/userinfo', '/api/token/userinfo'], async (req, res) => {
    const result = await resolveAuthenticatedUser(req);
    if (!result.user) {
      return res.status(401).json({ success: false, code: 401, error: 'Unauthorized' });
    }
    if (result.source && result.source.startsWith('sso-')) {
      setAuthCookies(res, createAuthSession(authDb, result.user, { source: 'sso' }));
    }
    res.json({ success: true, code: 0, data: result.user, user: result.user, source: result.source });
  });
  app.use('/api/auth', createAuthRouter({ authDb, authenticateToken }));
  app.use('/api/workbench', authenticateToken, requireTrustedOrigin, requireCsrf, createWriteRateLimiter(options.writeRateLimit), createWorkbenchRouter({
    authDb,
    workbenchDb,
    runtimeDb,
    rawDbPath,
    outboxDir,
    accountDataDir: options.accountDataDir,
    accountDbMode: options.accountDbMode,
  }));

  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path === '/auth/sso/callback' || req.path.startsWith('/api/')) return next();
    const token = String(req.query?.token || req.query?.satoken || req.query?.access_token || '').trim();
    if (!token) return next();
    const clean = new URL(req.originalUrl, requestOrigin(req));
    clean.searchParams.delete('token');
    clean.searchParams.delete('satoken');
    clean.searchParams.delete('access_token');
    const callback = new URL('/auth/sso/callback', requestOrigin(req));
    callback.searchParams.set('token', token);
    callback.searchParams.set('redirect', clean.toString());
    return res.redirect(302, callback.toString());
  });

  const distDir = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(distDir));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'), (err) => {
      if (err) next(err);
    });
  });

  return app;
}

function buildPrometheusMetrics({ workbenchDb, runtimeDb }) {
  const totals = { pending: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 0, dead: 0, paused: 0 };
  const inspect = (db) => {
    const rows = db.prepare(`
      SELECT status, COUNT(*) AS count FROM outbound_messages GROUP BY status
    `).all();
    rows.forEach((row) => {
      if (Object.prototype.hasOwnProperty.call(totals, row.status)) totals[row.status] += Number(row.count || 0);
    });
  };
  inspect(workbenchDb);
  listAccountRefs().forEach((ref) => {
    if (!fs.existsSync(ref.paths.workbenchDbPath)) return;
    const db = new Database(ref.paths.workbenchDbPath, { readonly: true, fileMustExist: true });
    try { inspect(db); } finally { db.close(); }
  });
  const runtimeEvents = Number(runtimeDb.prepare(`
    SELECT COUNT(*) AS count FROM runtime_events WHERE severity IN ('warn', 'error')
      AND created_at >= datetime('now', '-1 hour')
  `).get()?.count || 0);
  return [
    '# HELP workbench_process_uptime_seconds API process uptime.',
    '# TYPE workbench_process_uptime_seconds gauge',
    `workbench_process_uptime_seconds ${Math.round(process.uptime())}`,
    '# HELP workbench_sse_clients Active global SSE clients.',
    '# TYPE workbench_sse_clients gauge',
    `workbench_sse_clients ${getActiveGlobalSseClients()}`,
    '# HELP workbench_outbound_messages Outbound messages by status.',
    '# TYPE workbench_outbound_messages gauge',
    ...Object.entries(totals).map(([status, count]) => `workbench_outbound_messages{status="${status}"} ${count}`),
    '# HELP workbench_runtime_events_hour Warning and error runtime events in the last hour.',
    '# TYPE workbench_runtime_events_hour gauge',
    `workbench_runtime_events_hour ${runtimeEvents}`,
    '',
  ].join('\n');
}

function envFlag(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function buildReadyReport({ authDb, rawDb, workbenchDb, runtimeDb, rawDbPath, startedAt }) {
  const checks = {
    auth: checkSqlite(authDb),
    raw: checkSqlite(rawDb),
    workbench: checkSqlite(workbenchDb),
    runtime: checkSqlite(runtimeDb),
    rawPath: {
      ok: true,
      path: rawDbPath,
    },
    channelRuntime: checkChannelRuntime(),
    controlWorkers: checkControlWorkers(runtimeDb),
    outboundQueues: checkOutboundQueues(workbenchDb),
  };
  const ok = Object.values(checks).every((check) => check.ok);
  return {
    ok,
    status: ok ? 'ready' : 'degraded',
    service: 'social-workbench',
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks,
  };
}

function checkControlWorkers(runtimeDb) {
  const required = ['1', 'true', 'yes', 'on'].includes(String(process.env.WORKBENCH_CHANNEL_RUNTIME_REQUIRED || '').toLowerCase());
  if (!required) return { ok: true, required: false, workers: [] };
  const maxAgeSeconds = Math.max(10, Number(process.env.WORKBENCH_CONTROL_HEARTBEAT_MAX_AGE_SECONDS || 30));
  const roles = ['login-worker', 'account-supervisor'];
  const workers = roles.map((role) => {
    const row = runtimeDb.prepare(`
      SELECT process_role, holder_id, status, updated_at
      FROM process_heartbeats
      WHERE process_role = ? AND status = 'running'
        AND datetime(updated_at) > datetime('now', ?)
    `).get(role, `-${maxAgeSeconds} seconds`);
    return { role, ok: Boolean(row), updated_at: row?.updated_at || null };
  });
  return { ok: workers.every((worker) => worker.ok), required: true, workers };
}

function checkOutboundQueues(globalWorkbenchDb) {
  const maxPending = Math.max(1, Number(process.env.WORKBENCH_READINESS_MAX_PENDING || 1000));
  const staleMinutes = Math.max(1, Number(process.env.WORKBENCH_READINESS_STALE_SENDING_MINUTES || 5));
  const queues = [];
  const inspect = (db, scope) => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='outbound_messages'").get();
    if (!tables) return;
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'sending' AND datetime(updated_at) <= datetime('now', @stale) THEN 1 ELSE 0 END) AS stale_sending
      FROM outbound_messages
    `).get({ stale: `-${staleMinutes} minutes` }) || {};
    queues.push({ ...scope, pending: Number(row.pending || 0), stale_sending: Number(row.stale_sending || 0) });
  };
  inspect(globalWorkbenchDb, { scope: 'global' });
  for (const ref of listAccountRefs()) {
    if (!fs.existsSync(ref.paths.workbenchDbPath)) continue;
    const db = new Database(ref.paths.workbenchDbPath, { readonly: true, fileMustExist: true });
    try {
      inspect(db, { scope: 'account', platform: ref.platform, account: ref.account });
    } finally {
      db.close();
    }
  }
  const pending = queues.reduce((sum, queue) => sum + queue.pending, 0);
  const staleSending = queues.reduce((sum, queue) => sum + queue.stale_sending, 0);
  return { ok: pending <= maxPending && staleSending === 0, pending, stale_sending: staleSending, max_pending: maxPending, queues };
}

function checkChannelRuntime() {
  const required = ['1', 'true', 'yes', 'on'].includes(String(process.env.WORKBENCH_CHANNEL_RUNTIME_REQUIRED || '').toLowerCase());
  if (!required) return { ok: true, required: false, accounts: [] };
  const accounts = [];
  for (const ref of listAccountRefs()) {
    if (!fs.existsSync(ref.paths.rawDbPath) || !fs.existsSync(ref.paths.runtimeDbPath)) continue;
    let raw;
    let runtime;
    try {
      raw = new Database(ref.paths.rawDbPath, { readonly: true, fileMustExist: true });
      const control = raw.prepare(`
        SELECT collect_enabled, workbench_visible, status
        FROM channel_account_registry WHERE account = ?
      `).get(ref.account) || {};
      const enabled = Number(control.collect_enabled ?? 1) === 1 && Number(control.workbench_visible ?? 1) === 1;
      if (!enabled) continue;
      runtime = new Database(ref.paths.runtimeDbPath, { readonly: true, fileMustExist: true });
      const lease = runtime.prepare(`
        SELECT expires_at, renewed_at, holder_id
        FROM account_worker_leases
        WHERE platform = ? AND account = ? AND lease_name = 'account-runtime'
          AND datetime(expires_at) > datetime('now')
      `).get(ref.platform, ref.account);
      accounts.push({ platform: ref.platform, account: ref.account, ok: Boolean(lease), renewed_at: lease?.renewed_at || null });
    } catch (err) {
      accounts.push({ platform: ref.platform, account: ref.account, ok: false, error: err.message });
    } finally {
      if (raw) raw.close();
      if (runtime) runtime.close();
    }
  }
  return {
    ok: accounts.every((account) => account.ok),
    required: true,
    accounts,
  };
}

function checkSqlite(db) {
  try {
    db.prepare('SELECT 1 AS ok').get();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function sendRuntimeConfig(req, res) {
  const ssoLoginUrl = process.env.SSO_LOGIN_URL || '';
  const config = {
    ssoEnabled: isSsoEnabled(),
    ssoLoginUrl,
    ssoRedirectParam: process.env.SSO_REDIRECT_PARAM || (ssoLoginUrl ? 'redirect' : ''),
    ssoLogoutUrl: process.env.SSO_LOGOUT_URL || '',
    ssoLogoutRedirectParam: process.env.SSO_LOGOUT_REDIRECT_PARAM || '',
    guestLoginEnabled: false,
    localDevAuthBypass: isLocalDevAuthBypass(req),
  };
  const encoded = JSON.stringify(config).replace(/</g, '\\u003c');
  const body = `window.__SOCIAL_WORKBENCH_CONFIG__ = ${encoded};\n` +
    `window.__WORKBENCH_CONFIG__ = window.__SOCIAL_WORKBENCH_CONFIG__;\n` +
    `window.__SOCIAL_MONITOR_CONFIG__ = window.__SOCIAL_WORKBENCH_CONFIG__;\n`;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.type('application/javascript').send(body);
}

function startSso(req, res) {
  const loginUrl = process.env.SSO_LOGIN_URL || '';
  if (!loginUrl) {
    return res.status(500).json({ success: false, error: 'SSO_LOGIN_URL is not configured' });
  }
  const redirectParam = process.env.SSO_REDIRECT_PARAM || 'redirect';
  const finalRedirect = safeReturnUrl(req, req.query.redirect || '/');
  const callback = new URL('/auth/sso/callback', requestOrigin(req));
  callback.searchParams.set('redirect', finalRedirect);
  const url = new URL(loginUrl);
  url.searchParams.set(redirectParam, callback.toString());
  res.redirect(302, url.toString());
}

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

function corsOriginPolicy() {
  const allowed = configuredOrigins();
  return (origin, callback) => {
    if (!origin) return callback(null, true);
    return callback(null, allowed.has(origin));
  };
}

function configuredOrigins() {
  const values = [process.env.WORKBENCH_PUBLIC_ORIGIN, ...(process.env.WORKBENCH_ALLOWED_ORIGINS || '').split(',')]
    .map((value) => String(value || '').trim()).filter(Boolean);
  if (process.env.NODE_ENV !== 'production') {
    values.push('http://localhost:3310', 'http://127.0.0.1:3310', 'http://localhost:3311', 'http://127.0.0.1:3311');
  }
  return new Set(values);
}

function requireTrustedOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())) return next();
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return next();
  const sameOrigin = origin === requestOrigin(req);
  if (sameOrigin || configuredOrigins().has(origin)) return next();
  return res.status(403).json({ success: false, ok: false, error: 'Untrusted request origin' });
}

function createWriteRateLimiter({ windowMs = 60 * 1000, max = 60 } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())) return next();
    const key = String(req.user?.id || req.user?.username || req.ip || 'unknown');
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ success: false, ok: false, error: 'Too many write requests' });
    }
    return next();
  };
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

function logoutSso(req, res) {
  clearSsoCookies(res);
  const requested = req.query.redirect || '/';
  const redirectTo = safeReturnUrl(req, requested);
  const logoutUrl = process.env.SSO_LOGOUT_URL || '';
  if (logoutUrl) {
    const redirectParam = process.env.SSO_LOGOUT_REDIRECT_PARAM || process.env.SSO_REDIRECT_PARAM || 'redirect';
    const url = new URL(logoutUrl);
    url.searchParams.set(redirectParam, redirectTo);
    return res.redirect(302, url.toString());
  }
  res.redirect(302, redirectTo);
}

function clearSsoCookies(res) {
  [{ path: '/' }, { path: '/', domain: '.tyhark.com', sameSite: 'lax', secure: true }]
    .forEach((options) => res.clearCookie('satoken', options));
}

function requestOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  let proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  if (host.endsWith('.tyhark.com')) proto = 'https';
  return `${proto}://${host}`;
}

function safeReturnUrl(req, requested) {
  const origin = requestOrigin(req);
  try {
    const target = new URL(String(requested || '/'), origin);
    const current = new URL(origin);
    if (target.hostname !== current.hostname) return new URL('/', origin).toString();
    if (target.pathname.match(/\/login\b/)) return new URL('/', origin).toString();
    return target.toString();
  } catch (_) {
    return new URL('/', origin).toString();
  }
}

if (require.main === module) {
  const port = Number(process.env.WORKBENCH_PORT || process.env.PORT || 3311);
  const app = createApp();
  const server = app.listen(port, () => {
    logEvent('info', 'workbench-api', 'listening', `API/UI listening on port ${port}`);
  });
  let shuttingDown = false;
  const shutdown = (_reason, { exitCode = 0 } = {}) => new Promise((resolve) => {
    if (shuttingDown) return resolve();
    shuttingDown = true;
    server.close(() => {
      for (const key of ['authDb', 'rawDb', 'workbenchDb', 'runtimeDb']) {
        try { app.locals[key]?.close(); } catch (_) { }
      }
      resolve();
      process.exit(exitCode);
    });
    setTimeout(() => process.exit(exitCode || 1), 10000).unref();
  });
  installProcessGuards({
    processName: 'workbench-api',
    runtimeDb: app.locals.runtimeDb,
    shutdown,
    context: { pid: process.pid },
  });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  createApp,
};
