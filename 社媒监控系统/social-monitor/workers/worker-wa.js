const vanillaPuppeteer = require('puppeteer');
const { PuppeteerExtra } = require('puppeteer-extra');
const puppeteer = new PuppeteerExtra(vanillaPuppeteer);
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Enable stealth plugin to hide headless browser footprints
puppeteer.use(StealthPlugin());

// Hijack standard puppeteer inside require cache so whatsapp-web.js uses our custom PuppeteerExtra instance
require.cache[require.resolve('puppeteer')] = {
    exports: puppeteer
};

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const { sendAccountAlert } = require('../lib/dingtalk');
const { getWaChromeLaunchConfig } = require('../lib/wa-chrome-runtime');
const { createCollectorClient } = require('../lib/collector-client');

// 区域映射配置
let regionMap = {};
try {
    const configPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'config', 'account-regions.json');
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.accounts.forEach(a => {
            regionMap[a.account] = a;
        });
    }
} catch (e) {
    console.error('[WhatsApp] Failed to load account-regions.json:', e.message);
}

const accountName = process.env.ACCOUNT_NAME || 'default';
const accountId = `wa-${accountName}`;
const collectorId = process.env.COLLECTOR_ID || `pm2:${accountName}`;
const runId = process.env.WA_RUN_ID || `${accountName}-${Date.now()}-${process.pid}`;
const runStartedAt = new Date().toISOString();
const collectorApiUrl = process.env.COLLECTOR_API_URL || '';
let db = null;
let saveMessage = null;
let updateAccountStatus = null;
let upsertCollectorHeartbeat = null;
let recordRuntimeEvent = null;
if (!collectorApiUrl) {
    ({
        db,
        saveMessage,
        updateAccountStatus,
        upsertCollectorHeartbeat,
        recordRuntimeEvent
    } = require('../db/database'));
}
const sessionPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `whatsapp-session-${accountName}`);
const chromiumDataDir = path.join(sessionPath, 'session');
const chromeRuntime = getWaChromeLaunchConfig(vanillaPuppeteer);
const AUTO_WIPE_SESSION_ON_AUTH_FAILURE = process.env.WA_AUTO_WIPE_SESSION_ON_AUTH_FAILURE === 'true';
const ORCHESTRATOR_MANAGED_INIT = process.env.WA_ORCHESTRATOR_MANAGED_INIT !== 'false';
const collectorClient = createCollectorClient({
    baseUrl: collectorApiUrl,
    token: process.env.COLLECTOR_TOKEN,
    logger: console
});
console.log(`[WA:${accountName}] Chrome runtime: version=${chromeRuntime.chromeVersion || 'unknown'}, ua=${chromeRuntime.userAgent}`);
if (collectorClient) {
    console.log(`[WA:${accountName}] Collector API enabled: ${collectorClient.baseUrl}`);
}

const runtimeState = {
    status: 'initializing',
    phase: 'booting',
    healthStatus: 'booting',
    lastError: null,
    lastReadyAt: null,
    lastMessageAt: null
};

function reportHeartbeat(patch = {}) {
    Object.assign(runtimeState, patch);
    const payload = {
        accountId,
        platform: 'whatsapp',
        collectorId,
        runId,
        pid: process.pid,
        status: runtimeState.status,
        phase: runtimeState.phase,
        healthStatus: runtimeState.healthStatus,
        chromeVersion: chromeRuntime.chromeVersion || 'unknown',
        lastError: runtimeState.lastError,
        lastReadyAt: runtimeState.lastReadyAt,
        lastMessageAt: runtimeState.lastMessageAt,
        startedAt: runStartedAt
    };

    if (collectorClient) {
        collectorClient.heartbeat(payload);
    } else {
        upsertCollectorHeartbeat(payload);
    }
}

function transitionRuntime(phase, status = runtimeState.status, message = null, severity = 'info', data = null) {
    reportHeartbeat({ phase, status, healthStatus: phase, lastError: severity === 'error' ? message : runtimeState.lastError });
    if (message) {
        const payload = {
            accountId,
            platform: 'whatsapp',
            source: 'worker',
            eventType: phase,
            severity,
            runId,
            message,
            data
        };
        if (collectorClient) {
            collectorClient.event(payload);
        } else {
            recordRuntimeEvent(payload);
        }
    }
}

