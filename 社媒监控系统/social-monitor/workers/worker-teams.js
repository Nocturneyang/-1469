/**
 * workers/worker-teams.js
 * Microsoft Teams 采集 Worker
 *
 * 特性：
 *   - 基于 Playwright 无头 Chromium，静默后台运行
 *   - 首次/Session 过期时弹出有界面的浏览器供用户登录
 *   - 安全策略：进程隔离 + 指纹伪装 + 行为仿人化
 *   - 支持群聊白名单过滤
 *   - 消息入库复用 saveMessage()，接入现有分析体系
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { saveMessage, updateAccountStatus } = require('../db/database');
const { sendAccountAlert } = require('../lib/dingtalk');
const sessionStore = require('../lib/teams-session-store');
const parser = require('../lib/teams-page-parser');
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
    const regionsPath = path.join(__dirname, '..', 'config', 'account-regions.json');
    if (fs.existsSync(regionsPath)) {
        const config = JSON.parse(fs.readFileSync(regionsPath, 'utf8'));
        const found = (config.accounts || []).find(a => a.account === accountKey);
        if (found) regionInfo = found;
    }
} catch (e) {
    console.warn(`[Teams:${accountName}] 读取区域配置失败:`, e.message);
}

// ─── 安全策略：行为仿人化工具函数 ────────────────────────────────────
/**
 * 随机等待（模拟人类操作延迟）
 * @param {number} minMs
 * @param {number} maxMs
 */
