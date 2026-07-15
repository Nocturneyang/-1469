const crypto = require('crypto');
const net = require('net');
const {
  listSsoAdmins,
  resolveAuthSession,
  validateSessionCsrf,
} = require('../db/auth-db');

const TOKEN_PREFIX = 'wb1';
const DEFAULT_SUPER_ADMIN_IDENTITIES = [];
const SSO_USER_CACHE_TTL_MS = positiveNumber('SSO_USER_CACHE_TTL_MS', 30 * 60 * 1000);
const ssoUserCache = new Map();
const WORKBENCH_SESSION_COOKIE = 'workbench_session';
const WORKBENCH_CSRF_COOKIE = 'workbench_csrf';

function positiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envFlag(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function isSsoEnabled() {
  return envFlag('SSO_ENABLED') || envFlag('SKYLINE_SSO_ENABLED');
}

function tokenSecret() {
  const secret = String(process.env.JWT_SECRET || process.env.WORKBENCH_JWT_SECRET || '');
  if (secret.length >= 32) return secret;
  if (process.env.NODE_ENV === 'production' && !isSsoEnabled()) {
    throw new Error('JWT_SECRET must be at least 32 chars for local login');
  }
  if (!global.__WORKBENCH_EPHEMERAL_JWT_SECRET__) {
    global.__WORKBENCH_EPHEMERAL_JWT_SECRET__ = crypto.randomBytes(48).toString('base64url');
    console.warn('[auth] JWT_SECRET is missing or short; generated temporary in-memory token secret');
  }
  return global.__WORKBENCH_EPHEMERAL_JWT_SECRET__;
}

function signToken(user, ttlSeconds = Number(process.env.AUTH_TOKEN_TTL_SECONDS || 24 * 60 * 60)) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    id: user.id,
    username: user.username,
    display_name: user.display_name || user.displayName || user.username,
    role: user.role || 'viewer',
    iat: now,
    exp: now + Math.max(60, ttlSeconds),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', tokenSecret()).update(body).digest('base64url');
  return `${TOKEN_PREFIX}.${body}.${sig}`;
}