function persistAccountStatus(status, pushname = null, qrCode = null, extra = {}) {
    const payload = {
        id: accountId,
        platform: 'whatsapp',
        status,
        pushname,
        qrCode,
        ...extra
    };

    if (collectorClient) {
        collectorClient.accountStatus(payload);
    } else if (updateAccountStatus) {
        updateAccountStatus(accountId, 'whatsapp', status, pushname, qrCode);
        if (extra.chromeVersion) {
            try {
                db.prepare(`
                    UPDATE accounts
                    SET chrome_version = ?, updated_at = datetime('now')
                    WHERE id = ?
                `).run(extra.chromeVersion, accountId);
            } catch (e) {
                console.error('[WA] Chrome version update error:', e.message);
            }
        }
    }
}

async function persistMessage(data) {
    if (collectorClient) {
        const ok = await collectorClient.message(data);
        return ok ? { changes: 1 } : null;
    }
    return saveMessage(data);
}

async function persistMedia({ media, messageId, ext }) {
    if (!media || !media.data) return null;

    if (collectorClient) {
        const result = await collectorClient.media({
            accountId,
            messageId,
            mimetype: media.mimetype || '',
            ext,
            data: media.data
        });
        return result?.success ? result.media_path : null;
    }

    const fileName = `wa_${messageId}_${Date.now()}.${ext}`;
    const absoluteMediaDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'media');
    const absoluteMediaPath = path.join(absoluteMediaDir, fileName);
    fs.writeFileSync(absoluteMediaPath, Buffer.from(media.data, 'base64'));
    return `media/${fileName}`;
}

transitionRuntime('booting', 'initializing', 'WA worker booting');
const heartbeatTimer = setInterval(() => reportHeartbeat(), 15000);
heartbeatTimer.unref();

function cleanupStaleBrowser() {
    const { execSync } = require('child_process');

    // 1. 从 SingletonLock 符号链接读取主进程 PID 并 kill
    const singletonLock = path.join(chromiumDataDir, 'SingletonLock');
    try {
        const target = fs.readlinkSync(singletonLock);
        const m = target.match(/-(\d+)$/);
        if (m) {
            try { process.kill(Number(m[1]), 'SIGKILL'); } catch (_) {}
            console.log(`[WA:${accountName}] SingletonLock PID ${m[1]} 已 SIGKILL`);
        }
    } catch (_) {}

    // 2. pgrep -f 搜索完整命令行（包含所有参数），避免 ps aux 截断长路径
    //    whatsapp-session-${accountName} 是纯 ASCII，精准匹配该账号的 Chrome 进程
    try {
        const myPid = process.pid;
        const pidsRaw = execSync(
            `pgrep -f "whatsapp-session-${accountName}" 2>/dev/null || true`,
            { encoding: 'utf8', timeout: 5000, shell: '/bin/bash' }
        ).trim();

        if (pidsRaw) {
            const pids = pidsRaw.split('\n')
                .map(p => parseInt(p.trim(), 10))
                .filter(p => !isNaN(p) && p !== myPid); // 排除自身进程

            if (pids.length > 0) {
                console.log(`[WA:${accountName}] pgrep 发现 ${pids.length} 个残留 Chrome 进程: ${pids.join(', ')}`);
                for (const pid of pids) {
                    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
                }
                // 等待进程完全退出
                try { execSync('sleep 2', { timeout: 4000 }); } catch (_) {}
            }
        }
    } catch (_) {}

    // 3. 兜底删除所有单例锁文件
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try { fs.unlinkSync(path.join(chromiumDataDir, f)); console.log(`[WA:${accountName}] 已删除: ${f}`); } catch (_) {}
    }
}

function hasAccountBrowserProcess() {
    const { execSync } = require('child_process');
    try {
        const pidsRaw = execSync(
            `pgrep -f "whatsapp-session-${accountName}" 2>/dev/null || true`,
            { encoding: 'utf8', timeout: 3000, shell: '/bin/bash' }
        ).trim();
        return pidsRaw.split('\n').some(pid => /^\d+$/.test(pid.trim()) && Number(pid.trim()) !== process.pid);
    } catch (_) {
        return false;
    }
}


cleanupStaleBrowser();
transitionRuntime('profile_cleanup', 'initializing', 'Chrome profile locks cleaned');

