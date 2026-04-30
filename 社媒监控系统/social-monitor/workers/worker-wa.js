const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { db, saveMessage, updateAccountStatus } = require('../db/database');
const { sendAccountAlert } = require('../lib/dingtalk');

// 区域映射配置
let regionMap = {};
try {
    const configPath = path.join(__dirname, '..', 'config', 'account-regions.json');
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
const sessionPath = path.join(__dirname, '..', `whatsapp-session-${accountName}`);

// Mark as initializing only if no existing record (avoid overwriting 'authenticated')
if (updateAccountStatus) {
    const { db: _db } = require('../db/database');
    const existing = _db.prepare('SELECT status FROM accounts WHERE id = ?').get(`wa-${accountName}`);
    if (!existing) {
        updateAccountStatus(`wa-${accountName}`, 'whatsapp', 'initializing');
    } else if (existing.status === 'disconnected') {
        updateAccountStatus(`wa-${accountName}`, 'whatsapp', 'initializing');
    }
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    },
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--disable-gpu',
            '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ]
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
    
    if (Date.now() - qrStartTime > MAX_QR_TIME_MS) {
        console.log(`[WA] QR timeout after 30 mins. Stopping QR generation.`);
        if (updateAccountStatus) updateAccountStatus(`wa-${accountName}`, 'whatsapp', 'timeout');
        
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
    if (updateAccountStatus) updateAccountStatus(`wa-${accountName}`, 'whatsapp', 'qr', null, qr);
    
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
    if (updateAccountStatus) updateAccountStatus(`wa-${accountName}`, 'whatsapp', 'authenticated', 'Loading...', null);
});

client.on('ready', () => {
    isFirstInit = false; // 成功登录过一次
    const pushname = client.info?.pushname || client.info?.wid?.user || accountName;
    console.log(`✅ [WhatsApp] Logged in as: ${pushname} and ready`);
    if (updateAccountStatus) updateAccountStatus(`wa-${accountName}`, 'whatsapp', 'authenticated', pushname, null);

    // 成功连接，清除掉线计时器
    if (offlineTimer) {
        clearTimeout(offlineTimer);
        offlineTimer = null;
        console.log(`[WA] Reconnected successfully. Offline alert cancelled.`);
    }
});

client.on('disconnected', (reason) => {
    console.log('🔴 [WhatsApp] Client was logged out', reason);
    if (updateAccountStatus) updateAccountStatus(`wa-${accountName}`, 'whatsapp', 'disconnected');

    if (!offlineTimer) {
        console.log(`[WA] Disconnected, starting ${OFFLINE_TIMEOUT_MS/60000}m alert timer...`);
        offlineTimer = setTimeout(() => triggerOfflineAlert(`网络断开/退出: ${reason}`), OFFLINE_TIMEOUT_MS);
    }
});

client.on('auth_failure', (msg) => {
    console.error('🔴 [WhatsApp] Authentication failure', msg);
    if (updateAccountStatus) updateAccountStatus(`wa-${accountName}`, 'whatsapp', 'disconnected');
    
    if (!offlineTimer) {
        offlineTimer = setTimeout(() => triggerOfflineAlert(`认证失败/登出: ${msg}`), OFFLINE_TIMEOUT_MS);
    }
});

client.on('message_create', async (message) => {
    try {
        // 先跳过各种明显非正常的纯状态/系统类或无用协议类型的消息，保护后续调用
        if (!message || !message.from) return;
        const skipTypes = ['e2e_notification', 'protocol', 'gp2', 'notification_template', 'call_log', 'revoked'];
        if (skipTypes.includes(message.type)) return;

        const chat = await message.getChat();
        if (!chat || !chat.isGroup) return; // Only process group messages

        let contact;
        if (message.fromMe && client.info && client.info.wid) {
            contact = await client.getContactById(client.info.wid._serialized).catch(() => null);
        } else {
            contact = await message.getContact().catch(() => null);
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
                    const fileName = `wa_${message.id.id}_${Date.now()}.${ext}`;
                    const absoluteMediaDir = path.join(__dirname, '..', 'media');
                    const absoluteMediaPath = path.join(absoluteMediaDir, fileName);
                    fs.writeFileSync(absoluteMediaPath, Buffer.from(media.data, 'base64'));
                    mediaPath = `media/${fileName}`; // relative representation
                }
            } catch (err) {
                console.error('[WhatsApp] Failed to download media:', err.message);
            }
        }

        saveMessage({
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

        console.log(`[WA] Saved group message from ${senderName} in group ${groupName}`);
    } catch (e) {
        console.error('[WhatsApp] Error processing message:', e.message);
    }
});

console.log(`[WA] Initializing client for ${accountName}...`);
client.initialize();
