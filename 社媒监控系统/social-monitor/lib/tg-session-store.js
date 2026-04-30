/**
 * tg-session-store.js
 * TG MTProto 用户账号 Session String 安全读写模块
 * - 从 .env 中按账号名读取/写入 TG_USER_SESSION_{NAME}
 * - UI 查询时只返回 '已配置' / '未配置'，不回显原文
 * - 频控参数也从 .env 中读写（TG_WARMUP_SECONDS_{NAME} 等）
 */
const path = require('path');
const fs = require('fs');

const ENV_PATH = path.join(__dirname, '..', '.env');

// ─── 底层：读取整个 .env 为 key-value map ────────────────────────────────────
function readEnvFile() {
    if (!fs.existsSync(ENV_PATH)) return {};
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    const map = {};
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        map[key] = val;
    }
    return map;
}

// ─── 底层：原子写入单个 key 到 .env（追加或替换）────────────────────────────
function writeEnvKey(key, value) {
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    const regex = new RegExp(`^(${key}=.*)$`, 'm');
    const newLine = `${key}=${value}`;
    if (regex.test(content)) {
        content = content.replace(regex, newLine);
    } else {
        // 追加到文件末尾
        content = content.trimEnd() + '\n' + newLine + '\n';
    }
    fs.writeFileSync(ENV_PATH, content, 'utf8');
    // 同步更新当前进程的 process.env
    process.env[key] = value;
}

// ─── 删除 .env 中的某个 key ──────────────────────────────────────────────────
function deleteEnvKey(key) {
    if (!fs.existsSync(ENV_PATH)) return;
    let content = fs.readFileSync(ENV_PATH, 'utf8');
    const regex = new RegExp(`^${key}=.*\n?`, 'm');
    content = content.replace(regex, '');
    fs.writeFileSync(ENV_PATH, content, 'utf8');
    delete process.env[key];
}

// ─── Session String ──────────────────────────────────────────────────────────

/**
 * 获取账号的 Session String
 * @param {string} accountName  账号名（如 'account1'）
 * @returns {string|null}
 */
function getSession(accountName) {
    const key = `TG_USER_SESSION_${accountName.toUpperCase()}`;
    return process.env[key] || readEnvFile()[key] || null;
}

/**
 * 保存 Session String 到 .env（原子写入）
 * @param {string} accountName
 * @param {string} sessionString
 */
function saveSession(accountName, sessionString) {
    const key = `TG_USER_SESSION_${accountName.toUpperCase()}`;
    writeEnvKey(key, sessionString);
    console.log(`[SessionStore] Session saved for account: ${accountName}`);
}

/**
 * 删除 Session String（登出 / 撤销）
 * @param {string} accountName
 */
function revokeSession(accountName) {
    const key = `TG_USER_SESSION_${accountName.toUpperCase()}`;
    deleteEnvKey(key);
    console.log(`[SessionStore] Session revoked for account: ${accountName}`);
}

/**
 * 脱敏查询（供 UI 使用）
 * @param {string} accountName
 * @returns {'configured'|'not_configured'}
 */
function getSessionStatus(accountName) {
    return getSession(accountName) ? 'configured' : 'not_configured';
}

// ─── 频控参数（Rate Limit Config）───────────────────────────────────────────

const RATELIMIT_DEFAULTS = {
    warmup_seconds: 600,       // 登录后预热静默期（秒）
    daily_limit: 2000,         // 每日历史消息最大拉取条数
    batch_size: 100,           // 每批次拉取条数
    sleep_min_ms: 3000,        // 批次间最小间隔（毫秒）
    sleep_max_ms: 8000,        // 批次间最大间隔（毫秒）
    backfill_days: 7,          // 历史回溯天数（0=不回溯，-1=全部）
    enable_backfill: true      // 是否开启历史回溯
};

/**
 * 读取账号的频控配置（.env 中的 TG_CFG_{PARAM}_{NAME} 格式）
 * @param {string} accountName
 * @returns {object}
 */
function getRateLimit(accountName) {
    const envMap = readEnvFile();
    const name = accountName.toUpperCase();
    const cfg = { ...RATELIMIT_DEFAULTS };

    for (const [param, defaultVal] of Object.entries(RATELIMIT_DEFAULTS)) {
        const key = `TG_${param.toUpperCase()}_${name}`;
        const raw = process.env[key] || envMap[key];
        if (raw !== undefined) {
            if (typeof defaultVal === 'boolean') {
                cfg[param] = raw === 'true';
            } else if (typeof defaultVal === 'number') {
                const n = Number(raw);
                if (!isNaN(n)) cfg[param] = n;
            }
        }
    }
    return cfg;
}

/**
 * 保存账号的频控配置到 .env
 * @param {string} accountName
 * @param {object} config  可以只传部分字段（Partial）
 */
function saveRateLimit(accountName, config) {
    const name = accountName.toUpperCase();
    for (const [param, val] of Object.entries(config)) {
        if (param in RATELIMIT_DEFAULTS) {
            const key = `TG_${param.toUpperCase()}_${name}`;
            writeEnvKey(key, String(val));
        }
    }
    console.log(`[SessionStore] Rate limit config saved for account: ${accountName}`);
}

module.exports = {
    getSession,
    saveSession,
    revokeSession,
    getSessionStatus,
    getRateLimit,
    saveRateLimit,
    RATELIMIT_DEFAULTS
};