try {
    // Worker 重启后必须先进入 initializing；pushname 会保留，但 status 不能沿用旧 authenticated。
    persistAccountStatus('initializing', null, null, { chromeVersion: chromeRuntime.chromeVersion || 'unknown' });
} catch (e) {
    console.error('[WA] Status check error:', e.message);
}

// ─── WebVersion 缓存兜底 ────────────────────────────────────────
const CACHE_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.wwebjs_cache');
const CACHE_FILE = path.join(CACHE_DIR, 'wa-version.html');
const REMOTE_HTML_URL = 'https://raw.githubusercontent.com/pedroslopez/whatsapp-web.js/main/example.html';

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

async function tryUpdateCache() {
  if (process.env.WA_WEBVERSION_AUTO_UPDATE !== '1') return false;
  ensureCacheDir();

  try {
    const axios = require('axios');
    const res = await axios.get(REMOTE_HTML_URL, { timeout: 8000 });
    if (typeof res.data !== 'string' || !res.data.includes('<html')) return false;
    fs.writeFileSync(CACHE_FILE, res.data, 'utf8');
    console.log(`[WA] WebVersion cache updated: ${CACHE_FILE}`);
    return true;
  } catch (e) {
    console.warn('[WA] WebVersion cache update skipped:', e.message);
    return false;
  }
}

function getWebVersionConfig() {
  ensureCacheDir();

  if (fs.existsSync(CACHE_FILE)) {
    return { type: 'local', localPath: CACHE_FILE };
  }

  // 扫描缓存目录，选版本号最大的 HTML 文件（文件名含版本号，字典序最大 = 最新）
  try {
    const files = fs.readdirSync(CACHE_DIR)
      .filter(f => f.endsWith('.html') && f !== 'wa-version.html')
      .sort()
      .reverse(); // 降序，第一个是最新

    if (files.length > 0) {
      const latest = path.join(CACHE_DIR, files[0]);
      const stat = fs.statSync(latest);
      const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
      console.log(`[WA] 使用缓存版本: ${files[0]} (${ageHours.toFixed(1)}h 前)`);
      return { type: 'local', localPath: latest };
    }
  } catch (e) {
    console.warn('[WA] 扫描缓存目录失败:', e.message);
  }

  // 无本地缓存 → 让 whatsapp-web.js 自动从远程拉最新
  console.warn('[WA] 无本地缓存，使用远程版本自动选择');
  return { type: 'remote', remotePath: 'https://web.whatsapp.com' };
}


const client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath }),
    webVersionCache: getWebVersionConfig(),
    puppeteer: {
        puppeteer: puppeteer, // Pass stealth-enabled puppeteer-extra instance
        headless: true,
        protocolTimeout: Number(process.env.WA_PROTOCOL_TIMEOUT_MS || 600000), // 多账号冷启动时 WA Web 注入可能很慢

        args: chromeRuntime.args
    }
});

// 防抖计时器：避免网络闪断误报
let offlineTimer = null;
const OFFLINE_TIMEOUT_MS = 10 * 60 * 1000; // 10分钟防误报观察期
let isFirstInit = true; // 区分首次启动和中途被挤下线

function triggerOfflineAlert(reasonStr) {
    const accountKey = `wa-${accountName}`;
    const info = regionMap[accountKey] || { region: '未知区', platform: 'wa' };
    sendAccountAlert({
        platform: 'wa',
        accountId: accountKey,
        region: info.region,
        status: reasonStr.includes('Session') ? 'session_expired' : 'disconnected',
        detail: `持续 ${OFFLINE_TIMEOUT_MS / 60000} 分钟未恢复 (${reasonStr})，请检查节点并重新扫码或重启服务！`
    }).catch(err => console.error('[WA] 发送运维告警失败:', err.message));
}

const MAX_QR_TIME_MS = 30 * 60 * 1000; // 30 mins
let qrStartTime = null;

