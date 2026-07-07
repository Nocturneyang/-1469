const path = require('path');
const express = require('express');
const cors = require('cors');
const { DEFAULT_RAW_DB_PATH } = require('../db/raw-messages');
const { DEFAULT_AUTH_DB_PATH, openAuthDb } = require('../db/auth-db');
const { ensureRawDb } = require('../db/raw-db');
const { DEFAULT_RUNTIME_DB_PATH, openRuntimeDb } = require('../db/runtime-db');
const { DEFAULT_WORKBENCH_DB_PATH, openWorkbenchDb } = require('../db/workbench-db');
const createAuthRouter = require('../routes/auth');
const {
  createAuthMiddleware,
  isLocalDevAuthBypass,
  isSsoEnabled,
} = require('../middleware/auth');
const { createWorkbenchRouter } = require('./routes/workbench');

function createApp(options = {}) {
  const app = express();
  const startedAt = new Date();
  const authDb = options.authDb || openAuthDb(options.authDbPath || DEFAULT_AUTH_DB_PATH);
  const rawDbPath = options.rawDbPath || DEFAULT_RAW_DB_PATH;
  const rawDb = options.rawDb || ensureRawDb(rawDbPath);
  const workbenchDb = options.workbenchDb || openWorkbenchDb(options.workbenchDbPath || DEFAULT_WORKBENCH_DB_PATH);
  const runtimeDb = options.runtimeDb || openRuntimeDb(options.runtimeDbPath || DEFAULT_RUNTIME_DB_PATH);
  const outboxDir = options.outboxDir || process.env.WORKBENCH_OUTBOX_DIR || path.join(__dirname, '..', 'outbox');
  const { authenticateToken, resolveAuthenticatedUser } = createAuthMiddleware({ authDb });

  app.locals.authDb = authDb;
  app.locals.rawDb = rawDb;
  app.locals.workbenchDb = workbenchDb;
  app.locals.runtimeDb = runtimeDb;
  app.use(cors({ origin: true, credentials: true }));
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

  app.get('/runtime-config.js', (req, res) => sendRuntimeConfig(req, res));
  app.get('/auth/sso/start', (req, res) => startSso(req, res));
  app.get('/auth/sso/logout', (req, res) => logoutSso(req, res));
  app.get(['/token/userinfo', '/api/token/userinfo'], async (req, res) => {
    const result = await resolveAuthenticatedUser(req);
    if (!result.user) {
      return res.status(401).json({ success: false, code: 401, error: 'Unauthorized' });
    }
    res.json({ success: true, code: 0, data: result.user, user: result.user, source: result.source });
  });
  app.use('/api/auth', createAuthRouter({ authDb, authenticateToken }));
  app.use('/api/workbench', authenticateToken, createWorkbenchRouter({ authDb, workbenchDb, rawDbPath, outboxDir }));

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
  const body = `window.__SOCIAL_MONITOR_CONFIG__ = ${JSON.stringify(config).replace(/</g, '\\u003c')};\n` +
    `window.__WORKBENCH_CONFIG__ = window.__SOCIAL_MONITOR_CONFIG__;\n`;
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
  const redirectTo = safeReturnUrl(req, req.query.redirect || '/');
  const url = new URL(loginUrl);
  url.searchParams.set(redirectParam, redirectTo);
  res.redirect(302, url.toString());
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
  const port = Number(process.env.WORKBENCH_PORT || process.env.PORT || 3310);
  const app = createApp();
  app.listen(port, () => {
    console.log(`[workbench] API/UI listening on http://localhost:${port}`);
    console.log(`[workbench] auth DB: ${process.env.WORKBENCH_AUTH_DB_PATH || DEFAULT_AUTH_DB_PATH}`);
    console.log(`[workbench] raw messages DB: ${process.env.WORKBENCH_RAW_DB_PATH || process.env.RAW_MESSAGES_DB_PATH || DEFAULT_RAW_DB_PATH}`);
    console.log(`[workbench] workbench DB: ${process.env.WORKBENCH_DB_PATH || DEFAULT_WORKBENCH_DB_PATH}`);
    console.log(`[workbench] runtime DB: ${process.env.WORKBENCH_RUNTIME_DB_PATH || DEFAULT_RUNTIME_DB_PATH}`);
  });
}

module.exports = {
  createApp,
};
