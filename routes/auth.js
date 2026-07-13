const express = require('express');
const {
  WORKBENCH_CSRF_COOKIE,
  WORKBENCH_SESSION_COOKIE,
  isSsoEnabled,
  signToken,
} = require('../middleware/auth');
const {
  createAuthSession,
  revokeAuthSession,
  verifyLocalUser,
} = require('../db/auth-db');

const loginFailures = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

function createAuthRouter({ authDb, authenticateToken } = {}) {
  if (!authDb) throw new Error('authDb is required');
  const router = express.Router();

  router.post('/login', (req, res) => {
    if (process.env.NODE_ENV === 'production' && isSsoEnabled()) {
      return res.status(410).json({ success: false, error: '当前部署使用工作台统一登录网关' });
    }

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) {
      return res.status(400).json({ success: false, error: '请输入用户名和密码' });
    }

    const failureKey = loginFailureKey(req, username);
    if (isLoginRateLimited(failureKey)) {
      auditLogin(authDb, req, username, 'local', false, 'rate_limited');
      return res.status(429).json({ success: false, error: '登录失败次数过多，请稍后再试' });
    }

    const user = verifyLocalUser(authDb, username, password);
    auditLogin(authDb, req, username, 'local', Boolean(user), user ? '' : 'invalid_credentials');
    if (!user) {
      recordLoginFailure(failureKey);
      return res.status(401).json({ success: false, error: '用户名或密码不正确' });
    }

    loginFailures.delete(failureKey);
    const session = createAuthSession(authDb, user, { source: 'local' });
    setAuthCookies(res, session);
    const token = signToken(user);
    res.json({ success: true, token, token_deprecated: true, user });
  });

  router.post('/logout', authenticateToken, (req, res) => {
    revokeAuthSession(authDb, req.cookies?.[WORKBENCH_SESSION_COOKIE] || readCookie(req, WORKBENCH_SESSION_COOKIE));
    clearAuthCookies(res);
    res.json({ success: true });
  });

  router.get('/me', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user, source: req.authSource });
  });

  return router;
}

function setAuthCookies(res, session) {
  const secure = process.env.NODE_ENV === 'production';
  const maxAge = Math.max(0, Date.parse(session.expiresAt) - Date.now());
  res.cookie(WORKBENCH_SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
  res.cookie(WORKBENCH_CSRF_COOKIE, session.csrfToken, {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}

function clearAuthCookies(res) {
  const secure = process.env.NODE_ENV === 'production';
  res.clearCookie(WORKBENCH_SESSION_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
  res.clearCookie(WORKBENCH_CSRF_COOKIE, { httpOnly: false, secure, sameSite: 'lax', path: '/' });
}

function readCookie(req, name) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

function loginFailureKey(req, username) {
  return `${req.ip || req.socket?.remoteAddress || 'unknown'}:${String(username || '').toLowerCase()}`;
}

function isLoginRateLimited(key) {
  const current = loginFailures.get(key);
  if (!current) return false;
  if (current.startedAt + LOGIN_WINDOW_MS <= Date.now()) {
    loginFailures.delete(key);
    return false;
  }
  return current.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key) {
  const current = loginFailures.get(key);
  if (!current || current.startedAt + LOGIN_WINDOW_MS <= Date.now()) {
    loginFailures.set(key, { count: 1, startedAt: Date.now() });
    return;
  }
  current.count += 1;
}

function auditLogin(db, req, username, source, ok, reason) {
  try {
    db.prepare(`
      INSERT INTO login_audit (username, auth_source, ok, reason, ip)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, source, ok ? 1 : 0, reason || '', req.ip || req.socket?.remoteAddress || '');
  } catch (_) { }
}

module.exports = createAuthRouter;
module.exports.clearAuthCookies = clearAuthCookies;
module.exports.setAuthCookies = setAuthCookies;
