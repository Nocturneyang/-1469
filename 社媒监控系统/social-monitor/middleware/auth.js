const path = require('path');
require('../lib/runtime-secret-files').hydrateRuntimeSecrets(['JWT_SECRET']);
require('dotenv').config({ path: path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');


const allowEphemeralJwtSecret = truthy(process.env.SSO_ENABLED || process.env.SKYLINE_SSO_ENABLED) ||
    truthy(process.env.DB_DEGRADED_BOOT);
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    if (allowEphemeralJwtSecret) {
        JWT_SECRET = crypto.randomBytes(48).toString('base64url');
        console.warn('[auth] JWT_SECRET 未配置或长度不足 32 位，已为 SSO/降级启动生成临时内存密钥。');
        console.warn('[auth] 请尽快在生产 Secret 中设置稳定的 JWT_SECRET，以免本地登录 Token 在重启后失效。');
    } else {
        console.error('[FATAL] JWT_SECRET 未配置或长度不足 32 位，拒绝启动。请设置强随机密钥：');
        console.error('  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
        process.exit(1);
    }
}
const SSO_USER_CACHE_TTL_MS = positiveNumber('SSO_USER_CACHE_TTL_MS', 30 * 60 * 1000);
const SSO_USER_CACHE_MAX = positiveNumber('SSO_USER_CACHE_MAX', 1000);
const SSO_ADMIN_CACHE_TTL_MS = positiveNumber('SSO_ADMIN_CACHE_TTL_MS', 60 * 60 * 1000);
const DEFAULT_SUPER_ADMIN_IDENTITIES = ['1469', '杨杰'];
const ssoUserCache = new Map();
let ssoAdminCache = { expiresAt: 0, values: new Set() };

function positiveNumber(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function truthy(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function getSsoUserInfoUrl() {
    if (process.env.SSO_USERINFO_URL) return process.env.SSO_USERINFO_URL;
    const loginUrl = String(process.env.SSO_LOGIN_URL || '');
    if (loginUrl.includes('skyline-ark-sso.tyhark.com')) {
        return 'https://skyline-ark-sso.tyhark.com/token/userinfo';
    }
    return '';
}

function isSsoEnabled() {
    return truthy(process.env.SSO_ENABLED || process.env.SKYLINE_SSO_ENABLED);
}

function trustSsoProxyHeaders() {
    return truthy(process.env.SSO_TRUST_PROXY_HEADERS);
}

function parseList(value) {
    return String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
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
    const parts = String(cookieHeader).split(';');
    for (const part of parts) {
        const item = part.trim();
        if (!item.startsWith(target)) continue;
        return decodeURIComponent(item.slice(target.length));
    }
    return '';
}

function normalizeRole(role) {
    const normalized = String(role || '').trim().toLowerCase();
    if (['admin', 'administrator', 'owner', 'super_admin'].includes(normalized)) return 'admin';
    if (['viewer', 'view', 'readonly', 'read_only', 'user'].includes(normalized)) return 'viewer';
    return process.env.SSO_DEFAULT_ROLE || 'viewer';
}

function applyAdminPolicy(user) {
    const admins = [
        ...DEFAULT_SUPER_ADMIN_IDENTITIES,
        ...parseList(process.env.SSO_ADMIN_USERS),
        ...parseList(process.env.WORKBENCH_SUPER_ADMINS)
    ];
    const identity = getUserIdentities(user);
    const trustClaimedAdminRole = truthy(process.env.SSO_TRUST_ADMIN_ROLE);
    if (
        (trustClaimedAdminRole && user.role === 'admin') ||
        admins.includes('*') ||
        identity.some((item) => admins.includes(item)) ||
        isSsoAdminIdentity(identity)
    ) {
        return { ...user, role: 'admin' };
    }
    return { ...user, role: isSsoEnabled() ? 'viewer' : normalizeRole(user.role) };
}

function getUserIdentities(user) {
    return [
        user.id,
        user.username,
        user.email,
        user.mobile,
        user.department
    ].filter(Boolean).map(item => String(item).trim()).filter(Boolean);
}

function isSsoAdminIdentity(identities) {
    if (!isSsoEnabled() || !identities.length) return false;
    try {
        const now = Date.now();
        if (now < ssoAdminCache.expiresAt) {
            return identities.some(identity => ssoAdminCache.values.has(identity));
        }
        const { db } = require('../db/database');
        const rows = db.prepare('SELECT identity FROM sso_admins').all();
        const adminSet = new Set(rows.map(row => String(row.identity || '').trim()).filter(Boolean));
        ssoAdminCache = { expiresAt: now + SSO_ADMIN_CACHE_TTL_MS, values: adminSet };
        return identities.some(identity => adminSet.has(identity));
    } catch (err) {
        console.warn('[auth] Failed to read sso_admins:', err.message);
        return false;
    }
}

function parseSsoUserHeader(req) {
    const raw = readHeader(req, ['x-sso-user', 'x-user-info', 'x-auth-user-info']);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(decodeURIComponent(raw));
        const username = parsed.username || parsed.name || parsed.loginName || parsed.account || parsed.userName;
        const id = parsed.id || parsed.userId || parsed.uid || username;
        if (!id && !username) return null;
        return applyAdminPolicy({
            id,
            username: username || String(id),
            email: parsed.email || '',
            mobile: parsed.mobile || parsed.phone || parsed.phoneNumber || '',
            department: parsed.department || parsed.deptName || parsed.orgName || '',
            role: parsed.role || parsed.userRole || parsed.permission
        });
    } catch (_) {
        return null;
    }
}

function getSsoUserFromHeaders(req) {
    if (!isSsoEnabled() || !trustSsoProxyHeaders()) return null;

    const encodedUser = parseSsoUserHeader(req);
    if (encodedUser) return encodedUser;

    const id = readHeader(req, ['x-user-id', 'x-auth-user-id', 'x-forwarded-user-id', 'x-sso-user-id']);
    const username = readHeader(req, [
        'x-user-name',
        'x-user-username',
        'x-auth-user',
        'x-forwarded-user',
        'x-sso-username',
        'x-remote-user'
    ]);
    const email = readHeader(req, ['x-user-email', 'x-auth-user-email', 'x-forwarded-email']);
    const role = readHeader(req, ['x-user-role', 'x-auth-user-role', 'x-sso-role', 'x-user-permission']);

    if (!id && !username && !email) return null;

    return applyAdminPolicy({
        id: id || username || email,
        username: username || email || String(id),
        email,
        mobile: readHeader(req, ['x-user-mobile', 'x-user-phone', 'x-sso-mobile']),
        department: readHeader(req, ['x-user-department', 'x-user-dept', 'x-sso-department']),
        role
    });
}

function getBearerToken(req) {
    const authHeader = req.headers['authorization'];
    return authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
}

function getSsoToken(req) {
    return getBearerToken(req) ||
        readHeader(req, ['satoken', 'x-sso-token', 'x-auth-token']) ||
        readCookie(req, 'satoken');
}

function verifyJwt(token) {
    if (!token) return null;
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (_) {
        return null;
    }
}

function mapRemoteUserInfo(payload) {
    const data = payload && (payload.data || payload.user || payload.result || payload);
    if (!data || typeof data !== 'object') return null;
    const username = data.username || data.name || data.loginName || data.account || data.userName || data.nickName;
    const id = data.id || data.userId || data.user_id || data.uid || username;
    if (!id && !username) return null;
    const hasAdminRole = data.is_admin === true ||
        data.isAdmin === true ||
        (Array.isArray(data.role) && data.role.some((item) => {
            if (typeof item === 'string') return item.toLowerCase() === 'admin';
            return String(item?.roleCode || item?.code || item?.name || '').toLowerCase() === 'admin';
        }));
    return applyAdminPolicy({
        id,
        username: username || String(id),
        email: data.email || '',
        mobile: data.mobile || data.phone || data.phoneNumber || '',
        department: data.department || data.deptName || data.orgName || '',
        role: hasAdminRole ? 'admin' : (data.role || data.userRole || data.permission)
    });
}

async function getSsoUserFromRemote(req, token) {
    const userInfoUrl = getSsoUserInfoUrl();
    if (!isSsoEnabled() || !token || !userInfoUrl || typeof fetch !== 'function') return null;

    const cached = ssoUserCache.get(token);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.user;
    }
    if (cached) {
        ssoUserCache.delete(token);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.SSO_USERINFO_TIMEOUT_MS || 4000));
    try {
        const response = await fetch(userInfoUrl, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                satoken: token
            },
            signal: controller.signal
        });
        if (!response.ok) return null;
        const user = mapRemoteUserInfo(await response.json());
        if (user) {
            if (ssoUserCache.size >= SSO_USER_CACHE_MAX) {
                const oldestKey = ssoUserCache.keys().next().value;
                if (oldestKey) ssoUserCache.delete(oldestKey);
            }
            ssoUserCache.set(token, { user, expiresAt: Date.now() + SSO_USER_CACHE_TTL_MS });
        }
        return user;
    } catch (err) {
        console.warn('[auth] SSO userinfo validation failed:', err.message);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function resolveAuthenticatedUser(req) {
    const bearerToken = getBearerToken(req);
    const jwtUser = verifyJwt(bearerToken);
    if (jwtUser) return { user: jwtUser, source: 'jwt' };

    const ssoHeaderUser = getSsoUserFromHeaders(req);
    if (ssoHeaderUser) return { user: ssoHeaderUser, source: 'sso-header' };

    const token = getSsoToken(req);
    const ssoRemoteUser = await getSsoUserFromRemote(req, token);
    if (ssoRemoteUser) return { user: ssoRemoteUser, source: 'sso-remote' };

    return { user: null, source: null, hasToken: Boolean(bearerToken || token) };
}

async function authenticateToken(req, res, next) {
    const result = await resolveAuthenticatedUser(req);

    if (!result.user) {
        const status = result.hasToken && !isSsoEnabled() ? 403 : 401;
        const error = result.hasToken ? 'Forbidden (Token invalid or expired)' : 'Unauthorized (Token missing)';
        return res.status(status).json({ success: false, error });
    }

    req.user = result.user;
    req.authSource = result.source;
    next();
}

function requireAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ success: false, error: 'Forbidden (Admin access required)' });
    }
}

module.exports = {
    JWT_SECRET,
    isSsoEnabled,
    resolveAuthenticatedUser,
    authenticateToken,
    requireAdmin
};
