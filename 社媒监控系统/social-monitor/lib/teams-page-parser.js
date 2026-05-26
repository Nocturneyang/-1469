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
    
    // 用户信息
    userProfileButton: '[data-tid="me-avatar"], [aria-label="My profile"], .ts-avatar',
    userDisplayName: '[data-tid="me-display-name"], .me-display-name',
    userEmail: '[data-tid="me-email"], .me-email',
    
    // 左侧 Chat 列表
    chatList: '[data-tid="chat-list"], [aria-label="Chat list"], [data-tid="left-rail-chat-button"], [role="list"], [role="tree"]',
    chatItem: '[data-tid="chat-pane-item"], [data-tid="chat-item"], [role="listitem"], [role="treeitem"]',
    chatItemName: '[data-tid="chat-pane-item-title"], .chat-title, [data-tid="name"], [dir="auto"]',
    
    // 聊天内容区
    messageContainer: '[data-tid="message-pane"], [role="main"]',
    messageItem: '[data-tid^="message-id-"], [data-tid="chat-compose-box"] ~ * [role="article"], [role="article"], [data-tid*="message"]',
    messageBody: '[data-tid="message-body-text"], .message-body, [data-tid="messageBody"], [dir="auto"]',
    messageAuthor: '[data-tid="author"], [data-tid="message-author"], [data-tid*="author"]',
    messageTimestamp: '[data-tid="message-timestamp"], time',
    
    // 媒体消息
    attachmentItem: '[data-tid="attachment"], [data-tid="file-attachment"]',
    imageItem: 'img[data-tid="messageImage"], img[data-tid="image-content"]',
    videoItem: 'video, [data-tid="video-attachment"]',
    
    // 群聊标识（用于区分群聊和个人聊天）
    groupChatIndicator: '[data-tid="group-header"], [aria-label*="group"], [aria-label*="群"], [aria-label*="成员"]',
    chatMemberCount: '[data-tid="member-count"], [data-tid="participant-count"], [aria-label*="participant"], [aria-label*="成员"]',
    
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

        let items = page.locator(SELECTORS.chatItem);
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
        if (chats.length === 0) {
            const fallbackChats = await page.evaluate(() => {
                const seen = new Set();
                return Array.from(document.querySelectorAll('button, [role="button"], [role="listitem"], [role="treeitem"], a, div[tabindex]'))
                    .map((el, index) => {
                        const rect = el.getBoundingClientRect();
                        const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
                        return { index, text, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                    })
                    .filter(item => {
                        if (!item.text || item.text.length > 200) return false;
                        if (item.x > 360 || item.y < 60 || item.height < 24 || item.height > 120) return false;
                        const key = item.text.split('\n').slice(0, 2).join('|');
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    })
                    .map((item, index) => {
                        const lines = item.text.split('\n').map(s => s.trim()).filter(Boolean);
                        const name = lines.find(line => !/^\d{1,2}:\d{2}$/.test(line) && !/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(line)) || lines[0];
                        return { chatId: `chat_${index}`, name, index: item.index };
                    });
            });
            chats.push(...fallbackChats);
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
        if (await groupIndicator.count() > 0) return true;
        return await page.evaluate(() => {
            const text = document.body.innerText || '';
            return /(?:^|\D)([3-9]|[1-9]\d+)\s*(?:人|位成员|members?|participants?)(?:\D|$)/i.test(text);
        });
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
                if (/@media|::highlight|SpellingSquiggle|GrammarSquiggle|data:image\/svg/i.test(content)) continue;

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

async function clickChat(page, chat) {
    const items = page.locator(SELECTORS.chatItem);
    const item = items.nth(chat.index);
    if (await item.count() > 0 && await item.isVisible().catch(() => false)) {
        await item.click();
        return true;
    }
    const clicked = await page.evaluate((chatName) => {
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="listitem"], [role="treeitem"], a, div[tabindex]'));
        const target = candidates.find(el => {
            const rect = el.getBoundingClientRect();
            const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
            return rect.x <= 360 && rect.y >= 60 && rect.height >= 24 && text.includes(chatName);
        });
        if (!target) return false;
        target.click();
        return true;
    }, chat.name);
    return clicked;
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

/**
 * 获取当前登录用户信息
 * @param {Page} page
 * @returns {Promise<{displayName: string, email: string}>}
 */
async function getUserInfo(page) {
    try {
        // 尝试从页面标题获取显示名称
        const title = await page.title();
        const displayName = title.replace(' | Microsoft Teams', '').trim();
        
        // 尝试点击用户头像获取更多信息
        const profileButton = page.locator(SELECTORS.userProfileButton).first();
        let email = null;
        
        if (await profileButton.count() > 0) {
            await profileButton.click();
            await page.waitForTimeout(1000);
            
            // 尝试获取邮箱
            const emailEl = page.locator(SELECTORS.userEmail).first();
            if (await emailEl.count() > 0) {
                email = (await emailEl.textContent() || '').trim();
            }
            
            // 关闭弹窗
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
        }
        
        return {
            displayName,
            email,
            id: null // Playwright 方案无法获取稳定的用户 ID
        };
    } catch (e) {
        console.error('[TeamsParser] 获取用户信息失败:', e.message);
        return {
            displayName: 'Unknown',
            email: null,
            id: null
        };
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
    clickChat,
    scrollUpToLoadHistory,
    getUserInfo,
};
