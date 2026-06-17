/**
* worker-tg-user.js
* Telegram MTProto 用户账号采集进程（Phase 1）
*
* 运行逻辑：
* 1. 读取 Session String（从 .env TG_USER_SESSION_{NAME}）
* 2. 若无 Session → 进入 idle 等待状态（由 server.js /api/tg-user/login 系列 API 驱动登录）
* 3. 登录成功 → 进入预热静默期（warmup_seconds，默认600s），只监听实时消息
* 4. 预热结束 → 后台启动历史回溯队列（tg-backfill-queue.js）
* 5. FloodWait → 按返回秒数严格退避；PeerFlood → 进程级熔断 + 钉钉告警
*
* 环境变量（每账号独立，由 ecosystem.config.js 注入）：
*   TG_ACCOUNT_NAME       账号名（必填）
*   TG_API_ID             API ID（必填，从 my.telegram.org 获取）
*   TG_API_HASH           API Hash（必填）
*   TG_WARMUP_SECONDS     预热静默期（秒，默认600）
*   TG_DAILY_LIMIT        每日历史拉取配额（默认2000）
*   TG_BATCH_SIZE         每批次拉取条数（默认100）
*   TG_SLEEP_MIN_MS       批次间最小间隔ms（默认3000）
*   TG_SLEEP_MAX_MS       批次间最大间隔ms（默认8000）
*   TG_BACKFILL_DAYS      回溯天数（默认7，-1=全部，0=禁用）
*   TG_ENABLE_BACKFILL    是否启用回溯（默认true）
*/

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.env') });

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const {
    saveMessage,
    updateAccountStatus,
    upsertCollectorHeartbeat,
    recordRuntimeEvent
} = require('../db/database');
const { getSession, saveSession, getRateLimit } = require('../lib/tg-session-store');
const { registerTask, runBackfillLoop } = require('../lib/tg-backfill-queue');
const { sendAlert, sendAccountAlert } = require('../lib/dingtalk');
const { createCollectorClient } = require('../lib/collector-client');
const { formatShanghai, shanghaiISOString } = require('../lib/time');

// ─── 配置读取 ────────────────────────────────────────────────────────────────
const accountName = process.env.TG_ACCOUNT_NAME || 'default';
const accountKey = accountName.toUpperCase().replace(/-/g, '_');
const accountId = `tgu-${accountName}`;
const collectorId = process.env.COLLECTOR_ID || `pm2:tgu:${accountName}`;
const runId = process.env.TG_RUN_ID || `${accountName}-${Date.now()}-${process.pid}`;
const runStartedAt = shanghaiISOString();
const collectorClient = createCollectorClient({
    baseUrl: process.env.COLLECTOR_API_URL,
    token: process.env.COLLECTOR_TOKEN,
    logger: console
});
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
        platform: 'telegram',
        collectorId,
        runId,
        pid: process.pid,
        status: runtimeState.status,
        phase: runtimeState.phase,
        healthStatus: runtimeState.healthStatus,
        lastError: runtimeState.lastError,
        lastReadyAt: runtimeState.lastReadyAt,
        lastMessageAt: runtimeState.lastMessageAt,
        startedAt: runStartedAt
    };
    upsertCollectorHeartbeat(payload);
    if (collectorClient) collectorClient.heartbeat(payload);
}

function recordCollectorEvent(eventType, message, severity = 'info', data = null) {
    const payload = {
        accountId,
        platform: 'telegram',
        source: 'worker-tg-user',
        eventType,
        severity,
        runId,
        message,
        data
    };
    recordRuntimeEvent(payload);
    if (collectorClient) collectorClient.event(payload);
}

async function setAccountStatus(status, pushname = null, qrCode = null) {
    const payload = { id: accountId, platform: 'telegram', status, pushname, qrCode };
    updateAccountStatus(payload.id, payload.platform, payload.status, payload.pushname, payload.qrCode);
    if (collectorClient) await collectorClient.accountStatus(payload);
    reportHeartbeat({ status, phase: status, healthStatus: status });
}

