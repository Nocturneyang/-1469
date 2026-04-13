const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { saveMessage, updateAccountStatus } = require('../db/database');

const accountName = process.env.TG_ACCOUNT_NAME || 'default';
const token = process.env.TG_BOT_TOKEN;

if (!token || token === 'your_telegram_bot_token_here') {
    console.warn('⚠️ [Telegram] TG_BOT_TOKEN not configured. Skipping startup.');
    setTimeout(() => {}, 100000000); // keep process alive for pm2
    return;
const bot = new TelegramBot(token, { polling: true });

bot.getMe().then((me) => {
    const botName = me.first_name + (me.username ? ` (@${me.username})` : '');
    console.log(`✅ [Telegram] Bot started polling as: ${botName}`);
    if (updateAccountStatus) updateAccountStatus(`tg-${accountName}`, 'telegram', 'authenticated', botName, null);
}).catch(err => {
    console.log('✅ [Telegram] Bot started polling...');
    if (updateAccountStatus) updateAccountStatus(`tg-${accountName}`, 'telegram', 'authenticated', `TG Bot`, null);
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
        if (msg.photo && msg.photo.length > 0) {
            hasMedia = true;
            const photo = msg.photo[msg.photo.length - 1]; // highest resolution
            try {
                const mediaDir = path.join(__dirname, '..', 'media');
                const filePath = await bot.downloadFile(photo.file_id, mediaDir);
                const fileName = path.basename(filePath);
                mediaPath = `media/${fileName}`;
            } catch (err) {
                console.error('[Telegram] Failed to download media:', err.message);
            }
        } else if (msg.document) {
            hasMedia = true;
            try {
                const mediaDir = path.join(__dirname, '..', 'media');
                const filePath = await bot.downloadFile(msg.document.file_id, mediaDir);
                const fileName = path.basename(filePath);
                mediaPath = `media/${fileName}`;
            } catch (err) {
                console.error('[Telegram] Failed to download document:', err.message);
            }
        }

        saveMessage({
            platform: 'telegram',
            receiver_account: `tg-${accountName}`,
            message_id: msg.message_id.toString(),
            group_id: msg.chat.id.toString(),
            group_name: groupName,
            sender_id: msg.from.id.toString(),
            sender_name: senderName,
            content: content,
            has_media: hasMedia ? 1 : 0,
            media_path: mediaPath,
            timestamp: msg.date * 1000,
            raw_data: JSON.stringify(msg)
        });
        
        console.log(`[TG] Saved message from ${senderName} in group ${groupName}`);
    } catch (e) {
        console.error('[Telegram] Error processing message:', e.message);
    }
});