client.on('qr', (qr) => {
    if (!qrStartTime) qrStartTime = Date.now();
    clearInitStrikes();
    transitionRuntime('qr_required', 'qr', 'QR code required');
    
    if (Date.now() - qrStartTime > MAX_QR_TIME_MS) {
        console.log(`[WA] QR timeout after 30 mins. Stopping QR generation.`);
        persistAccountStatus('timeout');
        
        const accountKey = `wa-${accountName}`;
        const info = regionMap[accountKey] || { region: '未知区', platform: 'wa' };
        sendAccountAlert({
            platform: 'wa',
            accountId: accountKey,
            region: info.region,
            status: 'timeout',
            detail: `节点已超 30 分钟未扫码，已停止刷新。请在控制台点击「重新登录」获取新二维码。`
        }).catch(() => {});

        client.destroy();
        return;
    }

    console.log('\n📌 [WhatsApp] Please scan QR code to login:');
    qrcode.generate(qr, { small: true });
    persistAccountStatus('qr', null, qr);
    // QR 码已显示 = Chrome 已启动完毕，无需再占用初始化锁（扫码期间 CPU 空闲）
    releaseInitLock();
    
    // 如果不是首次启动，说明中途需要重新扫码（被挤下线或 Session 失效）
    if (!isFirstInit) {
        if (!offlineTimer) {
            console.log(`[WA] Session invalidated, starting ${OFFLINE_TIMEOUT_MS/60000}m alert timer...`);
            offlineTimer = setTimeout(() => triggerOfflineAlert('Session 失效，需重新扫码'), OFFLINE_TIMEOUT_MS);
        }
    }
});

client.on('authenticated', () => {
    console.log('✅ [WhatsApp] Authenticated successfully!');
    transitionRuntime('authenticated', 'authenticated', 'WA session authenticated');
    persistAccountStatus('authenticated', 'Loading...', null);
});

client.on('ready', () => {
    clearInitStrikes();
    isFirstInit = false; // 成功登录过一次
    runtimeState.lastReadyAt = new Date().toISOString();
    const pushname = client.info?.pushname || client.info?.wid?.user || accountName;
    console.log(`✅ [WhatsApp] Logged in as: ${pushname} and ready`);
    transitionRuntime('ready', 'authenticated', `WA ready as ${pushname}`);
    persistAccountStatus('authenticated', pushname, null);
    // 认证成功 = Chrome 已完全就绪，释放初始化锁
    releaseInitLock();

    // 成功连接，清除掉线计时器
    if (offlineTimer) {
        clearTimeout(offlineTimer);
        offlineTimer = null;
        console.log(`[WA] Reconnected successfully. Offline alert cancelled.`);
    }
});

client.on('disconnected', (reason) => {
    console.log('🔴 [WhatsApp] Client was logged out', reason);
    transitionRuntime('disconnected', 'disconnected', `Disconnected: ${reason}`, 'warn');
    persistAccountStatus('disconnected');

    // LOGOUT / Session invalidated → 清理本地 Session 数据，避免下次扫码被旧密钥污染
    if (reason === 'LOGOUT' || reason === 'CONFLICT') maybeWipeSessionAuth(`Session 失效(${reason})`);

    if (!offlineTimer) {
        console.log(`[WA] Disconnected, starting ${OFFLINE_TIMEOUT_MS/60000}m alert timer...`);
        offlineTimer = setTimeout(() => triggerOfflineAlert(`网络断开/退出: ${reason}`), OFFLINE_TIMEOUT_MS);
    }
});

client.on('auth_failure', (msg) => {
    console.error('🔴 [WhatsApp] Authentication failure', msg);
    transitionRuntime('auth_failure', 'disconnected', `Authentication failure: ${msg}`, 'error');
    persistAccountStatus('disconnected');

    maybeWipeSessionAuth(`认证失败: ${msg}`);

    if (!offlineTimer) {
        offlineTimer = setTimeout(() => triggerOfflineAlert(`认证失败/登出: ${msg}`), OFFLINE_TIMEOUT_MS);
    }
});

// 清理 LocalAuth 中的认证密钥（保留目录结构，只删 session 文件夹内容）
function wipeSessionAuth() {
    try {
        const authPath = path.join(sessionPath, 'session', 'Default', 'Local Storage', 'leveldb');
        const indexedDB = path.join(sessionPath, 'session', 'Default', 'IndexedDB');
        const { execSync } = require('child_process');
        // 删除 IndexedDB（WhatsApp 认证 Token 存储位置）
        if (fs.existsSync(indexedDB)) {
            execSync(`rm -rf "${indexedDB}"`, { timeout: 5000 });
            console.log(`[WA:${accountName}] 已清理 IndexedDB`);
        }
        // 删除 Local Storage
        if (fs.existsSync(authPath)) {
            execSync(`rm -rf "${authPath}"`, { timeout: 5000 });
            console.log(`[WA:${accountName}] 已清理 Local Storage/leveldb`);
        }
    } catch (e) {
        console.warn(`[WA:${accountName}] wipeSessionAuth 失败:`, e.message);
    }
}

