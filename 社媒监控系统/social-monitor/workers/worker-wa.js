const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { db, saveMessage } = require('../db/database');

const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
];
const executablePath = chromePaths.find(p => fs.existsSync(p)) || undefined;

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '..', 'whatsapp-session') }),
    puppeteer: {
        headless: true,
        executablePath: executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
});

client.on('qr', (qr) => {
    console.log('\n📌 [WhatsApp] Please scan QR code to login:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log(`✅ [WhatsApp] Logged in as: ${client.info?.pushname || client.info?.wid?.user}`);
});

client.on('message_create', async (message) => {
    try {
        const chat = await message.getChat();
        if (!chat.isGroup) return; // Only process group messages
        // skip system e2e notifications
        if (message.type === 'e2e_notification' || message.type === 'protocol') return;

        let contact;
        if (message.fromMe && client.info && client.info.wid) {
             contact = await client.getContactById(client.info.wid._serialized);
        } else {
             contact = await message.getContact();
        }
        
        // 如果是系统消息或获取不到，回退保护
        if (contact.isGroup) {
             console.log(`[WA] Skipped a group-level system event in ${chat.name}`);
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
            message_id: message.id._serialized,
            group_id: chat.id._serialized,
            group_name: groupName,
            sender_id: contact.id._serialized,
            sender_name: senderName,
            content: message.body || '',
            has_media: hasMedia ? 1 : 0,
            media_path: mediaPath,
            timestamp: message.timestamp * 1000,
            raw_data: JSON.stringify(message)
        });
        
        console.log(`[WA] Saved group message from ${senderName} in group ${groupName}`);
    } catch (e) {
        console.error('[WhatsApp] Error processing message:', e.message);
    }
});

client.initialize();
