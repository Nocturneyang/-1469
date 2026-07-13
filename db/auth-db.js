const crypto = require('crypto');
const Database = require('better-sqlite3');
const { ensureDirectory, resolveDbPath } = require('./paths');

const DEFAULT_AUTH_DB_PATH = resolveDbPath(['WORKBENCH_AUTH_DB_PATH', 'AUTH_DB_PATH'], 'auth.sqlite');

function openAuthDb(dbPath = DEFAULT_AUTH_DB_PATH) {
  ensureDirectory(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login TEXT
    );

    CREATE TABLE IF NOT EXISTS sso_admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identity TEXT NOT NULL UNIQUE,
      display_name TEXT,
      note TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS login_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      auth_source TEXT NOT NULL,
      ok INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      csrf_hash TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      user_json TEXT NOT NULL,
      auth_source TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_operator_expiry
      ON auth_sessions(operator_id, expires_at);
  `);
  seedBootstrap(db);
  return db;
}

function createAuthSession(db, user, { source = 'local', ttlSeconds = Number(process.env.AUTH_SESSION_TTL_SECONDS || 8 * 60 * 60) } = {}) {
  if (!db || !user) throw new Error('auth database and user are required');
  const token = crypto.randomBytes(48).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const operatorId = String(user.id || user.username || '').trim();
  if (!operatorId) throw new Error('session operator id is required');
  const expiresAt = new Date(Date.now() + Math.max(300, Number(ttlSeconds) || 0) * 1000).toISOString();
  db.prepare(`
    INSERT INTO auth_sessions (
      token_hash, csrf_hash, operator_id, user_json, auth_source, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    hashSessionSecret(token),
    hashSessionSecret(csrfToken),
    operatorId,
    JSON.stringify(user),
    String(source || 'local'),
    expiresAt,
  );
  purgeExpiredAuthSessions(db);
  return { token, csrfToken, expiresAt };
}

function resolveAuthSession(db, token) {
  const secret = String(token || '').trim();
  if (!db || !secret) return null;
  const row = db.prepare(`
    SELECT * FROM auth_sessions
    WHERE token_hash = ?
      AND revoked_at IS NULL
      AND datetime(expires_at) > datetime('now')
  `).get(hashSessionSecret(secret));
  if (!row) return null;
  let user;
  try {
    user = JSON.parse(row.user_json);
  } catch (_) {
    return null;
  }
  db.prepare('UPDATE auth_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ?').run(row.token_hash);
  return {
    user,
    operatorId: row.operator_id,
    authSource: row.auth_source,
    csrfHash: row.csrf_hash,
    expiresAt: row.expires_at,
  };
}

function revokeAuthSession(db, token) {
  const secret = String(token || '').trim();
  if (!db || !secret) return 0;
  return db.prepare(`
    UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP
    WHERE token_hash = ? AND revoked_at IS NULL
  `).run(hashSessionSecret(secret)).changes;
}

function validateSessionCsrf(session, csrfToken) {
  if (!session || !session.csrfHash || !csrfToken) return false;
  return safeHashEqual(session.csrfHash, hashSessionSecret(csrfToken));
}

function purgeExpiredAuthSessions(db) {
  if (!db) return 0;
  return db.prepare(`
    DELETE FROM auth_sessions
    WHERE datetime(expires_at) <= datetime('now')
       OR (revoked_at IS NOT NULL AND datetime(revoked_at) <= datetime('now', '-7 days'))
  `).run().changes;
}