function maybeWipeSessionAuth(reason) {
    if (!AUTO_WIPE_SESSION_ON_AUTH_FAILURE) {
        console.warn(`[WA:${accountName}] ${reason}，已保留 LocalAuth；如需重新扫码请在前端点击「重新登录」。`);
        return;
    }

    console.log(`[WA:${accountName}] ${reason}，按配置清理本地 LocalAuth 数据...`);
    wipeSessionAuth();
}


client.on('message_create', async (message) => {
    try {
        // 先跳过各种明显非正常的纯状态/系统类或无用协议类型的消息，保护后续调用
        if (!message || !message.from) return;
        const skipTypes = ['e2e_notification', 'protocol', 'gp2', 'notification_template', 'call_log', 'revoked', 'chat_event'];
        if (skipTypes.includes(message.type)) return;

        const chat = await message.getChat().catch(err => {
            console.error(`[WA] Failed to get chat for message ${message.id.id}:`, err.message);
            return null;
        });
        if (!chat || !chat.isGroup) return; // Only process group messages

        let contact;
        try {
            if (message.fromMe && client.info && client.info.wid) {
                contact = await client.getContactById(client.info.wid._serialized).catch(() => null);
            } else {
                contact = await message.getContact().catch(() => null);
            }
        } catch (contactErr) {
            console.error(`[WA] Error getting contact in ${chat.name || 'Unknown Group'}:`, contactErr.message);
        }

        // 如果是系统消息或获取不到，回退保护
        if (!contact || contact.isGroup) {
            console.log(`[WA] Skipped a group-level system event or unresolvable contact in ${chat.name}`);
            return;
        }

        const senderName = contact.pushname || contact.name || contact.number || 'Unknown';
        const groupName = chat.name;

        let mediaPath = null;
        let hasMedia = false;

        if (message.hasMedia) {
            hasMedia = true;
            try {
                const media = await message.downloadMedia();
                if (media && media.data) {
                    const extNames = {
                        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
                        'audio/ogg; codecs=opus': 'ogg', 'video/mp4': 'mp4'
                    };
                    const typePart = media.mimetype ? media.mimetype.split(';')[0] : '';
                    const ext = extNames[typePart] || 'bin';
                    mediaPath = await persistMedia({ media, messageId: message.id.id, ext });
                }
            } catch (err) {
                console.error('[WhatsApp] Failed to download media:', err.message);
            }
        }

        await persistMessage({
            platform: 'whatsapp',
            receiver_account: `wa-${accountName}`,
            message_id: message.id._serialized,
            group_id: chat.id._serialized,
            group_name: groupName,
            sender_id: contact.id._serialized,
            sender_name: senderName,
            content: message.body || '',
            has_media: hasMedia ? 1 : 0,
            media_path: mediaPath,
            timestamp: message.timestamp * 1000,
            // 只保存轻量元数据，不含 media base64，避免 DB 膨胀
            raw_data: JSON.stringify({
                id: message.id._serialized,
                type: message.type,
                fromMe: message.fromMe,
                hasMedia: message.hasMedia,
                timestamp: message.timestamp,
            })
        });
        runtimeState.lastMessageAt = new Date().toISOString();
        reportHeartbeat({ phase: 'ready', status: 'authenticated', healthStatus: 'ready' });

        console.log(`[WA] Saved group message from ${senderName} in group ${groupName}`);
    } catch (e) {
        console.error('[WhatsApp] Error processing message:', e.message);
    }
});

// ─── 全局串行初始化锁（替代错峰方案）──────────────────────────────────
// 确保同一时间只有一个 Chrome 在做初始化，彻底避免内存耗尽导致超时
// 锁文件存放在系统临时目录，所有 Worker 进程共享
const INIT_LOCK_FILE = '/tmp/wa_chrome_init.lock';
const INIT_LOCK_TIMEOUT = Number(process.env.WA_INIT_LOCK_TIMEOUT_MS || 6 * 60 * 1000); // 超时后视为死锁，强制抢锁
const INIT_COOLDOWN_FILE = path.join('/tmp', `wa_chrome_init_cooldown_${accountName}.json`);
const INIT_STRIKE_FILE = path.join('/tmp', `wa_chrome_init_strikes_${accountName}.json`);
const INIT_COOLDOWN_MS = Number(process.env.WA_INIT_COOLDOWN_MS || 60 * 1000);
const INIT_QUARANTINE_AFTER = Number(process.env.WA_INIT_QUARANTINE_AFTER || 2);
const INIT_QUARANTINE_MS = Number(process.env.WA_INIT_QUARANTINE_MS || 10 * 60 * 1000);
let activeInitWatchdog = null;

