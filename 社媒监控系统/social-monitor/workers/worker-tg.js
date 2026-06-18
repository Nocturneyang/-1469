const path = require('path');
require('dotenv').config({ path: path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.env') });
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const {
    saveMessage,
    updateAccountStatus,
    upsertCollectorHeartbeat,
    recordRuntimeEvent
} = require('../db/database');
const { createCollectorClient } = require('../lib/collector-client');
const { shanghaiISOString } = require('../lib/time');
const { isMediaUploadDisabled } = require('../lib/media-policy');

const accountName = process.env.TG_ACCOUNT_NAME || 'default';
const accountId = `tg-${accountName}`;
const collectorId = process.env.COLLECTOR_ID || `pm2:tg:${accountName}`;
const runId = process.env.TG_RUN_ID || `${accountName}-${Date.now()}-${process.pid}`;
const runStartedAt = shanghaiISOString();
const token = process.env.TG_BOT_TOKEN;
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
}).catch(err => {
    console.log('✅ [Telegram] Bot started polling...');
    setAccountStatus('authenticated', 'TG Bot', null);
    reportHeartbeat({ lastReadyAt: shanghaiISOString(), lastError: err.message });
});

bot.on('message', async (msg) => {
    try {
        // Must be supergroup or group
        if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;

        const groupName = msg.chat.title || 'Unknown Group';
        const senderName = msg.from.username || msg.from.first_name || 'Unknown';
        
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

        const groupIdStr = msg.chat.id.toString();
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
            raw_data: JSON.stringify(msg)
        });
        
        console.log(`[TG] Saved message from ${senderName} in group ${groupName}`);
    } catch (e) {
        console.error('[Telegram] Error processing message:', e.message);
    }
});
}
