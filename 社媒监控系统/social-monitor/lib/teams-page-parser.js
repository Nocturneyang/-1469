/**
 * lib/teams-page-parser.js
 * Microsoft Teams Web DOM 解析器
 * 
 * 所有选择器集中在此文件维护，便于 UI 变更时一处修改全局生效。
 * 选择器按三级优先级设计：
 *   1. ARIA 角色（最稳定）
 *   2. data-tid 内部属性（次稳定）
 *   3. 文本/结构定位（降级保底）
 */
'use strict';

const TEAMS_URL = 'https://teams.microsoft.com';

// ─── 选择器常量 ─────────────────────────────────────────────────────
const SELECTORS = {
    // 登录检测
    loginPage: 'input[type="email"], [data-tid="login-btn"]',
    
    // 主界面已加载
    mainApp: '[data-tid="app-layout"], [data-tid="app-wrapper"], .app-wrapper, #app, #teams-app-div, #teams-app, [data-tid="chat-list"], [aria-label="Chat"], [data-tid="left-rail-chat-button"]',
    
    // 左侧 Chat 列表
    chatList: '[data-tid="chat-list"], [aria-label="Chat list"], [data-tid="left-rail-chat-button"]',
    chatItem: '[data-tid="chat-pane-item"], [data-tid="chat-item"]',
    chatItemName: '[data-tid="chat-pane-item-title"], .chat-title',
    
    // 聊天内容区
    messageContainer: '[data-tid="message-pane"], [role="main"]',
    messageItem: '[data-tid^="message-id-"], [data-tid="chat-compose-box"] ~ * [role="article"]',
    messageBody: '[data-tid="message-body-text"], .message-body',
    messageAuthor: '[data-tid="author"], [data-tid="message-author"]',
    messageTimestamp: '[data-tid="message-timestamp"], time',
    
    // 媒体消息
    attachmentItem: '[data-tid="attachment"], [data-tid="file-attachment"]',
    imageItem: 'img[data-tid="messageImage"], img[data-tid="image-content"]',
    videoItem: 'video, [data-tid="video-attachment"]',
    
    // 群聊标识（用于区分群聊和个人聊天）
    groupChatIndicator: '[data-tid="group-header"], [aria-label*="group"]',
    chatMemberCount: '[data-tid="member-count"], [data-tid="participant-count"]',
    
    // 输入框（用于验证当前位置）
    messageInput: '[data-tid="new-message-textbox"], [aria-label="Type a new message"]',
    
    // 导航切换
    chatNavButton: '[data-tid="left-rail-chat-button"], [aria-label="Chat"]',
};

// ─── 解析函数 ────────────────────────────────────────────────────────

/**
 * 检测当前页面是否是登录页
 */
async function isLoginPage(page, timeout = 3000) {
    try {
        await page.waitForSelector(SELECTORS.loginPage, { timeout });
        return true;
    } catch {
        return false;
    }
}

/**
 * 等待主界面加载完成
 */
async function waitForMainApp(page, timeout = 30000) {
    try {
        await page.waitForSelector(SELECTORS.mainApp, { timeout });
        return true;
    } catch {
        return false;
    }
}

/**
 * 获取所有 Chat 列表项
 * @returns {Array<{chatId: string, name: string, element}>}
 */
async function getChatList(page) {
    const chats = [];
    try {
        // 点击左侧 Chat 导航
        const chatNav = page.locator(SELECTORS.chatNavButton).first();
        if (await chatNav.count() > 0) {
            await chatNav.click();
            await page.waitForTimeout(1500);
        }

        const items = page.locator(SELECTORS.chatItem);
        const count = await items.count();

        for (let i = 0; i < count; i++) {
            const item = items.nth(i);
            try {
                // 提取 Chat ID（从 data-tid 或 aria 属性中获取）
                const dataTid = await item.getAttribute('data-tid') || '';
                const ariaLabel = await item.getAttribute('aria-label') || '';
                
                // 提取名称
                const nameEl = item.locator(SELECTORS.chatItemName).first();
                const name = await nameEl.count() > 0
                    ? (await nameEl.textContent() || '').trim()
                    : ariaLabel.replace(/^Chat with /i, '').trim();

                if (!name) continue;

                // 尝试从 data-tid 提取 ID
                const idMatch = dataTid.match(/chat-pane-item-(.+)/) || ariaLabel.match(/id:([^\s]+)/);
                const chatId = idMatch ? idMatch[1] : `chat_${i}`;

                chats.push({ chatId, name, index: i });
            } catch (e) {
                // 忽略单个 item 解析失败
            }
        }
    } catch (e) {
        console.error('[TeamsParser] getChatList error:', e.message);
    }
    return chats;
}

/**
 * 检测某个 Chat 是否是群聊（3人以上）
 */
