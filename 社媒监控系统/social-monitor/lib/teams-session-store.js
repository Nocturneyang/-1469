/**
 * lib/teams-session-store.js
 * Teams 账号 Session 存储管理
 * 管理每个 Teams 账号的 Playwright storageState 持久化文件
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * 获取账号的 Profile 目录路径
 * @param {string} accountName
 */
function getProfileDir(accountName) {
    return path.join(ROOT, `teams-profile-${accountName}`);
}

/**
 * 获取账号的 userDataDir 路径（Chromium 持久化 Profile）
 */
function getUserDataDir(accountName) {
    const dir = path.join(getProfileDir(accountName), 'userDataDir');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * 获取 storageState 备份文件路径
 */
function getAuthFilePath(accountName) {
    return path.join(getProfileDir(accountName), 'auth.json');
}

/**
 * 检查账号是否有已保存的 Session
 */
function hasSession(accountName) {
    return fs.existsSync(getAuthFilePath(accountName));
}

/**
 * 保存 Playwright storageState 到本地文件
 * @param {string} accountName
 * @param {object} state  Playwright context.storageState() 返回的对象
 */
function saveSession(accountName, state) {
    const profileDir = getProfileDir(accountName);
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(getAuthFilePath(accountName), JSON.stringify(state, null, 2), 'utf8');
    console.log(`[TeamsSession:${accountName}] Session 已保存`);
}

/**
 * 读取已保存的 storageState
 * @returns {object|null}
 */
function loadSession(accountName) {
    const filePath = getAuthFilePath(accountName);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.warn(`[TeamsSession:${accountName}] Session 文件损坏:`, e.message);
        return null;
    }
}

/**
 * 清除 Session（强制重新登录）
 */
function clearSession(accountName) {
    const filePath = getAuthFilePath(accountName);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[TeamsSession:${accountName}] Session 已清除`);
    }
}

module.exports = {
    getProfileDir,
    getUserDataDir,
    getAuthFilePath,
    hasSession,
    saveSession,
    loadSession,
    clearSession,
};
