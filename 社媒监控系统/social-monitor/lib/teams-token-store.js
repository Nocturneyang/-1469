/**
 * lib/teams-token-store.js
 * Teams OAuth Token 存储管理
 * 
 * 功能：
 *   - Token 加密存储
 *   - Token 自动刷新
 *   - 用户信息缓存
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('../db/database');
const graphClient = require('./microsoft-graph-client');

const ROOT = process.env.DATA_DIR || path.join(__dirname, '..');

// 加密密钥（从环境变量读取，实际应该使用更安全的密钥管理）
const ENCRYPTION_KEY = process.env.TEAMS_TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;

/**
 * 加密数据
 */
function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = crypto.pbkdf2Sync(ENCRYPTION_KEY, salt, 100000, 32, 'sha256');
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    
    // 组合: salt + iv + authTag + encrypted
    return Buffer.concat([salt, iv, authTag, Buffer.from(encrypted, 'hex')]).toString('base64');
}

/**
 * 解密数据
 */
function decrypt(encryptedData) {
    const buffer = Buffer.from(encryptedData, 'base64');
    const salt = buffer.slice(0, SALT_LENGTH);
    const iv = buffer.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const authTag = buffer.slice(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const encrypted = buffer.slice(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    
    const key = crypto.pbkdf2Sync(ENCRYPTION_KEY, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
}

/**
 * 获取账号的 token 存储路径
 */
function getTokenFilePath(accountName) {
    return path.join(ROOT, `teams-profile-${accountName}`, 'tokens.json');
}

/**
 * 保存 token 和用户信息
 */
function saveTokens(accountName, tokenData, userInfo = null) {
    const profileDir = path.join(ROOT, `teams-profile-${accountName}`);
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    
    const data = {
        access_token: encrypt(tokenData.access_token),
        refresh_token: encrypt(tokenData.refresh_token),
        expires_at: tokenData.expires_at,
        user_info: userInfo
    };
    
    fs.writeFileSync(getTokenFilePath(accountName), JSON.stringify(data, null, 2), 'utf8');
    console.log(`[TeamsTokenStore:${accountName}] Token 已保存`);
}

/**
 * 读取 token
 */
function loadTokens(accountName) {
    const filePath = getTokenFilePath(accountName);
    if (!fs.existsSync(filePath)) return null;
    
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return {
            access_token: decrypt(data.access_token),
            refresh_token: decrypt(data.refresh_token),
            expires_at: data.expires_at,
            user_info: data.user_info
        };
    } catch (e) {
        console.warn(`[TeamsTokenStore:${accountName}] Token 文件损坏:`, e.message);
        return null;
    }
}

/**
 * 检查 token 是否即将过期（提前5分钟）
 */
function isTokenExpiringSoon(expiresAt) {
    const now = Date.now();
    const buffer = 5 * 60 * 1000; // 5分钟缓冲
    return expiresAt - now < buffer;
}

/**
 * 获取有效的 access token（自动刷新）
 */
async function getValidAccessToken(accountName) {
    const tokens = loadTokens(accountName);
    if (!tokens) {
        throw new Error('No tokens found for account');
    }
    
    // 检查是否需要刷新
    if (isTokenExpiringSoon(tokens.expires_at)) {
        console.log(`[TeamsTokenStore:${accountName}] Token 即将过期，开始刷新...`);
        try {
            const newTokens = await graphClient.refreshAccessToken(tokens.refresh_token);
            // 保留用户信息
            saveTokens(accountName, newTokens, tokens.user_info);
            return newTokens.access_token;
        } catch (e) {
            console.error(`[TeamsTokenStore:${accountName}] Token 刷新失败:`, e.message);
            throw new Error('Token refresh failed, re-authentication required');
        }
    }
    
    return tokens.access_token;
}

/**
 * 获取用户信息（从缓存或 API）
 */
async function getUserInfo(accountName) {
    const tokens = loadTokens(accountName);
    if (!tokens || !tokens.user_info) {
        throw new Error('No user info found');
    }
    return tokens.user_info;
}

/**
 * 更新用户信息
 */
function updateUserInfo(accountName, userInfo) {
    const tokens = loadTokens(accountName);
    if (tokens) {
        saveTokens(accountName, tokens, userInfo);
    }
}

/**
 * 清除 token（强制重新授权）
 */
function clearTokens(accountName) {
    const filePath = getTokenFilePath(accountName);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[TeamsTokenStore:${accountName}] Token 已清除`);
    }
}

/**
 * 检查账号是否有已保存的 token
 */
function hasTokens(accountName) {
    return fs.existsSync(getTokenFilePath(accountName));
}

/**
 * 更新数据库中的账号状态和用户信息
 */
function updateAccountInDatabase(accountKey, userInfo) {
    try {
        const stmt = db.prepare(`
            UPDATE accounts 
            SET user_id = ?, 
                email = ?, 
                display_name = ?, 
                avatar_url = ?,
                status = 'authenticated'
            WHERE id = ?
        `);
        stmt.run(
            userInfo.id || null,
            userInfo.mail || userInfo.userPrincipalName || null,
            userInfo.displayName || accountKey,
            null, // 头像 URL 可以后续添加
            accountKey
        );
        console.log(`[TeamsTokenStore] 数据库已更新: ${accountKey}`);
    } catch (e) {
        console.error(`[TeamsTokenStore] 更新数据库失败:`, e.message);
    }
}

module.exports = {
    saveTokens,
    loadTokens,
    getValidAccessToken,
    getUserInfo,
    updateUserInfo,
    clearTokens,
    hasTokens,
    updateAccountInDatabase
};