async function randomSleep(minMs, maxMs) {
    const ms = minMs + Math.random() * (maxMs - minMs);
    await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 获取当前轮询间隔（凌晨降频）
 */
function getPollInterval() {
    const hour = new Date().getHours();
    // 凌晨 01:00 - 06:00 降低频率（5 分钟）
    if (hour >= 1 && hour < 6) return 5 * 60 * 1000;
    // 正常工作时段（30-60 秒随机）
    return 30000 + Math.random() * 30000;
}

// ─── 消息去重缓存（防止重复入库）────────────────────────────────────
const seenMessages = new Set();
const MAX_SEEN = 5000;

function markSeen(messageId) {
    seenMessages.add(messageId);
    if (seenMessages.size > MAX_SEEN) {
        // 清理最老的一半
        const arr = [...seenMessages];
        arr.splice(0, MAX_SEEN / 2).forEach(id => seenMessages.delete(id));
    }
}

// ─── 主函数 ──────────────────────────────────────────────────────────
async function main() {
    // 动态加载 playwright（支持安装后热加载）
    let chromium, use;
    try {
        ({ chromium } = require('playwright-extra'));
        const stealth = require('puppeteer-extra-plugin-stealth');
        chromium.use(stealth());
        console.log(`[Teams:${accountName}] 已启用 stealth 防检测模式`);
    } catch (e) {
        // fallback 到标准 playwright
        ({ chromium } = require('playwright'));
        console.warn(`[Teams:${accountName}] playwright-extra 未安装，使用标准模式`);
    }

    const userDataDir = sessionStore.getUserDataDir(accountName);
    const authFile = sessionStore.getAuthFilePath(accountName);

    console.log(`[Teams:${accountName}] 启动采集进程，区域: ${regionInfo.region}`);
    updateAccountStatus(accountKey, 'teams', 'initializing');

    // ── 启动 headless 浏览器（持久化 Profile）────────────────────────
    let context;
    try {
        context = await chromium.launchPersistentContext(userDataDir, {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--window-size=1280,800',
            ],
            viewport: { width: 1280, height: 800 },
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });

        // 如果有已保存的 storageState，加载它
        if (sessionStore.hasSession(accountName)) {
            try {
                const state = sessionStore.loadSession(accountName);
                if (state) await context.addCookies(state.cookies || []);
            } catch (e) {
                console.warn(`[Teams:${accountName}] 加载 storageState 失败:`, e.message);
            }
        }
    } catch (e) {
        console.error(`[Teams:${accountName}] 浏览器启动失败:`, e.message);
        updateAccountStatus(accountKey, 'teams', 'error');
        throw e;
    }

    let page = await context.newPage();
    
    // ── 导航到 Teams ─────────────────────────────────────────────────
    try {
        await page.goto(parser.TEAMS_URL, { waitUntil: 'commit', timeout: 60000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
        await randomSleep(3000, 5000);
    } catch (e) {
        console.warn(`[Teams:${accountName}] 导航到 Teams 遇到延迟或超时，尝试继续检测当前页面:`, e.message);
    }

    // ── 检测登录状态 / 等待主界面加载 ─────────────────────────────────────
    console.log(`[Teams:${accountName}] 等待加载主界面或跳转至登录页...`);
    let needLogin = false;
    let loaded = false;

    // 循环检测，最长等待 60 秒 (30次 * 2秒)
    for (let i = 0; i < 30; i++) {
        needLogin = await parser.isLoginPage(page, 1000);
        if (needLogin) break;
        
        loaded = await parser.waitForMainApp(page, 1000);
        if (loaded) break;
    }

    if (needLogin) {
        console.log(`[Teams:${accountName}] 需要登录，切换到有界面模式`);
        await context.close();
        updateAccountStatus(accountKey, 'teams', 'qr'); // 复用 qr 状态表示"等待用户操作"

        // 发送运维告警
        await sendAccountAlert({
            platform: 'teams',
            accountId: accountKey,
            region: regionInfo.region,
            status: 'session_expired',
            detail: `Session 已过期，已在服务器(Mac)弹出浏览器，请完成 Teams (${accountName}) 登录授权。`,
        }).catch(() => {});

        console.log(`[Teams:${accountName}] 已弹出浏览器，等待用户手动登录...`);
        
        // 重新以有界面模式启动
        context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--window-size=1280,800',
            ],
            viewport: { width: 1280, height: 800 },
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });
        
        const activePages = context.pages();
        page = activePages[activePages.length - 1];
        await page.goto(parser.TEAMS_URL, { waitUntil: 'commit', timeout: 60000 });
        
        // 轮询等待用户登录完成（检测是否到达主界面）
        let loginSuccess = false;
        for (let i = 0; i < 300; i++) { // 等待最多 10 分钟
            loginSuccess = await parser.waitForMainApp(page, 2000);
            if (loginSuccess) break;
            // 如果用户关闭了浏览器窗口
            if (page.isClosed()) break;
        }

        if (!loginSuccess) {
            console.error(`[Teams:${accountName}] 登录超时或窗口被关闭`);
            updateAccountStatus(accountKey, 'teams', 'error');
            await context.close();
            return;
        }
        
        console.log(`[Teams:${accountName}] 登录成功！保存 Session 并重启进程以转入后台无头模式...`);
        try {
            const state = await context.storageState();
            sessionStore.saveSession(accountName, state);
        } catch (e) {
            console.warn(`[Teams:${accountName}] 保存 Session 失败:`, e.message);
        }
        await context.close();
        process.exit(0); // 退出让 PM2 重启，下次就会加载 session 并在后台运行了
    }

    if (!loaded) {
        console.error(`[Teams:${accountName}] 主界面加载超时`);
        updateAccountStatus(accountKey, 'teams', 'error');
        await context.close();
        return;
    }

    // 保存最新 Session
    try {
        const state = await context.storageState();
        sessionStore.saveSession(accountName, state);
    } catch (e) {
        console.warn(`[Teams:${accountName}] 保存 Session 失败:`, e.message);
    }

    // 获取已登录用户信息
    const title = await page.title();
    const displayName = title.replace(' | Microsoft Teams', '').trim() || accountName;
    updateAccountStatus(accountKey, 'teams', 'authenticated', displayName);
    console.log(`✅ [Teams:${accountName}] 已登录: ${displayName}`);

    // ── 获取群聊列表 ──────────────────────────────────────────────────
    await randomSleep(3000, 5000);
    const allChats = await parser.getChatList(page);
    console.log(`[Teams:${accountName}] 发现 ${allChats.length} 个 Chat`);
    backfillQueue.cacheChats(accountName, allChats.map(c => ({ chatId: c.chatId, name: c.name })));

    // 应用白名单过滤
    const targetChats = whitelist
        ? allChats.filter(c => whitelist.includes(c.chatId) || whitelist.includes(c.name))
        : allChats;

    console.log(`[Teams:${accountName}] 监控 ${targetChats.length} 个群聊（白名单: ${whitelist ? '已启用' : '全部'}）`);

    // ── 实时轮询监听 ──────────────────────────────────────────────────
    let lastPollTime = Date.now();

    async function pollMessages() {
        for (const chat of targetChats) {
            try {
                // 随机等待，避免连续快速切换（安全策略）
                await randomSleep(8000, 20000);

                // 打开该 Chat
                const chatItems = page.locator('[data-tid="chat-pane-item"]');
                const item = chatItems.nth(chat.index);
                if (await item.count() === 0) continue;

                await item.click();
                await randomSleep(2000, 4000);

                // 验证是否是群聊
                const isGroup = await parser.isGroupChat(page);
                if (!isGroup) continue; // 跳过个人对话

                // 获取 Chat 信息
                const chatInfo = await parser.getCurrentChatInfo(page);

                // 提取新消息（仅提取最后一次轮询时间后的消息）
                const messages = await parser.extractMessages(page, lastPollTime - 60000); // 多取1分钟的缓冲

                for (const msg of messages) {
                    if (seenMessages.has(msg.messageId)) continue;
                    markSeen(msg.messageId);

                    saveMessage({
                        platform: 'teams',
                        receiver_account: accountKey,
                        message_id: msg.messageId,
                        group_id: chatInfo.chatId || chat.chatId,
                        group_name: chatInfo.name || chat.name,
                        sender_id: msg.senderName, // Teams 个人账号难以获取稳定 UID
                        sender_name: msg.senderName,
                        content: msg.content,
                        has_media: msg.hasMedia ? 1 : 0,
                        media_path: null,
                        timestamp: msg.timestamp,
                        raw_data: null,
                    });

                    console.log(`[Teams:${accountName}] 保存消息: ${msg.senderName} @ ${chatInfo.name || chat.name}`);
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
        const interval = getPollInterval();
        console.log(`[Teams:${accountName}] 下次轮询: ${Math.round(interval / 1000)}s 后`);
        await new Promise(resolve => setTimeout(resolve, interval));

        try {
            // 检查页面是否还活着
            await page.title();

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
                        const chatItems = page.locator('[data-tid="chat-pane-item"]');
                        const item = chatItems.nth(chat.index);
                        if (await item.count() === 0) continue;
                        await item.click();
                        await randomSleep(2000, 4000);
                        // 多次向上滚动加载历史
                        await parser.scrollUpToLoadHistory(page, 10);
                        const msgs = await parser.extractMessages(page, cutoff);
                        const chatInfo = await parser.getCurrentChatInfo(page);
                        for (const msg of msgs) {
                            if (seenMessages.has(msg.messageId)) continue;
                            markSeen(msg.messageId);
                            saveMessage({
                                platform: 'teams', receiver_account: accountKey,
                                message_id: msg.messageId,
                                group_id: chatInfo.chatId || chat.chatId,
                                group_name: chatInfo.name || chat.name,
                                sender_id: msg.senderName, sender_name: msg.senderName,
                                content: msg.content, has_media: msg.hasMedia ? 1 : 0,
                                media_path: null, timestamp: msg.timestamp, raw_data: null,
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
            // 尝试刷新页面
            try {
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
                await randomSleep(3000, 5000);
            } catch (reloadErr) {
                console.error(`[Teams:${accountName}] 页面刷新失败，准备退出:`, reloadErr.message);
                break;
            }
        }
    }

    await context.close();
}

main().catch(async (err) => {
    console.error(`[Teams:${accountName}] 致命错误:`, err.message);
    updateAccountStatus(accountKey, 'teams', 'error');

    await sendAccountAlert({
        platform: 'teams',
        accountId: accountKey,
        region: regionInfo.region,
        status: 'crashed',
        detail: `${err.constructor?.name || 'Error'}: ${err.message}。进程将在 30 秒后由 PM2 尝试重启。`,
    }).catch(() => {});

    await new Promise(resolve => setTimeout(resolve, 30000));
    process.exit(1);
});
