/**
 * lib/microsoft-graph-client.js
 * Microsoft Graph API 客户端
 * 
 * 功能：
 *   - OAuth 2.0 授权码流程（企业账户）
 *   - 设备代码流（个人账户，无需 Azure Portal）
 *   - Token 自动刷新
 *   - 用户信息获取
 *   - 聊天消息获取
 */

'use strict';

const crypto = require('crypto');
const https = require('https');

// Microsoft Graph API 配置
const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

// 从环境变量读取配置
const CLIENT_ID = process.env.MICROSOFT_GRAPH_CLIENT_ID || 'd3590ed6-52b3-4102-aeff-aad2292ab01c'; // 默认使用 Microsoft 公共客户端 ID
const CLIENT_SECRET = process.env.MICROSOFT_GRAPH_CLIENT_SECRET;
const REDIRECT_URI = process.env.MICROSOFT_GRAPH_REDIRECT_URI || 'http://localhost:3000/api/teams/callback';

// 授权模式：'code'（授权码流，个人账户推荐）或 'device'（设备代码流，企业）
const AUTH_MODE = process.env.TEAMS_AUTH_MODE || 'code';

// 账户类型：'common'（企业+个人）或 'consumers'（仅个人）
const ACCOUNT_TYPE = process.env.TEAMS_ACCOUNT_TYPE || 'consumers';

// 权限端点
const AUTHORITY = `https://login.microsoftonline.com/${ACCOUNT_TYPE}`;

// 所需权限 - 个人账户使用 offline_access 来获取 refresh token
const SCOPES = [
    'Chat.Read',
    'Chat.ReadBasic',
    'User.Read',
    'offline_access'  // 用于获取 refresh token
];

/**
 * 生成 PKCE code verifier 和 code challenge
 */
function generatePKCE() {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
}

/**
 * 生成 state 参数防止 CSRF
 */
function generateState() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * 获取授权信息（根据模式返回 URL 或设备代码）
 */
function getAuthInfo(accountName) {
    if (AUTH_MODE === 'device') {
        return getDeviceCode(accountName);
    } else {
        return { mode: 'code', authUrl: getAuthUrl(accountName) };
    }
}

/**
 * 设备代码流：启动设备授权
 */
async function getDeviceCode(accountName) {
    return new Promise((resolve, reject) => {
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            scope: SCOPES.join(' ')
        });
        
        const options = {
            hostname: 'login.microsoftonline.com',
            path: '/common/oauth2/v2.0/devicecode',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': params.toString().length
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.error) {
                        reject(new Error(result.error_description || result.error));
                    } else {
                        // 存储设备代码信息
                        const fs = require('fs');
                        const path = require('path');
                        const tempDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.oauth-temp');
                        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
                        
                        const tempData = {
                            accountName,
                            deviceCode: result.device_code,
                            userCode: result.user_code,
                            verificationUri: result.verification_uri,
                            expiresAt: Date.now() + (result.expires_in * 1000),
                            interval: result.interval || 5
                        };
                        fs.writeFileSync(path.join(tempDir, `device_${accountName}.json`), JSON.stringify(tempData));
                        
                        resolve({
                            mode: 'device',
                            userCode: result.user_code,
                            verificationUri: result.verification_uri,
                            message: result.message,
                            expiresIn: result.expires_in
                        });
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
        
        req.on('error', reject);
        req.write(params.toString());
        req.end();
    });
}

/**
 * 轮询设备代码授权状态
 */
async function pollDeviceCode(accountName) {
    const fs = require('fs');
    const path = require('path');
    const tempDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.oauth-temp');
    const tempFile = path.join(tempDir, `device_${accountName}.json`);
    
    if (!fs.existsSync(tempFile)) {
        throw new Error('Device code not found');
    }
    
    const tempData = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
    
    if (Date.now() > tempData.expiresAt) {
        fs.unlinkSync(tempFile);
        throw new Error('Device code expired');
    }
    
    return new Promise((resolve, reject) => {
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: tempData.deviceCode
        });
        
        const options = {
            hostname: 'login.microsoftonline.com',
            path: '/common/oauth2/v2.0/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': params.toString().length
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.error === 'authorization_pending') {
                        resolve({ pending: true });
                    } else if (result.error === 'authorization_declined') {
                        fs.unlinkSync(tempFile);
                        reject(new Error('Authorization declined by user'));
                    } else if (result.error === 'expired_token') {
                        fs.unlinkSync(tempFile);
                        reject(new Error('Device code expired'));
                    } else if (result.error) {
                        reject(new Error(result.error_description || result.error));
                    } else {
                        // 授权成功
                        fs.unlinkSync(tempFile);
                        resolve({
                            pending: false,
                            accountName,
                            access_token: result.access_token,
                            refresh_token: result.refresh_token,
                            expires_in: result.expires_in,
                            expires_at: Date.now() + result.expires_in * 1000
                        });
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
        
        req.on('error', reject);
        req.write(params.toString());
        req.end();
    });
}