async function persistMessage(payload) {
    const localResult = saveMessage(payload);
    if (collectorClient) await collectorClient.message(payload);
    reportHeartbeat({ lastMessageAt: shanghaiISOString() });
    return localResult;
}

// 优先读取账号专属环境变量 TG_API_ID_{NAME} / TG_API_HASH_{NAME}，其次通用变量
const apiId = parseInt(
    process.env[`TG_API_ID_${accountKey}`] ||
    process.env.TG_API_ID || '0', 10
);
const apiHash =
    process.env[`TG_API_HASH_${accountKey}`] ||
    process.env.TG_API_HASH || '';

if (!apiId || !apiHash) {
    console.warn(`⚠️ [TGUser:${accountName}] TG_API_ID or TG_API_HASH not configured. Worker idle.`);
    reportHeartbeat({
        status: 'idle',
        phase: 'missing_config',
        healthStatus: 'missing_config',
        lastError: 'TG_API_ID or TG_API_HASH not configured'
    });
    setInterval(() => { }, 3600000);
} else {
reportHeartbeat({ phase: 'booting', status: 'initializing', healthStatus: 'booting' });
const heartbeatTimer = setInterval(() => reportHeartbeat(), 15000);
heartbeatTimer.unref();

// 频控参数
const rateCfg = getRateLimit(accountName);
const WARMUP_SECONDS = parseInt(process.env[`TG_WARMUP_SECONDS_${accountKey}`] || process.env.TG_WARMUP_SECONDS || String(rateCfg.warmup_seconds), 10);
const ENABLE_BACKFILL = (process.env[`TG_ENABLE_BACKFILL_${accountKey}`] || process.env.TG_ENABLE_BACKFILL || String(rateCfg.enable_backfill)) !== 'false';
const BACKFILL_DAYS = parseInt(process.env[`TG_BACKFILL_DAYS_${accountKey}`] || process.env.TG_BACKFILL_DAYS || String(rateCfg.backfill_days), 10);

// ─── 全局状态（供 server.js 的登录 API 读写）────────────────────────────────
// 通过文件共享状态（同一 PM2 进程内存隔离，用文件通信）
const STATUS_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `db/.tgu_status_${accountName}.json`);
const fs = require('fs');

function writeStatus(state) {
    try {
        fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...state, updated_at: Date.now() }), 'utf8');
    } catch (_) { }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function createTtlCache(ttlMs, maxSize = 500) {
    const store = new Map();
    return {
        get(key) {
            if (!key) return null;
            const item = store.get(key);
            if (!item) return null;
            if (Date.now() - item.ts > ttlMs) {
                store.delete(key);
                return null;
            }
            return item.value;
        },
        set(key, value) {
            if (!key || !value) return;
            if (store.size >= maxSize) {
                const oldest = store.keys().next().value;
                if (oldest) store.delete(oldest);
            }
            store.set(key, { value, ts: Date.now() });
        }
    };
}

function peerCacheKey(peer) {
    if (!peer) return '';
    if (typeof peer === 'string' || typeof peer === 'number' || typeof peer === 'bigint') return String(peer);
    const type = peer.className || peer.constructor?.name || 'peer';
    const id = peer.userId || peer.channelId || peer.chatId || peer.id || '';
    return id ? `${type}:${id}` : String(peer);
}

function formatSenderName(sender) {
    if (!sender) return '';
    return `${sender.firstName || ''} ${sender.lastName || ''}`.trim() || sender.username || '';
}

const chatCache = createTtlCache(10 * 60 * 1000);
const senderCache = createTtlCache(10 * 60 * 1000);

async function getCachedChat(msg) {
    const key = peerCacheKey(msg.peerId || msg.chatId || msg.inputChat);
    const cached = chatCache.get(key);
    if (cached) return cached;
    const chat = await msg.getChat().catch(() => null);
    if (chat) chatCache.set(key || peerCacheKey(chat.id), chat);
    return chat;
}

async function getCachedSender(msg) {
    const key = peerCacheKey(msg.senderId || msg.fromId);
    const cached = senderCache.get(key);
    if (cached) return cached;
    const sender = await msg.getSender().catch(() => null);
    if (sender) senderCache.set(key || peerCacheKey(sender.id), sender);
    return sender;
}