function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const [prefix, body, sig] = parts;
  const expected = crypto.createHmac('sha256', tokenSecret()).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
    return applyAdminPolicy(payload);
  } catch (_) {
    return null;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readHeader(req, names) {
  for (const name of names) {
    const value = req.headers[String(name).toLowerCase()];
    if (Array.isArray(value) && value[0]) return value[0];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function readCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return '';
  const target = `${name}=`;
  for (const part of String(cookieHeader).split(';')) {
    const item = part.trim();
    if (item.startsWith(target)) return decodeURIComponent(item.slice(target.length));
  }
  return '';
}

function getBearerToken(req) {
  const authHeader = String(req.headers.authorization || '');
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
}

function getWorkbenchSessionToken(req) {
  return readCookie(req, WORKBENCH_SESSION_COOKIE);
}

function getSsoToken(req) {
  return getBearerToken(req) ||
    readHeader(req, ['satoken', 'x-sso-token', 'x-auth-token']) ||
    readCookie(req, 'satoken');
}

function getSsoUserInfoUrl() {
  if (process.env.SSO_USERINFO_URL) return process.env.SSO_USERINFO_URL;
  const loginUrl = String(process.env.SSO_LOGIN_URL || '');
  if (loginUrl.includes('skyline-ark-sso.tyhark.com')) {
    return 'https://skyline-ark-sso.tyhark.com/token/userinfo';
  }
  return '';
}

function trustSsoProxyHeaders(req) {
  if (!envFlag('SSO_TRUST_PROXY_HEADERS')) return false;
  const trustedCidrs = splitList(process.env.SSO_TRUSTED_PROXY_CIDR || process.env.TRUSTED_PROXY_CIDR);
  if (!trustedCidrs.length) return false;
  const remoteAddress = normalizeIpAddress(req?.socket?.remoteAddress || req?.ip || '');
  return trustedCidrs.some((cidr) => ipMatchesCidr(remoteAddress, cidr));
}

function parseSsoUserHeader(req) {
  const raw = readHeader(req, ['x-sso-user', 'x-user-info', 'x-auth-user-info']);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    return mapRemoteUserInfo(parsed);
  } catch (_) {
    return null;
  }
}

function getSsoUserFromHeaders(req) {
  if (!isSsoEnabled() || !trustSsoProxyHeaders(req)) return null;
  const encoded = parseSsoUserHeader(req);
  if (encoded) return encoded;
  const id = readHeader(req, ['x-user-id', 'x-auth-user-id', 'x-forwarded-user-id', 'x-sso-user-id']);
  const username = readHeader(req, ['x-user-name', 'x-user-username', 'x-auth-user', 'x-forwarded-user', 'x-sso-username']);
  const email = readHeader(req, ['x-user-email', 'x-auth-user-email', 'x-forwarded-email']);
  if (!id && !username && !email) return null;
  return applyAdminPolicy({
    id: id || username || email,
    username: username || email || String(id),
    display_name: readHeader(req, ['x-user-display-name', 'x-auth-user-display-name', 'x-sso-display-name']) || username || email || String(id),
    email,
    mobile: readHeader(req, ['x-user-mobile', 'x-user-phone', 'x-sso-mobile']),
    department: readHeader(req, ['x-user-department', 'x-user-dept', 'x-sso-department']),
    role: readHeader(req, ['x-user-role', 'x-auth-user-role', 'x-sso-role']),
  });
}

function mapRemoteUserInfo(payload) {
  const data = payload && (payload.data || payload.user || payload.result || payload);
  if (!data || typeof data !== 'object') return null;
  const username = data.username || data.name || data.loginName || data.account || data.userName || data.nickName;
  const id = data.id || data.userId || data.user_id || data.uid || username;
  if (!id && !username) return null;
  return applyAdminPolicy({
    id,
    username: username || String(id),
    display_name: data.display_name || data.displayName || data.name || data.nickName || username || String(id),
    email: data.email || '',
    mobile: data.mobile || data.phone || data.phoneNumber || '',
    department: data.department || data.deptName || data.orgName || '',
    role: data.role || data.userRole || data.permission,
  });
}

async function getSsoUserFromRemote(token) {
  const userInfoUrl = getSsoUserInfoUrl();
  if (!isSsoEnabled() || !token || !userInfoUrl || typeof fetch !== 'function') return null;
  const cached = ssoUserCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.user;
  if (cached) ssoUserCache.delete(token);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SSO_USERINFO_TIMEOUT_MS || 4000));
  try {
    const response = await fetch(userInfoUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        satoken: token,
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const user = mapRemoteUserInfo(await response.json());
    if (user) ssoUserCache.set(token, { user, expiresAt: Date.now() + SSO_USER_CACHE_TTL_MS });
    return user;
  } catch (err) {
    console.warn('[auth] SSO userinfo validation failed:', err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isLocalHostName(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(normalized);
}

function isLocalRequest(req) {
  const host = String(req.headers.host || '').split(':')[0];
  const remoteAddress = String(req.socket?.remoteAddress || req.ip || '').replace(/^::ffff:/, '');
  return isLocalHostName(host) || isLocalHostName(remoteAddress);
}

function isLocalDevAuthBypass(req) {
  if (isSsoEnabled()) return false;
  if (process.env.NODE_ENV === 'production') return false;
  if (!envFlag('LOCAL_DEV_AUTH_BYPASS') || envFlag('DISABLE_LOCAL_DEV_AUTH_BYPASS')) return false;
  return isLocalRequest(req);
}

function localDevUser() {
  const id = String(process.env.WORKBENCH_LOCAL_DEV_ADMIN_ID || 'local-dev-admin').trim() || 'local-dev-admin';
  return {
    id,
    username: 'admin',
    display_name: '本地开发管理员',
    role: 'admin',
  };
}

function normalizeIpAddress(value) {
  const ip = String(value || '').trim().replace(/^::ffff:/, '');
  const zoneIndex = ip.indexOf('%');
  return zoneIndex >= 0 ? ip.slice(0, zoneIndex) : ip;
}

function ipMatchesCidr(address, rule) {
  const [networkAddress, prefixText] = String(rule || '').trim().split('/');
  const ip = normalizeIpAddress(address);
  const networkIp = normalizeIpAddress(networkAddress);
  const version = net.isIP(ip);
  if (!version || net.isIP(networkIp) !== version) return false;
  if (prefixText === undefined || prefixText === '') return ip === networkIp;
  const maxBits = version === 4 ? 32 : 128;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxBits) return false;
  const left = ipToBigInt(ip, version);
  const right = ipToBigInt(networkIp, version);
  if (left === null || right === null) return false;
  const shift = BigInt(maxBits - prefix);
  return (left >> shift) === (right >> shift);
}

function ipToBigInt(address, version) {
  if (version === 4) {
    return address.split('.').reduce((value, part) => (value << 8n) + BigInt(Number(part)), 0n);
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  try {
    return parts.reduce((value, part) => (value << 16n) + BigInt(`0x${part || '0'}`), 0n);
  } catch (_) {
    return null;
  }
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function identities(user = {}) {
  return [
    user.id,
    user.username,
    user.display_name,
    user.displayName,
    user.name,
    user.email,
    user.mobile,
    user.department,
  ].filter(Boolean).map((item) => String(item).trim()).filter(Boolean);
}

function applyAdminPolicy(user) {
  const admins = new Set([
    ...DEFAULT_SUPER_ADMIN_IDENTITIES,
    ...splitList(process.env.SSO_ADMIN_USERS),
    ...splitList(process.env.WORKBENCH_SUPER_ADMINS),
  ]);
  const role = String(user.role || '').trim().toLowerCase();
  const trustClaimedAdminRole = envFlag('SSO_TRUST_ADMIN_ROLE');
  const isAdmin = admins.has('*') ||
    identities(user).some((item) => admins.has(item)) ||
    (trustClaimedAdminRole && ['admin', 'administrator', 'owner', 'super_admin'].includes(role));
  return {
    ...user,
    role: isAdmin ? 'admin' : normalizeRole(user.role),
  };
}

function applyDbAdminPolicy(authDb, user) {
  if (!authDb || !user) return user;
  try {
    const admins = new Set(listSsoAdmins(authDb));
    if (identities(user).some((item) => admins.has(item))) return { ...user, role: 'admin' };
  } catch (_) { }
  return user;
}

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (['admin', 'administrator', 'owner', 'super_admin'].includes(value)) return 'admin';
  if (['viewer', 'view', 'readonly', 'read_only', 'user'].includes(value)) return 'viewer';
  return value || 'viewer';
}

function createAuthMiddleware({ authDb } = {}) {
  async function resolveAuthenticatedUser(req) {
    const authSession = resolveAuthSession(authDb, getWorkbenchSessionToken(req));
    if (authSession?.user) {
      req.authSession = authSession;
      return { user: applyDbAdminPolicy(authDb, authSession.user), source: 'workbench-session' };
    }
    const localTokenUser = verifyToken(getBearerToken(req));
    if (localTokenUser) return { user: applyDbAdminPolicy(authDb, localTokenUser), source: 'local-token' };

    const headerUser = getSsoUserFromHeaders(req);
    if (headerUser) return { user: applyDbAdminPolicy(authDb, headerUser), source: 'sso-header' };

    const token = getSsoToken(req);
    const remoteUser = await getSsoUserFromRemote(token);
    if (remoteUser) return { user: applyDbAdminPolicy(authDb, remoteUser), source: 'sso-remote' };

    if (isLocalDevAuthBypass(req)) return { user: localDevUser(), source: 'local-dev' };

    return { user: null, source: null, hasToken: Boolean(token) };
  }

  async function authenticateToken(req, res, next) {
    const result = await resolveAuthenticatedUser(req);
    if (!result.user) {
      return res.status(result.hasToken ? 403 : 401).json({
        success: false,
        ok: false,
        error: result.hasToken ? 'Forbidden (Token invalid or expired)' : 'Unauthorized (Token missing)',
      });
    }
    req.user = result.user;
    req.authSource = result.source;
    next();
  }

  async function resolveSsoCallbackUser(req) {
    const headerUser = getSsoUserFromHeaders(req);
    if (headerUser) return applyDbAdminPolicy(authDb, headerUser);
    const queryToken = String(req.query?.token || req.query?.satoken || req.query?.access_token || '').trim();
    const token = queryToken || getSsoToken(req);
    const remoteUser = await getSsoUserFromRemote(token);
    return remoteUser ? applyDbAdminPolicy(authDb, remoteUser) : null;
  }

  function requireCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())) return next();
    if (req.authSource !== 'workbench-session') return next();
    const headerToken = String(req.headers['x-csrf-token'] || '').trim();
    const cookieToken = readCookie(req, WORKBENCH_CSRF_COOKIE);
    if (!headerToken || headerToken !== cookieToken || !validateSessionCsrf(req.authSession, headerToken)) {
      return res.status(403).json({ success: false, ok: false, error: 'Invalid CSRF token' });
    }
    return next();
  }

  return {
    authenticateToken,
    requireCsrf,
    resolveAuthenticatedUser,
    resolveSsoCallbackUser,
  };
}

module.exports = {
  createAuthMiddleware,
  WORKBENCH_CSRF_COOKIE,
  WORKBENCH_SESSION_COOKIE,
  getSsoUserInfoUrl,
  isLocalDevAuthBypass,
  isSsoEnabled,
  signToken,
  verifyToken,
};
