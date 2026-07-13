const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOGIN_MODES = new Set(['wa_qr', 'tg_bot_token', 'tg_user_phone', 'tg_user_session']);
const LOGIN_STATUSES = new Set([
  'requested',
  'waiting_qr',
  'waiting_verification',
  'waiting_code',
  'waiting_password',
  'authenticated',
  'failed',
  'expired',
  'canceled',
]);
const ACTIVE_LOGIN_STATUSES = [
  'requested',
  'waiting_qr',
  'waiting_verification',
  'waiting_code',
  'waiting_password',
];

const LOCAL_TEST_ACCOUNTS = new Set([
  'wa:wa-login-test',
  'tg:tg-user-login',
  'tg:tg-phone-login',
]);

function localTestAccountsBlocked() {
  const configured = String(process.env.WORKBENCH_BLOCK_TEST_ACCOUNTS || '').trim().toLowerCase();
  if (configured) return ['1', 'true', 'yes', 'on'].includes(configured);
  return ['3310', '3311'].includes(String(process.env.WORKBENCH_PORT || '')) && process.env.NODE_ENV !== 'production';
}

function isLocalTestAccount(platform, account) {
  return localTestAccountsBlocked() && LOCAL_TEST_ACCOUNTS.has(`${normalizeLoginPlatform(platform)}:${String(account || '').trim()}`);
}

function purgeLocalTestLoginRequests(runtimeDb) {
  if (!runtimeDb || !localTestAccountsBlocked()) return 0;
  const result = runtimeDb.prepare(`
    DELETE FROM service_account_login_requests
    WHERE (platform = 'wa' AND account = 'wa-login-test')
       OR (platform = 'tg' AND account IN ('tg-user-login', 'tg-phone-login'))
  `).run();
  return result.changes || 0;
}

