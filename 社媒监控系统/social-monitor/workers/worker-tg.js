const path = require('path');
require('dotenv').config({ path: path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.env') });
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const {
    buildCanonicalMessageId,
    getChannelAccountRuntimeConfig,
    saveMessage,
    updateAccountStatus,
    upsertCollectorHeartbeat,
    recordRuntimeEvent
} = require('../db/database');
const { createCollectorClient } = require('../lib/collector-client');
const { shanghaiISOString } = require('../lib/time');
const { isMediaUploadDisabled } = require('../lib/media-policy');
const { startWorkbenchOutboundRuntime } = require('../lib/workbench-outbound-runtime');
const { startWorkbenchChannelSyncRuntime } = require('../lib/workbench-channel-sync-runtime');

const accountName = process.env.TG_ACCOUNT_NAME || 'default';
const accountKey = accountName.toUpperCase().replace(/-/g, '_');
const accountId = `tg-${accountName}`;
const accountRuntimeConfig = getChannelAccountRuntimeConfig(accountId, 'tg');
const isServiceAccount = accountRuntimeConfig.is_service_account && Number(accountRuntimeConfig.workbench_visible) !== 0;
const canCollectMessages = Number(accountRuntimeConfig.collect_enabled) !== 0;
const canSyncWorkbenchGroups = isServiceAccount && Number(accountRuntimeConfig.sync_groups_enabled) !== 0;
const canSendWorkbenchMessages = isServiceAccount && Number(accountRuntimeConfig.send_enabled) !== 0;
const collectorId = process.env.COLLECTOR_ID || `pm2:tg:${accountName}`;
const runId = process.env.TG_RUN_ID || `${accountName}-${Date.now()}-${process.pid}`;
const runStartedAt = shanghaiISOString();
const token = process.env[`TG_BOT_TOKEN_${accountKey}`] || process.env.TG_BOT_TOKEN;
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
let workbenchOutboundRuntime = null;
let workbenchChannelSyncRuntime = null;
const seenChats = new Map();

console.log(`[TG:${accountName}] Account role: ${accountRuntimeConfig.account_role}, service=${isServiceAccount}, collect=${canCollectMessages}`);

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
        source: 'worker-tg',
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

function createWorkbenchSendError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function canonicalTgRemoteMessageId(chatId, nativeMessageId) {
    if (!nativeMessageId) return null;
    return buildCanonicalMessageId({
        platform: 'telegram',
        receiver_account: accountId,
        group_id: String(chatId),
        message_id: String(nativeMessageId),
        native_message_id: String(nativeMessageId),
        chat_kind: String(chatId).startsWith('-') ? 'group' : 'private',
    });
}

async function sendWorkbenchTgMessage(task) {
    const chatId = task.chat_id || task.group_id;
    if (!chatId) throw createWorkbenchSendError('MISSING_CHAT_ID', 'Missing Telegram chat id');
    const text = String(task.text || '').trim();
    if (!text) throw createWorkbenchSendError('EMPTY_MESSAGE', 'Cannot send an empty Telegram message');
    const options = {};
    if (task.quote_msg_id) {
        const quoteId = Number(task.quote_msg_id);
        if (Number.isFinite(quoteId)) options.reply_to_message_id = quoteId;
    }
    const sent = await bot.sendMessage(chatId, text, options);
    return {
        remote_msg_id: canonicalTgRemoteMessageId(chatId, sent && sent.message_id),
    };
}

function startWorkbenchOutboundIfNeeded() {
    if (workbenchOutboundRuntime) return;
    if (!canSendWorkbenchMessages) {
        console.log(`[TG:${accountName}] Workbench outbound disabled for account_role=${accountRuntimeConfig.account_role}`);
        return;
    }
    workbenchOutboundRuntime = startWorkbenchOutboundRuntime({
        platform: 'tg',
        accountAliases: [accountId, accountName],
        label: `tg:${accountName}`,
        logger: console,
        sendMessage: sendWorkbenchTgMessage,
    });
}

function collectWorkbenchTgChannelSnapshot() {
    const groups = [...seenChats.values()].map((chat) => ({
        group_id: chat.id,
        group_name: chat.title || chat.name || chat.id,
        kind: chat.kind || 'group',
        raw_json: chat.raw || chat,
    }));
    return {
        groups,
    };
}

function startWorkbenchChannelSyncIfNeeded() {
    if (workbenchChannelSyncRuntime) return;
    if (!canSyncWorkbenchGroups) {
        console.log(`[TG:${accountName}] Workbench channel sync disabled for account_role=${accountRuntimeConfig.account_role}`);
        return;
    }
    workbenchChannelSyncRuntime = startWorkbenchChannelSyncRuntime({
        platform: 'tg',
        accountAliases: [accountId, accountName],
        label: `tg:${accountName}`,
        logger: console,
        collectSnapshot: async () => collectWorkbenchTgChannelSnapshot(),
    });
}

if (!token || token === 'your_telegram_bot_token_here') {
    console.warn('⚠️ [Telegram] TG_BOT_TOKEN not configured. Skipping startup.');
    reportHeartbeat({
        status: 'idle',
        phase: 'missing_config',
        healthStatus: 'missing_config',
        lastError: 'TG_BOT_TOKEN not configured'
    });
    setTimeout(() => {}, 100000000); // keep process alive for pm2
} else {
reportHeartbeat({ phase: 'booting', status: 'initializing', healthStatus: 'booting' });
const heartbeatTimer = setInterval(() => reportHeartbeat(), 15000);
heartbeatTimer.unref();
const bot = new TelegramBot(token, { polling: true });

bot.getMe().then((me) => {
    const botName = me.first_name + (me.username ? ` (@${me.username})` : '');
    console.log(`✅ [Telegram] Bot started polling as: ${botName}`);
    setAccountStatus('authenticated', botName, null);
    reportHeartbeat({ lastReadyAt: shanghaiISOString() });
    recordCollectorEvent('connected', `TG bot collector connected as ${botName}`);
    startWorkbenchOutboundIfNeeded();
    startWorkbenchChannelSyncIfNeeded();
}).catch(err => {
    console.log('✅ [Telegram] Bot started polling...');
    setAccountStatus('authenticated', 'TG Bot', null);
    reportHeartbeat({ lastReadyAt: shanghaiISOString(), lastError: err.message });
    startWorkbenchOutboundIfNeeded();
    startWorkbenchChannelSyncIfNeeded();
});

bot.on('message', async (msg) => {
    try {
        if (!canCollectMessages) return;
        if (!msg.chat || !['group', 'supergroup', 'private'].includes(msg.chat.type)) return;

        const groupName = msg.chat.title || [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || 'Unknown Chat';
        const senderName = msg.from.username || msg.from.first_name || 'Unknown';
        const groupIdStr = msg.chat.id.toString();
        seenChats.set(groupIdStr, {
            id: groupIdStr,
            title: groupName,
            kind: msg.chat.type === 'private' ? 'direct' : 'group',
            raw: {
                id: msg.chat.id,
                type: msg.chat.type,
                title: msg.chat.title || null,
                username: msg.chat.username || null,
            },
        });
        
        let content = msg.text || msg.caption || '';
        let mediaPath = null;
        let hasMedia = false;
        
        // Handle photos
        if (!isMediaUploadDisabled() && msg.photo && msg.photo.length > 0) {
            hasMedia = true;
            const photo = msg.photo[msg.photo.length - 1]; // highest resolution
            try {
                const mediaDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'media');
                const filePath = await bot.downloadFile(photo.file_id, mediaDir);
                const fileName = path.basename(filePath);
                mediaPath = `media/${fileName}`;
            } catch (err) {
                console.error('[Telegram] Failed to download media:', err.message);
            }
        } else if (!isMediaUploadDisabled() && msg.document) {
            hasMedia = true;
            try {
                const mediaDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'media');
                const filePath = await bot.downloadFile(msg.document.file_id, mediaDir);
                const fileName = path.basename(filePath);
                mediaPath = `media/${fileName}`;
            } catch (err) {
                console.error('[Telegram] Failed to download document:', err.message);
            }
        }

        const normalizedGroupId = groupIdStr.replace(/^-100/, '').replace(/^-/, '');
        const globalMessageId = `${normalizedGroupId}_${msg.message_id}`;

        await persistMessage({
            platform: 'telegram',
            receiver_account: `tg-${accountName}`,
            message_id: globalMessageId,
            group_id: groupIdStr,
            group_name: groupName,
            sender_id: msg.from.id.toString(),
            sender_name: senderName,
            content: content,
            has_media: mediaPath ? 1 : 0,
            media_path: mediaPath,
            timestamp: msg.date * 1000,
            raw_data: JSON.stringify({
                ...msg,
                native_chat_id: groupIdStr,
                native_message_id: msg.message_id,
                chat_kind: msg.chat.type === 'private' ? 'private' : 'group',
            })
        });
        
        console.log(`[TG] Saved message from ${senderName} in group ${groupName}`);
    } catch (e) {
        console.error('[Telegram] Error processing message:', e.message);
    }
});
}