function hashSessionSecret(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeHashEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function seedBootstrap(db) {
  const row = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  const initialPassword = String(process.env.INITIAL_ADMIN_PASSWORD || process.env.ADMIN_INITIAL_PASSWORD || '');
  const allowInsecureDefaults = envFlag('ALLOW_INSECURE_DEFAULT_USERS');
  const productionSsoOnly = process.env.NODE_ENV === 'production' && (envFlag('SSO_ENABLED') || envFlag('SKYLINE_SSO_ENABLED'));
  if (Number(row.count || 0) === 0) {
    if (productionSsoOnly) {
      console.log('[auth] local password users table is empty; production uses SSO only');
    } else if (initialPassword.length >= 12) {
      createLocalUser(db, {
        username: 'admin',
        password: initialPassword,
        role: 'admin',
        displayName: '工作台管理员',
      });
      console.log('[auth] created initial admin user from INITIAL_ADMIN_PASSWORD');
    } else if (allowInsecureDefaults) {
      createLocalUser(db, {
        username: 'admin',
        password: 'admin123',
        role: 'admin',
        displayName: '工作台管理员',
      });
      console.warn('[auth] created insecure default admin user because ALLOW_INSECURE_DEFAULT_USERS is enabled');
    } else {
      console.warn('[auth] users table is empty; set INITIAL_ADMIN_PASSWORD to enable local fallback login');
    }
  }

  const identities = [
    '1469',
    ...splitList(process.env.SSO_BOOTSTRAP_ADMINS || process.env.SSO_ADMIN_USERS || process.env.WORKBENCH_SUPER_ADMINS),
  ];
  const insertAdmin = db.prepare(`
    INSERT INTO sso_admins (identity, display_name, note, created_by)
    VALUES (?, ?, 'bootstrap', 'system')
    ON CONFLICT(identity) DO NOTHING
  `);
  [...new Set(identities.filter(Boolean))].forEach((identity) => insertAdmin.run(identity, identity));
}

function createLocalUser(db, { username, password, role = 'viewer', displayName = '' }) {
  const normalized = String(username || '').trim();
  if (!normalized) throw new Error('username is required');
  if (!String(password || '')) throw new Error('password is required');
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, role, display_name)
    VALUES (?, ?, ?, ?)
  `).run(normalized, hashPassword(password), normalizeRole(role), displayName || normalized);
  return result.lastInsertRowid;
}

function listLocalUsers(db) {
  return db.prepare(`
    SELECT id, username, role, display_name, status, created_at, updated_at, last_login
    FROM users
    ORDER BY id ASC
  `).all().map(mapPublicUser);
}

function getLocalUserById(db, id) {
  const row = db.prepare(`
    SELECT id, username, role, display_name, status, created_at, updated_at, last_login
    FROM users
    WHERE id = ?
  `).get(Number(id));
  return mapPublicUser(row);
}

function updateLocalUser(db, id, patch = {}) {
  const userId = Number(id);
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('invalid user id');
  const existing = getLocalUserById(db, userId);
  if (!existing) throw new Error(`user not found: ${userId}`);
  const displayName = String(patch.display_name ?? patch.displayName ?? existing.display_name ?? existing.username).trim();
  const role = normalizeRole(patch.role ?? existing.role);
  const status = normalizeStatus(patch.status ?? existing.status);
  db.prepare(`
    UPDATE users
    SET display_name = ?, role = ?, status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(displayName || existing.username, role, status, userId);
  if (patch.password) setLocalUserPassword(db, userId, patch.password);
  return getLocalUserById(db, userId);
}

function setLocalUserPassword(db, id, password) {
  const userId = Number(id);
  const nextPassword = String(password || '');
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('invalid user id');
  if (nextPassword.length < 8) throw new Error('password must be at least 8 characters');
  const result = db.prepare(`
    UPDATE users
    SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(hashPassword(nextPassword), userId);
  if (!result.changes) throw new Error(`user not found: ${userId}`);
}

function findUserByUsername(db, username) {
  return db.prepare(`
    SELECT *
    FROM users
    WHERE username = ?
      AND status = 'active'
  `).get(String(username || '').trim());
}

function verifyLocalUser(db, username, password) {
  const user = findUserByUsername(db, username);
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  db.prepare("UPDATE users SET last_login = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(user.id);
  return mapAuthUser(user);
}

function listSsoAdmins(db) {
  return db.prepare(`
    SELECT identity
    FROM sso_admins
    ORDER BY identity ASC
  `).all().map((row) => String(row.identity || '').trim()).filter(Boolean);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = crypto.scryptSync(String(password), salt, 32).toString('base64url');
  return `scrypt$${salt}$${key}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'base64url');
  const actual = crypto.scryptSync(String(password || ''), parts[1], expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function mapAuthUser(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    username: row.username,
    display_name: row.display_name || row.username,
    role: normalizeRole(row.role),
  };
}

function mapPublicUser(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    username: row.username,
    display_name: row.display_name || row.username,
    role: normalizeRole(row.role),
    status: normalizeStatus(row.status),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login: row.last_login,
  };
}

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (['admin', 'administrator', 'owner', 'super_admin'].includes(value)) return 'admin';
  if (['viewer', 'view', 'readonly', 'read_only', 'user'].includes(value)) return 'viewer';
  return value || 'viewer';
}

function normalizeStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (['active', 'disabled'].includes(value)) return value;
  return 'active';
}

function envFlag(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

module.exports = {
  DEFAULT_AUTH_DB_PATH,
  createAuthSession,
  createLocalUser,
  findUserByUsername,
  getLocalUserById,
  listLocalUsers,
  listSsoAdmins,
  mapAuthUser,
  openAuthDb,
  purgeExpiredAuthSessions,
  resolveAuthSession,
  revokeAuthSession,
  setLocalUserPassword,
  updateLocalUser,
  validateSessionCsrf,
  verifyLocalUser,
};