function sanitizeSegment(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function loginRequestDir(outboxDir, platform, account) {
  return path.join(outboxDir, `login-worker-${platform}-${sanitizeSegment(account)}`);
}

function normalizeLoginPlatform(platform) {
  const value = String(platform || '').trim().toLowerCase();
  if (value === 'whatsapp') return 'wa';
  if (value === 'telegram' || value === 'telegram-user' || value === 'tg-user') return 'tg';
  return value;
}

function normalizeLoginMode(platform, mode) {
  const normalizedPlatform = normalizeLoginPlatform(platform);
  const value = String(mode || '').trim().toLowerCase();
  if (!value && normalizedPlatform === 'wa') return 'wa_qr';
  if (!value && normalizedPlatform === 'tg') return 'tg_bot_token';
  if (!LOGIN_MODES.has(value)) throw new Error('login_mode must be wa_qr, tg_bot_token, tg_user_phone or tg_user_session');
  if (normalizedPlatform === 'wa' && value !== 'wa_qr') throw new Error('WA only supports wa_qr login mode');
  if (normalizedPlatform === 'tg' && value === 'wa_qr') throw new Error('TG login mode must be tg_bot_token, tg_user_phone or tg_user_session');
  return value;
}

function createServiceAccountLoginRequest({
  runtimeDb,
  outboxDir,
  platform,
  account,
  displayName,
  loginMode,
  credential,
  tgApiId,
  tgApiHash,
  tgPhoneNumber,
  requestedBy = 'system',
  ttlMinutes = 30,
} = {}) {
  if (!runtimeDb) throw new Error('runtimeDb is required');
  if (!outboxDir) throw new Error('outboxDir is required');
  const normalizedPlatform = normalizeLoginPlatform(platform);
  if (!['wa', 'tg'].includes(normalizedPlatform)) throw new Error('platform must be one of wa, tg');
  const normalizedAccount = String(account || '').trim();
  if (!normalizedAccount) throw new Error('account is required');
  if (normalizedAccount.length > 96) throw new Error('account is too long');
  if (isLocalTestAccount(normalizedPlatform, normalizedAccount)) {
    throw new Error('local test service accounts are disabled');
  }
  const mode = normalizeLoginMode(normalizedPlatform, loginMode);
  const secret = String(credential || '').trim();
  if ((mode === 'tg_bot_token' || mode === 'tg_user_session') && !secret) {
    throw new Error('credential is required for this login mode');
  }
  const credentialPayload = buildCredentialPayload(mode, secret, { tgApiId, tgApiHash, tgPhoneNumber });

  const now = new Date();
  const requestId = `${normalizedPlatform}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const expiresAt = new Date(now.getTime() + Math.max(5, Number(ttlMinutes) || 30) * 60 * 1000).toISOString();
  const credentialHint = maskCredential(mode, secret, credentialPayload);
  const row = {
    request_id: requestId,
    platform: normalizedPlatform,
    account: normalizedAccount,
    display_name: String(displayName || '').trim() || normalizedAccount,
    login_mode: mode,
    status: mode === 'wa_qr' ? 'waiting_qr' : 'requested',
    requested_by: String(requestedBy || 'system'),
    credential_hint: credentialHint,
    expires_at: expiresAt,
  };

  runtimeDb.prepare(`
    INSERT INTO service_account_login_requests (
      request_id, platform, account, display_name, login_mode, status,
      requested_by, credential_hint, expires_at
    )
    VALUES (
      @request_id, @platform, @account, @display_name, @login_mode, @status,
      @requested_by, @credential_hint, @expires_at
    )
  `).run(row);
  cancelSupersededLoginRequests(runtimeDb, row);

  writeLoginDoorbell(outboxDir, {
    request_id: requestId,
    platform: normalizedPlatform,
    account: normalizedAccount,
    display_name: row.display_name,
    login_mode: mode,
    requested_by: row.requested_by,
    requested_at: now.toISOString(),
    expires_at: expiresAt,
    credential: credentialPayload,
  });

  return getServiceAccountLoginRequest(runtimeDb, requestId);
}

function cancelSupersededLoginRequests(runtimeDb, request, options = {}) {
  if (!runtimeDb || !request?.request_id) return 0;
  const statusPlaceholders = ACTIVE_LOGIN_STATUSES.map((_, index) => `@status${index}`).join(', ');
  const params = {
    request_id: request.request_id,
    platform: request.platform,
    account: request.account,
    now: new Date().toISOString(),
    worker_message: options.workerMessage || '已被新的登录任务取代',
  };
  ACTIVE_LOGIN_STATUSES.forEach((status, index) => {
    params[`status${index}`] = status;
  });
  const result = runtimeDb.prepare(`
    UPDATE service_account_login_requests
    SET status = 'canceled',
        qr_payload = '',
        worker_message = @worker_message,
        error_message = '',
        completed_at = @now,
        updated_at = CURRENT_TIMESTAMP
    WHERE platform = @platform
      AND account = @account
      AND request_id <> @request_id
      AND status IN (${statusPlaceholders})
  `).run(params);
  return result.changes || 0;
}

function buildCredentialPayload(mode, secret, { tgApiId, tgApiHash, tgPhoneNumber } = {}) {
  if (mode === 'wa_qr') return null;
  if (mode === 'tg_bot_token') return secret ? { mode, value: secret } : null;
  if (mode === 'tg_user_session' && !secret) return null;

  const apiId = Number(tgApiId);
  const apiHash = String(tgApiHash || '').trim();
  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new Error('TG user session login requires a valid api_id');
  }
  if (!apiHash) {
    throw new Error('TG user session login requires app api_hash');
  }
  if (apiHash.length > 128) {
    throw new Error('TG app api_hash is too long');
  }
  if (mode === 'tg_user_session') {
    return {
      mode,
      value: secret,
      api_id: apiId,
      api_hash: apiHash,
    };
  }

  const phoneNumber = normalizePhoneNumber(tgPhoneNumber);
  if (!phoneNumber) {
    throw new Error('TG user phone login requires phone number');
  }
  return {
    mode,
    phase: 'start',
    api_id: apiId,
    api_hash: apiHash,
    phone_number: phoneNumber,
  };
}

function writeLoginVerificationDoorbell(outboxDir, request, { code, password, requestedBy = 'system' } = {}) {
  if (!request) throw new Error('request is required');
  return writeLoginDoorbell(outboxDir, {
    request_id: request.request_id,
    platform: request.platform,
    account: request.account,
    display_name: request.display_name,
    login_mode: request.login_mode,
    requested_by: String(requestedBy || 'system'),
    requested_at: new Date().toISOString(),
    action: 'verify',
    credential: {
      mode: request.login_mode,
      phase: 'verify',
      code: String(code || '').trim(),
      password: String(password || ''),
    },
  });
}

function writeLoginDoorbell(outboxDir, payload) {
  const dir = loginRequestDir(outboxDir, payload.platform, payload.account);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${Date.now()}-${payload.request_id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    kind: 'service-account-login',
    version: 1,
    ...payload,
  }, null, 2), { mode: 0o600 });
  return filePath;
}

function listServiceAccountLoginRequests(runtimeDb, { limit = 30 } = {}) {
  purgeLocalTestLoginRequests(runtimeDb);
  const rows = runtimeDb.prepare(`
    SELECT *
    FROM service_account_login_requests
    ORDER BY created_at DESC, request_id DESC
    LIMIT @limit
  `).all({
    limit: Math.max(1, Math.min(Number(limit) || 30, 100)),
  });
  return rows.map(mapLoginRequestRow);
}

function getServiceAccountLoginRequest(runtimeDb, requestId) {
  const row = runtimeDb.prepare(`
    SELECT *
    FROM service_account_login_requests
    WHERE request_id = ?
  `).get(requestId);
  return row ? mapLoginRequestRow(row) : null;
}

function updateServiceAccountLoginRequest(runtimeDb, requestId, patch = {}) {
  const status = String(patch.status || '').trim();
  if (status && !LOGIN_STATUSES.has(status)) throw new Error('invalid login request status');
  const current = getServiceAccountLoginRequest(runtimeDb, requestId);
  if (!current) return null;
  const next = {
    request_id: requestId,
    status: status || current.status,
    qr_payload: patch.qr_payload === undefined ? current.qr_payload : String(patch.qr_payload || ''),
    worker_message: patch.worker_message === undefined ? current.worker_message : String(patch.worker_message || ''),
    error_message: patch.error_message === undefined ? current.error_message : String(patch.error_message || ''),
    completed_at: ['authenticated', 'failed', 'expired', 'canceled'].includes(status)
      ? new Date().toISOString()
      : current.completed_at,
  };
  runtimeDb.prepare(`
    UPDATE service_account_login_requests
    SET status = @status,
        qr_payload = @qr_payload,
        worker_message = @worker_message,
        error_message = @error_message,
        completed_at = @completed_at,
        updated_at = CURRENT_TIMESTAMP
    WHERE request_id = @request_id
  `).run(next);
  return getServiceAccountLoginRequest(runtimeDb, requestId);
}

function deleteServiceAccountLoginRequest(runtimeDb, requestId, { outboxDir } = {}) {
  if (!runtimeDb) throw new Error('runtimeDb is required');
  const current = getServiceAccountLoginRequest(runtimeDb, requestId);
  if (!current) return null;

  const deletedDoorbells = outboxDir ? deletePendingDoorbells(outboxDir, current) : 0;
  runtimeDb.prepare(`
    DELETE FROM service_account_login_requests
    WHERE request_id = ?
  `).run(requestId);

  return {
    ...current,
    deleted_doorbells: deletedDoorbells,
  };
}

function deletePendingDoorbells(outboxDir, request) {
  const dir = loginRequestDir(outboxDir, request.platform, request.account);
  if (!fs.existsSync(dir)) return 0;

  let deleted = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || !entry.name.includes(request.request_id)) continue;
    try {
      fs.unlinkSync(path.join(dir, entry.name));
      deleted += 1;
    } catch (_) {}
  }
  return deleted;
}

function mapLoginRequestRow(row) {
  return {
    request_id: row.request_id,
    platform: row.platform,
    account: row.account,
    display_name: row.display_name,
    login_mode: row.login_mode,
    status: row.status,
    requested_by: row.requested_by,
    credential_hint: row.credential_hint,
    qr_payload: row.qr_payload,
    worker_message: row.worker_message,
    error_message: row.error_message,
    expires_at: row.expires_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function maskCredential(mode, value, payload = null) {
  const secret = String(value || '').trim();
  if (!secret && mode !== 'tg_user_phone') return '';
  if (mode === 'tg_bot_token') {
    const [prefix] = secret.split(':');
    return prefix ? `${prefix}:***` : '***';
  }
  if (mode === 'tg_user_phone' && payload?.api_id) {
    return `api_id ${payload.api_id} · phone ${maskPhoneNumber(payload.phone_number)}`;
  }
  if (mode === 'tg_user_session' && payload?.api_id) {
    return `api_id ${payload.api_id} · session ${secret.slice(0, 4)}***${secret.slice(-4)}`;
  }
  return `${secret.slice(0, 4)}***${secret.slice(-4)}`;
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

module.exports = {
  ACTIVE_LOGIN_STATUSES,
  cancelSupersededLoginRequests,
  createServiceAccountLoginRequest,
  deleteServiceAccountLoginRequest,
  getServiceAccountLoginRequest,
  isLocalTestAccount,
  listServiceAccountLoginRequests,
  localTestAccountsBlocked,
  loginRequestDir,
  normalizeLoginMode,
  normalizeLoginPlatform,
  purgeLocalTestLoginRequests,
  updateServiceAccountLoginRequest,
  writeLoginDoorbell,
  writeLoginVerificationDoorbell,
};