async function isGroupChat(page) {
    try {
        // 检查成员人数标识
        const memberCount = page.locator(SELECTORS.chatMemberCount).first();
        if (await memberCount.count() > 0) {
            const text = await memberCount.textContent() || '';
            const match = text.match(/(\d+)/);
            if (match) return parseInt(match[1]) >= 3;
        }
        // 检查群聊头部标识
        const groupIndicator = page.locator(SELECTORS.groupChatIndicator).first();
        return await groupIndicator.count() > 0;
    } catch {
        return false;
    }
}

/**
 * 提取当前聊天窗口中的消息
 * @param {Page} page
 * @param {number} [sinceTimestamp] - 仅提取此时间戳之后的消息（ms）
 * @returns {Array<{messageId, senderName, content, timestamp, hasMedia}>}
 */
async function extractMessages(page, sinceTimestamp = 0) {
    const messages = [];
    try {
        const items = page.locator(SELECTORS.messageItem);
        const count = await items.count();

        for (let i = 0; i < count; i++) {
            const item = items.nth(i);
            try {
                // 消息 ID
                const dataTid = await item.getAttribute('data-tid') || '';
                const messageId = dataTid.replace('message-id-', '') || `msg_${Date.now()}_${i}`;

                // 发送人
                const authorEl = item.locator(SELECTORS.messageAuthor).first();
                const senderName = await authorEl.count() > 0
                    ? (await authorEl.textContent() || 'Unknown').trim()
                    : 'Unknown';

                // 时间戳
                const timeEl = item.locator(SELECTORS.messageTimestamp).first();
                let timestamp = Date.now();
                if (await timeEl.count() > 0) {
                    const dateStr = await timeEl.getAttribute('datetime') || await timeEl.textContent() || '';
                    const parsed = Date.parse(dateStr);
                    if (!isNaN(parsed)) timestamp = parsed;
                }

                if (timestamp < sinceTimestamp) continue;

                // 媒体处理（不下载，只写占位文本）
                let content = '';
                let hasMedia = false;

                if (await item.locator(SELECTORS.imageItem).count() > 0) {
                    content = '[图片]';
                    hasMedia = true;
                } else if (await item.locator(SELECTORS.videoItem).count() > 0) {
                    content = '[视频]';
                    hasMedia = true;
                } else if (await item.locator(SELECTORS.attachmentItem).count() > 0) {
                    // 尝试获取文件名
                    const attachEl = item.locator(SELECTORS.attachmentItem).first();
                    const fileName = (await attachEl.textContent() || '').trim() || '文件';
                    content = `[附件: ${fileName}]`;
                    hasMedia = true;
                } else {
                    // 普通文本消息
                    const bodyEl = item.locator(SELECTORS.messageBody).first();
                    if (await bodyEl.count() > 0) {
                        content = (await bodyEl.textContent() || '').trim();
                    } else {
                        content = (await item.textContent() || '').trim().slice(0, 2000);
                    }
                }

                if (!content) continue;

                messages.push({
                    messageId,
                    senderName,
                    content,
                    timestamp,
                    hasMedia,
                });
            } catch (e) {
                // 忽略单条消息解析失败
            }
        }
    } catch (e) {
        console.error('[TeamsParser] extractMessages error:', e.message);
    }
    return messages;
}

/**
 * 获取当前聊天窗口的 Chat ID 和名称（从 URL/页面标题提取）
 */
async function getCurrentChatInfo(page) {
    try {
        const url = page.url();
        // Teams URL 格式: https://teams.microsoft.com/v2/#/chat/xxx/...
        const match = url.match(/\/chat\/([^/]+)/);
        const chatId = match ? decodeURIComponent(match[1]) : `chat_${Date.now()}`;

        // 从标题或 Header 获取群名
        const title = await page.title();
        const name = title.replace(' | Microsoft Teams', '').trim() || chatId;

        return { chatId, name };
    } catch (e) {
        return { chatId: `chat_${Date.now()}`, name: 'Unknown' };
    }
}

/**
 * 向上滚动加载更多历史消息
 * @param {Page} page
 * @param {number} scrollCount - 滚动次数
 */
async function scrollUpToLoadHistory(page, scrollCount = 5) {
    const container = page.locator(SELECTORS.messageContainer).first();
    for (let i = 0; i < scrollCount; i++) {
        await container.evaluate(el => el.scrollTop = 0);
        // 仿人类节奏：每次滚动随机等待
        await page.waitForTimeout(1000 + Math.random() * 2000);
    }
}

module.exports = {
    TEAMS_URL,
    SELECTORS,
    isLoginPage,
    waitForMainApp,
    getChatList,
    isGroupChat,
    extractMessages,
    getCurrentChatInfo,
    scrollUpToLoadHistory,
};