/**
 * 获取 OAuth 授权 URL（授权码流）
 */
function getAuthUrl(accountName) {
    const { codeChallenge, codeVerifier } = generatePKCE();
    const state = generateState();
    
    // 临时存储 code_verifier 和 state（实际应该用 Redis）
    const tempData = {
        accountName,
        codeVerifier,
        state,
        expiresAt: Date.now() + 10 * 60 * 1000 // 10分钟过期
    };
    
    // 存储到临时文件
    const fs = require('fs');
    const path = require('path');
    const tempDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.oauth-temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, `${state}.json`), JSON.stringify(tempData));
    
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        scope: SCOPES.join(' '),
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        response_mode: 'query'
    });
    
    return `${AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * 处理 OAuth 回调，获取 token
 */
async function handleCallback(code, state) {
    const fs = require('fs');
    const path = require('path');
    const tempDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.oauth-temp');
    const tempFile = path.join(tempDir, `${state}.json`);
    
    if (!fs.existsSync(tempFile)) {
        throw new Error('Invalid state or expired');
    }
    
    const tempData = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
    fs.unlinkSync(tempFile); // 清理临时文件
    
    if (Date.now() > tempData.expiresAt) {
        throw new Error('Authorization expired');
    }
    
    // 使用授权码获取 token
    const tokenResponse = await exchangeCodeForToken(code, tempData.codeVerifier);
    
    return {
        accountName: tempData.accountName,
        ...tokenResponse
    };
}

/**
 * 用授权码换取 token
 */
async function exchangeCodeForToken(code, codeVerifier) {
    return new Promise((resolve, reject) => {
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: code,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code',
            code_verifier: codeVerifier
        });
        
        const options = {
            hostname: 'login.microsoftonline.com',
            path: '/common/oauth2/v2.0/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': params.toString().length
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.error) {
                        reject(new Error(result.error_description || result.error));
                    } else {
                        resolve({
                            access_token: result.access_token,
                            refresh_token: result.refresh_token,
                            expires_in: result.expires_in,
                            expires_at: Date.now() + result.expires_in * 1000
                        });
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
        
        req.on('error', reject);
        req.write(params.toString());
        req.end();
    });
}

/**
 * 刷新 access token
 */
async function refreshAccessToken(refreshToken) {
    return new Promise((resolve, reject) => {
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        });
        
        const options = {
            hostname: 'login.microsoftonline.com',
            path: '/common/oauth2/v2.0/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': params.toString().length
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.error) {
                        reject(new Error(result.error_description || result.error));
                    } else {
                        resolve({
                            access_token: result.access_token,
                            refresh_token: result.refresh_token || refreshToken,
                            expires_in: result.expires_in,
                            expires_at: Date.now() + result.expires_in * 1000
                        });
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
        
        req.on('error', reject);
        req.write(params.toString());
        req.end();
    });
}

/**
 * 调用 Microsoft Graph API
 */
async function callGraphAPI(accessToken, endpoint, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint, GRAPH_API_BASE);
        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        };
        
        if (body) {
            options.headers['Content-Length'] = Buffer.byteLength(body);
        }
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 400) {
                        const error = JSON.parse(data);
                        reject(new Error(error.error?.message || `HTTP ${res.statusCode}`));
                    } else {
                        resolve(JSON.parse(data));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
        
        req.on('error', reject);
        
        if (body) {
            req.write(body);
        }
        req.end();
    });
}

/**
 * 获取当前用户信息
 */
async function getUserInfo(accessToken) {
    return await callGraphAPI(accessToken, '/me');
}

/**
 * 获取用户的照片
 */
async function getUserPhoto(accessToken) {
    try {
        return new Promise((resolve, reject) => {
            const url = new URL('/me/photo/$value', GRAPH_API_BASE);
            const options = {
                hostname: url.hostname,
                path: url.pathname,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            };
            
            const req = https.request(options, (res) => {
                if (res.statusCode === 404) {
                    resolve(null); // 没有头像
                    return;
                }
                
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    resolve(Buffer.concat(chunks).toString('base64'));
                });
            });
            
            req.on('error', reject);
            req.end();
        });
    } catch (e) {
        console.warn('[GraphClient] 获取用户头像失败:', e.message);
        return null;
    }
}

/**
 * 获取聊天列表
 */
async function getChats(accessToken) {
    const response = await callGraphAPI(accessToken, '/me/chats');
    return response.value || [];
}

/**
 * 获取聊天消息
 */
async function getChatMessages(accessToken, chatId) {
    const response = await callGraphAPI(accessToken, `/me/chats/${chatId}/messages`);
    return response.value || [];
}

module.exports = {
    getAuthInfo,
    getAuthUrl,
    handleCallback,
    pollDeviceCode,
    refreshAccessToken,
    callGraphAPI,
    getUserInfo,
    getUserPhoto,
    getChats,
    getChatMessages
};
