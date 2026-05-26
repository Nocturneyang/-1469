/**
 * workers/worker-teams-graph.js
 * Microsoft Teams 采集 Worker (基于 Microsoft Graph API)
 *
 * 特性：
 *   - 使用 Microsoft Graph API 替代 Playwright DOM 解析
 *   - OAuth 2.0 授权，自动 token 刷新
 *   - 获取完整用户信息
 *   - 支持群聊白名单过滤
 *   - 消息入库复用 saveMessage()，接入现有分析体系
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { saveMessage, updateAccountStatus } = require('../db/database');
const { sendAccountAlert } = require('../lib/dingtalk');
const tokenStore = require('../lib/teams-token-store');
const graphClient = require('../lib/microsoft-graph-client');
const backfillQueue = require('../lib/teams-backfill-queue');

// ─── 配置 ────────────────────────────────────────────────────────────
const accountName = process.env.ACCOUNT_NAME || 'default';
const accountKey = `teams-${accountName}`;

// 群聊白名单（逗号分隔的 chatId 列表，空表示全部监控）
const whitelistRaw = process.env[`TEAMS_WHITELIST_${accountName.toUpperCase().replace(/-/g, '_')}`] || '';
const whitelist = whitelistRaw ? whitelistRaw.split(',').map(s => s.trim()).filter(Boolean) : null;

// 区域映射
let regionInfo = { region: '未配置', platform: 'teams' };
try {
    const regionsPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'config', 'account-regions.json');
    if (fs.existsSync(regionsPath)) {
        const config = JSON.parse(fs.readFileSync(regionsPath, 'utf8'));
        const found = (config.accounts || []).find(a => a.account === accountKey);
        if (found) regionInfo = found;
    }
} catch (e) {
    console.warn(`[Teams:${accountName}] 读取区域配置失败:`, e.message);
}

// ─── 消息去重缓存（防止重复入库）────────────────────────────────────
const seenMessages = new Set();
const MAX_SEEN = 5000;

function markSeen(messageId) {
    seenMessages.add(messageId);
    if (seenMessages.size > MAX_SEEN) {
        const arr = [...seenMessages];
        arr.splice(0, MAX_SEEN / 2).forEach(id => seenMessages.delete(id));
    }
}

// ─── 主函数 ──────────────────────────────────────────────────────────
async function main() {
    console.log(`[Teams:${accountName}] 启动 Graph API 采集进程，区域: ${regionInfo.region}`);
    updateAccountStatus(accountKey, 'teams', 'initializing');

    // 检查是否有有效的 token
    if (!tokenStore.hasTokens(accountName)) {
        console.log(`[Teams:${accountName}] 未找到授权 token，等待用户完成 OAuth 授权...`);
        updateAccountStatus(accountKey, 'teams', 'qr'); // 复用 qr 状态表示"等待用户操作"
        
        // 发送运维告警
        await sendAccountAlert({
            platform: 'teams',
            accountId: accountKey,
            region: regionInfo.region,
            status: 'not_authorized',
            detail: `账号 ${accountName} 尚未完成 OAuth 授权，请前往管理界面完成授权。`,
        }).catch(() => {});

        // 轮询等待授权完成（每 30 秒检查一次）
        for (let i = 0; i < 600; i++) { // 最多等待 5 小时
            await new Promise(resolve => setTimeout(resolve, 30000));
            
            if (tokenStore.hasTokens(accountName)) {
                console.log(`[Teams:${accountName}] 检测到授权完成！`);
                break;
            }
        }

        if (!tokenStore.hasTokens(accountName)) {
            console.error(`[Teams:${accountName}] 授权超时`);
            updateAccountStatus(accountKey, 'teams', 'error');
            return;
        }
    }

    // 获取用户信息
    const userInfo = await tokenStore.getUserInfo(accountName);
    updateAccountStatus(accountKey, 'teams', 'authenticated', userInfo?.displayName || accountName);
    console.log(`✅ [Teams:${accountName}] 已授权: ${userInfo?.displayName || accountName} (${userInfo?.mail || userInfo?.userPrincipalName})`);

    // ── 获取聊天列表 ──────────────────────────────────────────────────
    let accessToken;
    try {
        accessToken = await tokenStore.getValidAccessToken(accountName);
        const allChats = await graphClient.getChats(accessToken);
        console.log(`[Teams:${accountName}] 发现 ${allChats.length} 个 Chat`);
        
        // 缓存聊天列表
        const chatList = allChats.map(chat => ({
            chatId: chat.id,
            name: chat.chatType === 'oneOnOne' 
                ? (chat.members?.[0]?.displayName || 'Private Chat')
                : (chat.topic || 'Group Chat'),
            chatType: chat.chatType
        }));
        backfillQueue.cacheChats(accountName, chatList);

        // 应用白名单过滤（只监控群聊）
        const targetChats = whitelist
            ? chatList.filter(c => whitelist.includes(c.chatId) || whitelist.includes(c.name))
            : chatList.filter(c => c.chatType === 'group');

        console.log(`[Teams:${accountName}] 监控 ${targetChats.length} 个群聊（白名单: ${whitelist ? '已启用' : '全部群聊'}）`);

        // ── 实时轮询监听 ──────────────────────────────────────────────────
        let lastPollTime = Date.now();

        async function pollMessages() {
            for (const chat of targetChats) {
                try {
                    // 获取有效的 access token
                    accessToken = await tokenStore.getValidAccessToken(accountName);

                    // 获取聊天消息
                    const messages = await graphClient.getChatMessages(accessToken, chat.chatId);

                    for (const msg of messages) {
                        // Graph API 返回的消息格式
                        const messageId = msg.id;
                        if (seenMessages.has(messageId)) continue;
                        markSeen(messageId);

                        // 解析发送人
                        const senderInfo = msg.from?.application?.displayName 
                            || msg.from?.user?.displayName 
                            || 'Unknown';
                        
                        // 解析内容
                        let content = '';
                        let hasMedia = false;
                        
                        if (msg.body?.content) {
                            content = msg.body.content.replace(/<[^>]*>/g, '').trim(); // 移除 HTML 标签
                        } else if (msg.attachments && msg.attachments.length > 0) {
                            hasMedia = true;
                            const attachment = msg.attachments[0];
                            if (attachment.contentType?.startsWith('image/')) {
                                content = '[图片]';
                            } else if (attachment.contentType?.startsWith('video/')) {
                                content = '[视频]';
                            } else {
                                content = `[附件: ${attachment.name || '文件'}]`;
                            }
                        }

                        if (!content) continue;

                        // 时间戳
                        const timestamp = msg.createdDateTime ? new Date(msg.createdDateTime).getTime() : Date.now();

                        // 只保存上次轮询之后的消息
                        if (timestamp < lastPollTime - 60000) continue;

                        saveMessage({
                            platform: 'teams',
                            receiver_account: accountKey,
                            message_id: messageId,
                            group_id: chat.chatId,
                            group_name: chat.name,
                            sender_id: msg.from?.user?.id || senderInfo,
                            sender_name: senderInfo,
                            content: content,
                            has_media: hasMedia ? 1 : 0,
                            media_path: null,
                            timestamp: timestamp,
                            raw_data: null,
                        });

                        console.log(`[Teams:${accountName}] 保存消息: ${senderInfo} @ ${chat.name}`);
                    }
                } catch (e) {
                    console.error(`[Teams:${accountName}] 轮询 Chat[${chat.name}] 出错:`, e.message);
                }
            }
            lastPollTime = Date.now();
        }

        // 首次立刻轮询
        await pollMessages();

        // 定时轮询主循环
        while (true) {
            // 凌晨降频：01:00 - 06:00 降低频率（5 分钟）
            const hour = new Date().getHours();
            const interval = (hour >= 1 && hour < 6) 
                ? 5 * 60 * 1000 
                : 30000 + Math.random() * 30000;

            console.log(`[Teams:${accountName}] 下次轮询: ${Math.round(interval / 1000)}s 后`);
            await new Promise(resolve => setTimeout(resolve, interval));

            try {
                // 检查是否有回溯指令
                const { action, days } = backfillQueue.checkBackfillFlag(accountName);
                if (action === 'start') {
                    console.log(`[Teams:${accountName}] 开始历史回溯，回溯 ${days} 天`);
                    backfillQueue.writeBackfillStatus(accountName, { running: true, days, progress: 0 });
                    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
                    
                    for (const chat of targetChats) {
                        const { action: newAction } = backfillQueue.checkBackfillFlag(accountName);
                        if (newAction === 'pause') break;
                        
                        try {
                            accessToken = await tokenStore.getValidAccessToken(accountName);
                            const msgs = await graphClient.getChatMessages(accessToken, chat.chatId);
                            
                            for (const msg of msgs) {
                                const messageId = msg.id;
                                if (seenMessages.has(messageId)) continue;
                                markSeen(messageId);

                                const senderInfo = msg.from?.application?.displayName 
                                    || msg.from?.user?.displayName 
                                    || 'Unknown';
                                
                                let content = '';
                                let hasMedia = false;
                                
                                if (msg.body?.content) {
                                    content = msg.body.content.replace(/<[^>]*>/g, '').trim();
                                } else if (msg.attachments && msg.attachments.length > 0) {
                                    hasMedia = true;
                                    const attachment = msg.attachments[0];
                                    if (attachment.contentType?.startsWith('image/')) {
                                        content = '[图片]';
                                    } else if (attachment.contentType?.startsWith('video/')) {
                                        content = '[视频]';
                                    } else {
                                        content = `[附件: ${attachment.name || '文件'}]`;
                                    }
                                }

                                if (!content) continue;

                                const timestamp = msg.createdDateTime ? new Date(msg.createdDateTime).getTime() : Date.now();
                                if (timestamp < cutoff) continue;

                                saveMessage({
                                    platform: 'teams', receiver_account: accountKey,
                                    message_id: messageId,
                                    group_id: chat.chatId,
                                    group_name: chat.name,
                                    sender_id: msg.from?.user?.id || senderInfo,
                                    sender_name: senderInfo,
                                    content: content, has_media: hasMedia ? 1 : 0,
                                    media_path: null, timestamp: timestamp, raw_data: null,
                                });
                            }
                            console.log(`[Teams:${accountName}] 回溯 ${chat.name} 完成，共 ${msgs.length} 条`);
                        } catch (e) {
                            console.error(`[Teams:${accountName}] 回溯 ${chat.name} 失败:`, e.message);
                        }
                    }
                    backfillQueue.clearBackfillFlag(accountName);
                    backfillQueue.writeBackfillStatus(accountName, { running: false, done: true });
                    console.log(`[Teams:${accountName}] 历史回溯完成`);
                }

                await pollMessages();
            } catch (e) {
                console.error(`[Teams:${accountName}] 轮询主循环异常:`, e.message);
                // 等待后重试
                await new Promise(resolve => setTimeout(resolve, 60000));
            }
        }
    } catch (e) {
        console.error(`[Teams:${accountName}] 致命错误:`, e.message);
        updateAccountStatus(accountKey, 'teams', 'error');

        await sendAccountAlert({
            platform: 'teams',
            accountId: accountKey,
            region: regionInfo.region,
            status: 'crashed',
            detail: `${e.constructor?.name || 'Error'}: ${e.message}。进程将在 30 秒后由 PM2 尝试重启。`,
        }).catch(() => {});

        await new Promise(resolve => setTimeout(resolve, 30000));
        process.exit(1);
    }
}

main().catch(async (err) => {
    console.error(`[Teams:${accountName}] 未捕获的异常:`, err.message);
    updateAccountStatus(accountKey, 'teams', 'error');
    process.exit(1);
});