function getInitStrikeCount() {
    try {
        if (!fs.existsSync(INIT_STRIKE_FILE)) return 0;
        const state = JSON.parse(fs.readFileSync(INIT_STRIKE_FILE, 'utf8'));
        return Number(state.count || 0);
    } catch (_) {
        return 0;
    }
}

function recordInitStrike(reason) {
    const count = getInitStrikeCount() + 1;
    try {
        fs.writeFileSync(INIT_STRIKE_FILE, JSON.stringify({
            account: accountName,
            reason,
            count,
            ts: Date.now()
        }));
    } catch (_) {}
    return count;
}

function clearInitStrikes() {
    try { fs.unlinkSync(INIT_STRIKE_FILE); } catch (_) {}
}

function markInitCooldown(reason) {
    try {
        const strikes = recordInitStrike(reason);
        const cooldownMs = strikes >= INIT_QUARANTINE_AFTER ? INIT_QUARANTINE_MS : INIT_COOLDOWN_MS;
        fs.writeFileSync(INIT_COOLDOWN_FILE, JSON.stringify({
            account: accountName,
            reason,
            strikes,
            ts: Date.now(),
            cooldownMs
        }));
        console.warn(`[WA:${accountName}] 初始化冷却 ${Math.round(cooldownMs / 1000)}s: ${reason}, strikes=${strikes}`);
    } catch (e) {
        console.warn(`[WA:${accountName}] 写入初始化冷却失败: ${e.message}`);
    }
}

function getInitCooldownRemainingMs() {
    try {
        if (!fs.existsSync(INIT_COOLDOWN_FILE)) return 0;
        const cooldown = JSON.parse(fs.readFileSync(INIT_COOLDOWN_FILE, 'utf8'));
        const remaining = Number(cooldown.cooldownMs || INIT_COOLDOWN_MS) - (Date.now() - Number(cooldown.ts || 0));
        if (remaining > 0) return remaining;
        fs.unlinkSync(INIT_COOLDOWN_FILE);
    } catch (_) {
        try { fs.unlinkSync(INIT_COOLDOWN_FILE); } catch (_) {}
    }
    return 0;
}