// ─── 主逻辑 ──────────────────────────────────────────────────────────────────
async function main() {
    const sessionString = getSession(accountName) || '';
    const session = new StringSession(sessionString);

    let client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        retryDelay: 3000,
        autoReconnect: true,
        useWSS: false,
        testServers: process.env.TG_USE_TEST_SERVERS === 'true',
    });

    // 检查是否有 Session
    if (!sessionString) {
        console.log(`[TGUser:${accountName}] No session found. Waiting for login via API...`);
        writeStatus({ status: 'idle', account: accountName });
        await setAccountStatus('idle', `TG User (${accountName})`, null);

        // 将 client 暴露给登录 API（通过全局变量，仅限同进程 reload 场景）
        global[`tgu_client_${accountName}`] = client;
        global[`tgu_session_${accountName}`] = session;

        // 等待登录完成：优先检查文件信号（跨进程），兼容全局变量（同进程），
        // 兜底：若 Session 已写入 .env（登录成功但白名单步骤被跳过），也自动放行
        while (true) {
            if (global[`tgu_logged_in_${accountName}`]) break;
            try {
                const statusRaw = fs.readFileSync(STATUS_FILE, 'utf8');
                const statusObj = JSON.parse(statusRaw);
                if (statusObj.status === 'login_complete') break;
            } catch (_) { }
            // 兜底检测：Session 已存在则说明登录已完成，跳过白名单步骤直接放行
            const envSession = getSession(accountName);
            if (envSession) {
                console.log(`[TGUser:${accountName}] Session detected in store (whitelist step may have been skipped). Auto-proceeding...`);
                break;
            }
            await sleep(2000);
        }
        // 当收到放行信号，说明 UI 已保存完毕，重新加载环境变量
        require('dotenv').config({ path: path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.env'), override: true });

        // ── 重新读取 session 并建立真正的连接 ──────────────────────────
        const newSessionString = getSession(accountName);
        if (!newSessionString) {
            console.error(`[TGUser:${accountName}] Login completed but no session found in store!`);
            writeStatus({ status: 'error', error: 'no_session_after_login', account: accountName });
            await setAccountStatus('error', null, null);
            setInterval(() => { }, 3600000);
            return;
        }
        const newSession = new StringSession(newSessionString);
        client = new TelegramClient(newSession, apiId, apiHash, {
            connectionRetries: 5,
            retryDelay: 3000,
            autoReconnect: true,
            useWSS: false,
            testServers: process.env.TG_USE_TEST_SERVERS === 'true',
        });
        await client.connect();

        try {
            const me = await client.getMe();
            const displayName = `${me.firstName || ''} ${me.lastName || ''}`.trim() || me.username || accountName;
            console.log(`✅ [TGUser:${accountName}] Post-login connected as: ${displayName}`);
            await setAccountStatus('warmup', displayName, null);
            reportHeartbeat({ lastReadyAt: shanghaiISOString() });
            recordCollectorEvent('connected', `TG user collector connected as ${displayName}`);
            writeStatus({ status: 'warmup', account: accountName, displayName });
        } catch (meErr) {
            console.error(`[TGUser:${accountName}] Post-login getMe failed:`, meErr.message);
            await setAccountStatus('warmup', null, null);
        }
        global[`tgu_client_${accountName}`] = client;
    } else {
        // 已有 Session，直接连接
        console.log(`[TGUser:${accountName}] Session found. Connecting...`);
        writeStatus({ status: 'connecting', account: accountName });
        await client.connect();

        // 验证 session 是否仍有效
        try {
            const me = await client.getMe();
            const displayName = `${me.firstName || ''} ${me.lastName || ''}`.trim() || me.username || accountName;
            console.log(`✅ [TGUser:${accountName}] Connected as: ${displayName}`);
            await setAccountStatus('warmup', displayName, null);
            reportHeartbeat({ lastReadyAt: shanghaiISOString() });
            recordCollectorEvent('connected', `TG user collector connected as ${displayName}`);
            writeStatus({ status: 'warmup', account: accountName, displayName });
            global[`tgu_client_${accountName}`] = client;
        } catch (err) {
            console.error(`[TGUser:${accountName}] Session invalid:`, err.message);
            writeStatus({ status: 'session_invalid', account: accountName });
            await setAccountStatus('session_invalid', null, null);
            reportHeartbeat({ phase: 'session_invalid', healthStatus: 'session_invalid', lastError: err.message });
            recordCollectorEvent('session_invalid', err.message, 'error');
            setInterval(() => { }, 3600000);
            return;
        }
    }

    // 获取白名单配置
    const whitelistStr = process.env[`TG_WHITELIST_${accountName.toUpperCase()}`];
    const whitelist = whitelistStr ? whitelistStr.split(',').filter(x => x) : null;
    if (whitelist) {
        console.log(`[TGUser:${accountName}] Active Whitelist mode: monitoring ${whitelist.length} chats.`);
    }

    // 唤醒 Telegram 更新流（必须调用一次以确保能正常接收实时推送）
    try {
        await client.getDialogs({ limit: 1 });
    } catch (e) { }

    // ─── 实时消息监听（贯穿整个进程生命周期）────────────────────────────────
    client.addEventHandler(async (event) => {
        const msg = event.message;
        if (!msg) return;

        const chat = await getCachedChat(msg);
        if (!chat) return;

        // 只处理群组 / 超级群 / 频道
        const chatType = chat.className;
        console.log(`[TGUser:${accountName}] Debug: Received message in ${chatType} with id ${chat.id}`);
        if (!['Chat', 'Channel'].includes(chatType)) return;

        // 验证白名单（ID 格式统一化：正整数、负整数、-100前缀都能匹配）
        const groupId = String(chat.id);
        const groupIdAbs = groupId.replace(/^-100/, '').replace(/^-/, ''); // 绝对值字符串
        if (whitelist !== null) {
            const whitelistNorm = whitelist.map(id => id.replace(/^-100/, '').replace(/^-/, ''));
            if (!whitelistNorm.includes(groupIdAbs)) {
                console.log(`[TGUser:${accountName}] Debug: filtered by whitelist. chat.id=${groupId}(abs=${groupIdAbs}), whitelist=${JSON.stringify(whitelist)}`);
                return;
            }
        }

        const groupName = chat.title || groupId;
        const sender = await getCachedSender(msg);
        const senderName = formatSenderName(sender);
        const senderId = sender ? String(sender.id) : '';

        const globalMessageId = `${groupIdAbs}_${msg.id}`;

        try {
            await persistMessage({
                platform: 'telegram',
                receiver_account: `tgu-${accountName}`,
                message_id: globalMessageId,
                group_id: groupId,
                group_name: groupName,
                sender_id: senderId,
                sender_name: senderName,
                content: msg.message || '',
                has_media: msg.media ? 1 : 0,
                media_path: null,
                timestamp: msg.date * 1000,
                raw_data: JSON.stringify({ id: msg.id, date: msg.date })
            });
            console.log(`[TGUser:${accountName}] Realtime msg from ${senderName} in ${groupName}`);
        } catch (e) {
            console.error(`[TGUser:${accountName}] Error saving realtime msg:`, e.message);
        }
    }, new NewMessage({}));

    // ─── 预热静默期 ──────────────────────────────────────────────────────────
    console.log(`[TGUser:${accountName}] Warmup period: ${WARMUP_SECONDS}s (realtime listen only, no history pull)`);
    writeStatus({ status: 'warmup', account: accountName, warmup_ends_at: Date.now() + WARMUP_SECONDS * 1000 });
    await setAccountStatus('warmup', null, null);
    await sleep(WARMUP_SECONDS * 1000);

    // ─── 预热结束，进入监听+回溯模式 ────────────────────────────────────────
    console.log(`[TGUser:${accountName}] Warmup done. Starting monitoring + backfill.`);
    writeStatus({ status: 'monitoring', account: accountName });
    await setAccountStatus('monitoring', null, null);

    // 注册所有已加入群的回溯任务
    if (ENABLE_BACKFILL && BACKFILL_DAYS !== 0) {
        try {
            const dialogs = await client.getDialogs({ limit: 200 });
            for (const dialog of dialogs) {
                const entity = dialog.entity;
                if (!entity || !['Chat', 'Channel'].includes(entity.className)) continue;

                const groupId = String(entity.id);
                // 验证白名单（ID 格式统一化）
                if (whitelist !== null) {
                    const gAbs = groupId.replace(/^-100/, '').replace(/^-/, '');
                    const wlNorm = whitelist.map(id => id.replace(/^-100/, '').replace(/^-/, ''));
                    if (!wlNorm.includes(gAbs)) continue;
                }

                registerTask(accountName, groupId, entity.title || groupId);
            }
            console.log(`[TGUser:${accountName}] Registered backfill tasks for ${dialogs.length} chats`);
        } catch (err) {
            console.error(`[TGUser:${accountName}] Failed to register backfill tasks:`, err.message);
        }

        // 熔断回调
        const onCircuitBreak = async (err) => {
            const errName = err.constructor?.name || 'UnknownError';
            reportHeartbeat({ phase: 'circuit_break', healthStatus: 'circuit_break', lastError: err.message });
            recordCollectorEvent('circuit_break', err.message, 'error', { name: errName });
            await sendAlert({
                title: `[TG用户账号熔断] ${accountName}`,
                content: [
                    `### 🔴 [TG采集熔断] tgu-${accountName}`,
                    '',
                    `**错误类型：** ${errName}`,
                    `**触发时间：** ${formatShanghai()}`,
                    `**已暂停：** 历史回溯队列暂停24小时，实时监听不受影响`,
                    `**处理建议：** 检查账号是否被封控，必要时更换账号或等待解封`
                ].join('\n')
            });
        };

        // 启动后台回溯队列（不 await，让它在后台持续运行）
        runBackfillLoop(client, accountName, rateCfg, onCircuitBreak, { saveMessageFn: persistMessage })
            .catch(err => console.error(`[TGUser:${accountName}] Backfill loop crashed:`, err.message));
    }

    // 保持进程永久运行（实时监听已通过 addEventHandler 注册，此处只需保持存活）
    console.log(`[TGUser:${accountName}] Now monitoring in real-time...`);
    while (true) {
        await sleep(60000); // 每分钟 ping 一次防止连接超时
        try {
            await client.getMe();
        } catch(e) {
            console.warn(`[TGUser:${accountName}] Keepalive check failed, may reconnect:`, e.message);
        }
    }
}

main().catch(async (err) => {
    const errName = err.constructor?.name || 'Error';
    console.error(`[TGUser:${accountName}] Fatal error:`, err.message);
    writeStatus({ status: 'error', error: err.message });
    await setAccountStatus('error', null, null);
    reportHeartbeat({ phase: 'error', healthStatus: 'error', lastError: err.message });
    recordCollectorEvent('fatal_error', err.message, 'error', { name: errName });

    // 触发严重断线/崩溃预警到运维専用频道
    try {
        await sendAccountAlert({
            platform: 'tg',
            accountId: `tgu-${accountName}`,
            region: undefined, // TG 当前未配置区域映射，留空
            status: 'crashed',
            detail: `${errName}: ${err.message}。进程将在 30 秒后尝试由 PM2 自动重启，如果反复收到此告警请人工介入处理！`
        });
    } catch (pushErr) {
        console.error(`[TGUser:${accountName}] Failed to send fatal alert:`, pushErr.message);
    }

    if (String(err.message || '').includes('AUTH_KEY_DUPLICATED')) {
        console.error(`[TGUser:${accountName}] AUTH_KEY_DUPLICATED requires a fresh cloud login. Parking worker to avoid restart storm.`);
        setInterval(() => reportHeartbeat({ phase: 'error', healthStatus: 'error', lastError: err.message }), 60000);
        return;
    }

    // 非认证错误，30s 后让 PM2 重启
    await sleep(30000);
    process.exit(1);
});
}
