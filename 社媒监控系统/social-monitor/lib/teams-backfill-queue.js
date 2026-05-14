/**
 * lib/teams-backfill-queue.js
 * Teams 手动历史回溯队列
 * 
 * 与 TG 的回溯队列逻辑对齐：
 *   - 通过 flag 文件接收回溯指令（server.js 写入，Worker 轮询读取）
 *   - 支持 start / pause 两种指令
 *   - 回溯完成后自动清除 flag 文件
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 检查是否有待处理的回溯指令
 * @param {string} accountName
 * @returns {{ action: 'start'|'pause'|null, days: number }}
 */
function checkBackfillFlag(accountName) {
    const flagPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `teams-profile-${accountName}`, 'backfill.flag');
    if (!fs.existsSync(flagPath)) return { action: null, days: 0 };
    
    try {
        const data = JSON.parse(fs.readFileSync(flagPath, 'utf8'));
        return { action: data.action || null, days: data.days || 7 };
    } catch {
        return { action: null, days: 0 };
    }
}

/**
 * 清除回溯 flag（回溯完成或被取消时调用）
 * @param {string} accountName
 */
function clearBackfillFlag(accountName) {
    const flagPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `teams-profile-${accountName}`, 'backfill.flag');
    if (fs.existsSync(flagPath)) {
        try { fs.unlinkSync(flagPath); } catch {}
    }
}

/**
 * 写入回溯状态到状态文件，供 API 查询
 * @param {string} accountName
 * @param {object} status
 */
function writeBackfillStatus(accountName, status) {
    const statusPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `teams-profile-${accountName}`, 'backfill-status.json');
    try {
        const dir = path.dirname(statusPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(statusPath, JSON.stringify({
            ...status,
            updatedAt: new Date().toISOString()
        }), 'utf8');
    } catch {}
}

/**
 * 读取回溯状态
 */
function readBackfillStatus(accountName) {
    const statusPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `teams-profile-${accountName}`, 'backfill-status.json');
    if (!fs.existsSync(statusPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * 缓存发现的群聊列表，供 UI 白名单选择使用
 * @param {string} accountName
 * @param {Array<{chatId, name}>} chats
 */
function cacheChats(accountName, chats) {
    const cachePath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `teams-profile-${accountName}`, 'chats-cache.json');
    try {
        const dir = path.dirname(cachePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(chats), 'utf8');
    } catch {}
}

module.exports = {
    checkBackfillFlag,
    clearBackfillFlag,
    writeBackfillStatus,
    readBackfillStatus,
    cacheChats,
};