async function acquireInitLock() {
    while (true) {
        const cooldownRemainingMs = getInitCooldownRemainingMs();
        if (cooldownRemainingMs > 0) {
            reportHeartbeat({ phase: 'cooling_down', status: 'initializing', healthStatus: 'cooling_down' });
            console.log(`[WA:${accountName}] 初始化冷却中，${Math.ceil(cooldownRemainingMs / 1000)}s 后重新竞争锁`);
            await new Promise(r => setTimeout(r, Math.min(cooldownRemainingMs, 30000)));
            continue;
        }

        try {
            // 原子操作：O_CREAT|O_EXCL（wx）保证只有一个进程能成功创建文件
            // 其他进程同时尝试时会收到 EEXIST 错误，而非都以为自己持有锁
            const fd = fs.openSync(INIT_LOCK_FILE, 'wx');
            fs.writeSync(fd, JSON.stringify({ holder: accountName, ts: Date.now() }));
            fs.closeSync(fd);
            console.log(`[WA:${accountName}] ✅ 获取初始化锁（原子）`);
            transitionRuntime('init_lock_acquired', 'initializing', 'Initialization lock acquired');
            return;
        } catch (e) {
            if (e.code === 'EEXIST') {
                // 锁已被其他进程持有，检查是否超时
                try {
                    const lock = JSON.parse(fs.readFileSync(INIT_LOCK_FILE, 'utf8'));
                    const age = Date.now() - lock.ts;
                    if (lock.holder === accountName && age > INIT_NO_BROWSER_TIMEOUT) {
                        if (!hasAccountBrowserProcess()) {
                            console.warn(`[WA:${accountName}] 发现本账号遗留初始化锁且无 Chrome (${Math.round(age/1000)}s)，删除后重新竞争`);
                            try { fs.unlinkSync(INIT_LOCK_FILE); } catch (_) {}
                            await new Promise(r => setTimeout(r, 1000));
                            continue;
                        }
                        console.log(`[WA:${accountName}] 本账号仍在初始化且 Chrome 存活，继续等待锁 (${Math.round(age/1000)}s)...`);
                    }
                    if (age < INIT_LOCK_TIMEOUT) {
                        reportHeartbeat({ phase: 'queued', status: 'initializing', healthStatus: 'queued' });
                        console.log(`[WA:${accountName}] 等待初始化锁 (持有者: ${lock.holder}, 已持有 ${Math.round(age/1000)}s)...`);
                        await new Promise(r => setTimeout(r, 15000));
                        continue;
                    }
                    // 锁超时（持有者进程已崩溃），强制删除后重试
                    console.warn(`[WA:${accountName}] 锁超时 (${lock.holder} 持有 ${Math.round(age/60000)}min)，强制接管`);
                    try { fs.unlinkSync(INIT_LOCK_FILE); } catch (_) {}
                } catch (_) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            } else {
                // 其他文件系统错误，等待后重试
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }
}


function releaseInitLock() {
    if (activeInitWatchdog) {
        clearTimeout(activeInitWatchdog);
        activeInitWatchdog = null;
    }

    try {
        if (fs.existsSync(INIT_LOCK_FILE)) {
            const lock = JSON.parse(fs.readFileSync(INIT_LOCK_FILE, 'utf8'));
            if (lock.holder === accountName) {
                fs.unlinkSync(INIT_LOCK_FILE);
                console.log(`[WA:${accountName}] 🔓 释放初始化锁`);
            }
        }
    } catch (e) {}
}

console.log(`[WA] Initializing client for ${accountName}...`);

// ─── 带全局锁的重试初始化 ────────────────────────────────────────────
const INIT_MAX_RETRIES = Number(process.env.WA_INIT_MAX_RETRIES || 2);
const INIT_RETRY_DELAYS = (process.env.WA_INIT_RETRY_DELAYS_MS || '15000,30000')
    .split(',')
    .map(v => Number(v.trim()))
    .filter(v => Number.isFinite(v) && v > 0);
const INIT_NO_BROWSER_TIMEOUT = Number(process.env.WA_INIT_NO_BROWSER_TIMEOUT_MS || 60 * 1000);
const INIT_HARD_TIMEOUT = Number(process.env.WA_INIT_HARD_TIMEOUT_MS || 300 * 1000);
let initTerminalFailure = false;
let parkedAfterInitFailure = false;

function parkAfterInitFailure(phase, message, cooldownReason, updateMessage, shouldCleanupChrome = true) {
    if (parkedAfterInitFailure) return;
    initTerminalFailure = true;
    parkedAfterInitFailure = true;
    transitionRuntime(phase, 'disconnected', message, 'error');
    persistAccountStatus('disconnected', updateMessage);
    markInitCooldown(cooldownReason);
    if (shouldCleanupChrome) cleanupStaleBrowser();
    releaseInitLock();

    if (!ORCHESTRATOR_MANAGED_INIT) {
        process.exit(1);
    }

    try {
        client.destroy();
    } catch (_) {}

    reportHeartbeat({ phase, status: 'disconnected', healthStatus: phase, lastError: message });
    console.warn(`[WA:${accountName}] 初始化失败后进入驻留模式，等待 orchestrator 冷却后统一重启`);
}

async function initializeWithRetry(attempt = 1) {
    // 每次尝试前都重新获取全局锁（确保串行初始化）
    // 重试期间锁会被释放，让其他账号有机会初始化，避免单账号独占锁
    await acquireInitLock();

    let noBrowserWatchdog = null;
    try {
        activeInitWatchdog = setTimeout(() => {
            console.error(`🔴 [WA:${accountName}] 初始化超过 ${INIT_HARD_TIMEOUT / 1000}s 仍未 ready/qr，清理 Chrome 并释放锁`);
            parkAfterInitFailure(
                'init_timeout',
                `Initialization exceeded ${INIT_HARD_TIMEOUT / 1000}s`,
                'hard_timeout',
                '初始化超时，等待调度中心恢复'
            );
        }, INIT_HARD_TIMEOUT);
        activeInitWatchdog.unref();

        noBrowserWatchdog = setTimeout(() => {
            if (hasAccountBrowserProcess()) return;

            console.error(`🔴 [WA:${accountName}] 初始化持锁 ${INIT_NO_BROWSER_TIMEOUT / 1000}s 但未发现 Chrome 子进程，释放锁并退出等待 PM2 重启`);
            parkAfterInitFailure(
                'no_browser_timeout',
                `No Chrome process after ${INIT_NO_BROWSER_TIMEOUT / 1000}s`,
                'no_browser_timeout',
                '初始化卡住：未发现 Chrome 子进程',
                false
            );
        }, INIT_NO_BROWSER_TIMEOUT);
        noBrowserWatchdog.unref();

        transitionRuntime('wa_injecting', 'initializing', 'Starting WhatsApp Web injection');
        await client.initialize();
        if (initTerminalFailure) return;
        if (noBrowserWatchdog) clearTimeout(noBrowserWatchdog);
        // 注意：initialize() 在 whatsapp-web.js 中是长期挂起的 Promise
        // 锁的释放已移到 'ready' 和 'qr' 事件中
    } catch (err) {
        if (noBrowserWatchdog) clearTimeout(noBrowserWatchdog);
        if (initTerminalFailure) return;
        const msg = err.message || '';
        const isTransient =
            msg.includes('Execution context was destroyed') ||
            msg.includes('Protocol error') ||
            msg.includes('Target closed') ||
            msg.includes('Session closed') ||
            msg.includes('Navigation failed') ||
            msg.includes('timed out') ||
            msg.includes('callFunctionOn') ||
            msg.includes('browser is already running');

        if (!ORCHESTRATOR_MANAGED_INIT && isTransient && attempt <= INIT_MAX_RETRIES) {
            const delay = INIT_RETRY_DELAYS[attempt - 1] || 60000;
            console.warn(`⚠️ [WA:${accountName}] 初始化失败(第${attempt}次): ${msg.split('\n')[0]}`);
            console.warn(`⏳ [WA:${accountName}] ${delay / 1000}s 后重试... (${attempt}/${INIT_MAX_RETRIES})`);
            transitionRuntime('init_retry', 'initializing', `Initialization retry ${attempt}: ${msg.split('\n')[0]}`, 'warn', { attempt, delay });
            cleanupStaleBrowser();
            // ⬇ 先释放锁，让其他账号在等待期间有机会初始化
            releaseInitLock();
            await new Promise(resolve => setTimeout(resolve, delay));
            return initializeWithRetry(attempt + 1); // 重新竞争锁
        }

        // 所有重试耗尽或非瞬时错误 → 释放锁让下一个账号尝试
        releaseInitLock();
        console.error(`🔴 [WA:${accountName}] 初始化最终失败(已重试${attempt - 1}次):`, msg.split('\n')[0]);
        parkAfterInitFailure(
            'init_failed',
            `Initialization failed: ${msg.split('\n')[0]}`,
            'init_failed',
            `初始化失败: ${msg.split('\n')[0]}`
        );
    }
}


initializeWithRetry();

// ─── 优雅关闭：收到 SIGTERM 时立即杀掉 Chrome，防止孤儿进程导致内存爆炸 ────
// PM2 stop/restart 发 SIGTERM → 我们在此立即清理 Chrome → process.exit(0)
// 必须在 kill_timeout(12s) 内完成，pgrep kill 约 200ms，绰绰有余
process.on('SIGTERM', async () => {
    const { execSync } = require('child_process');
    console.log(`[WA:${accountName}] 收到 SIGTERM，立即清理 Chrome 进程...`);
    transitionRuntime('stopping', 'disconnected', 'Worker received SIGTERM', 'warn');
    try {
        // 立即杀掉该账号所有 Chrome 进程（包括 renderer/gpu/utility 子进程）
        execSync(
            `pgrep -f "whatsapp-session-${accountName}" 2>/dev/null | xargs kill -9 2>/dev/null || true`,
            { shell: '/bin/bash', timeout: 3000 }
        );
        console.log(`[WA:${accountName}] Chrome 进程已清理`);
    } catch (e) {}
    // 释放初始化锁，防止其他账号永久等待
    releaseInitLock();
    clearInterval(heartbeatTimer);
    process.exit(0);
});
