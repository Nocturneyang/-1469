const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'social-monitor-fallback-secret';

function truthy(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isSsoEnabled() {
    return truthy(process.env.SSO_ENABLED || process.env.SKYLINE_SSO_ENABLED);
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

function normalizeRole(role) {
    const normalized = String(role || '').trim().toLowerCase();
    if (['admin', 'administrator', 'owner', 'super_admin'].includes(normalized)) return 'admin';
    if (['viewer', 'view', 'readonly', 'read_only', 'user'].includes(normalized)) return 'viewer';
    return process.env.SSO_DEFAULT_ROLE || 'viewer';
}

function applyAdminPolicy(user) {
    const admins = parseList(process.env.SSO_ADMIN_USERS);
    const identity = [user.id, user.username, user.email].filter(Boolean).map(String);
    if (user.role === 'admin' || admins.includes('*') || identity.some((item) => admins.includes(item))) {
        return { ...user, role: 'admin' };
    }
    return { ...user, role: normalizeRole(user.role) };
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
            role: parsed.role || parsed.userRole || parsed.permission
        });
    } catch (_) {
        return null;
    }
}

function getSsoUserFromHeaders(req) {
    if (!isSsoEnabled()) return null;

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
        role
    });
}

function getBearerToken(req) {
    const authHeader = req.headers['authorization'];
    return authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
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
    const id = data.id || data.userId || data.uid || username;
    if (!id && !username) return null;
    return applyAdminPolicy({
        id,
        username: username || String(id),
        email: data.email || '',
        role: data.role || data.userRole || data.permission
    });
}

async function getSsoUserFromRemote(req, token) {
    if (!isSsoEnabled() || !token || !process.env.SSO_USERINFO_URL || typeof fetch !== 'function') return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.SSO_USERINFO_TIMEOUT_MS || 4000));
    try {
        const response = await fetch(process.env.SSO_USERINFO_URL, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                satoken: token
            },
            signal: controller.signal
        });
        if (!response.ok) return null;
        return mapRemoteUserInfo(await response.json());
    } catch (err) {
        console.warn('[auth] SSO userinfo validation failed:', err.message);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function resolveAuthenticatedUser(req) {
    const token = getBearerToken(req);
    const jwtUser = verifyJwt(token);
    if (jwtUser) return { user: jwtUser, source: 'jwt' };

    const ssoHeaderUser = getSsoUserFromHeaders(req);
    if (ssoHeaderUser) return { user: ssoHeaderUser, source: 'sso-header' };

    const ssoRemoteUser = await getSsoUserFromRemote(req, token);
    if (ssoRemoteUser) return { user: ssoRemoteUser, source: 'sso-remote' };

    return { user: null, source: null, hasToken: Boolean(token) };
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
