const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { db } = require('../db/database');
const { writeEnvKeys } = require('../lib/env-config');
const graphClient = require('../lib/microsoft-graph-client');
const tokenStore = require('../lib/teams-token-store');

function createTeamsRouter({ safeWriteEcosystem }) {
    const router = express.Router();

    // OAuth 授权入口 - 获取授权信息（URL 或设备代码）
    router.get('/auth/:name', async (req, res) => {
        const { name } = req.params;
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
            return res.status(400).json({ success: false, error: 'ID 格式无效' });
        }

        try {
            const authInfo = await graphClient.getAuthInfo(name);
            res.json({ success: true, ...authInfo });
        } catch (e) {
            console.error('[Teams] 获取授权信息失败:', e.message);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // 轮询设备代码授权状态
    router.get('/poll/:name', async (req, res) => {
        const { name } = req.params;
        try {
            const result = await graphClient.pollDeviceCode(name);
            
            if (result.pending) {
                res.json({ success: true, pending: true });
            } else {
                // 授权成功，保存 token
                const { accountName, access_token, refresh_token, expires_at } = result;
                
                // 获取用户信息
                const userInfo = await graphClient.getUserInfo(access_token);
                
                // 保存 token 和用户信息
                tokenStore.saveTokens(accountName, {
                    access_token,
                    refresh_token,
                    expires_at
                }, userInfo);

                // 更新数据库
                const accountKey = `teams-${accountName}`;
                tokenStore.updateAccountInDatabase(accountKey, userInfo);

                res.json({ 
                    success: true, 
                    pending: false,
                    authorized: true,
                    userInfo 
                });
            }
        } catch (e) {
            console.error('[Teams] 轮询设备代码失败:', e.message);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // OAuth 回调处理
    router.get('/callback', async (req, res) => {
        const { code, state, error } = req.query;
        
        if (error) {
            return res.status(400).send(`授权失败: ${error}`);
        }
        
        if (!code || !state) {
            return res.status(400).send('缺少必要参数');
        }

        try {
            // 处理回调，获取 token
            const result = await graphClient.handleCallback(code, state);
            const { accountName, access_token, refresh_token, expires_at } = result;

            // 获取用户信息
            const userInfo = await graphClient.getUserInfo(access_token);
            
            // 保存 token 和用户信息
            tokenStore.saveTokens(accountName, {
                access_token,
                refresh_token,
                expires_at
            }, userInfo);

            // 更新数据库
            const accountKey = `teams-${accountName}`;
            tokenStore.updateAccountInDatabase(accountKey, userInfo);

            // 发送 HTML 响应，关闭窗口
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>授权成功</title>
                    <meta charset="utf-8">
                </head>
                <body>
                    <h1>✅ 授权成功</h1>
                    <p>账号 ${userInfo.displayName || accountName} 已成功授权</p>
                    <p>您可以关闭此窗口了</p>
                    <script>
                        setTimeout(() => {
                            window.close();
                        }, 2000);
                    </script>
                </body>
                </html>
            `);
        } catch (e) {
            console.error('[Teams] OAuth 回调处理失败:', e.message);
            res.status(500).send(`授权处理失败: ${e.message}`);
        }
    });

    // 检查授权状态
    router.get('/status/:name', (req, res) => {
        const { name } = req.params;
        const hasTokens = tokenStore.hasTokens(name);
        
        if (hasTokens) {
            try {
                const userInfo = tokenStore.getUserInfo(name);
                res.json({ 
                    success: true, 
                    authorized: true, 
                    userInfo 
                });
            } catch (e) {
                res.json({ 
                    success: true, 
                    authorized: true, 
                    userInfo: null 
                });
            }
        } else {
            res.json({ 
                success: true, 
                authorized: false 
            });
        }
    });

    // 手动刷新 token
    router.post('/refresh/:name', async (req, res) => {
        const { name } = req.params;
        try {
            const accessToken = await tokenStore.getValidAccessToken(name);
            res.json({ success: true, message: 'Token 刷新成功' });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    router.post('/create', (req, res) => {
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, error: '缺少账号 ID' });
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'ID 只能包含字母、数字、下划线和横线（支持驼峰命名）' });

        const workerName = `worker-teams-${id}`;
        const accountKey = `teams-${id}`;

        try {
            db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status) VALUES (?, 'teams', 'initializing')`).run(accountKey);

            const ecoPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'ecosystem.config.js');
            if (fs.existsSync(ecoPath)) {
                let eco = fs.readFileSync(ecoPath, 'utf8');
                const insertStr = `    {
      name: "${workerName}",
      script: "./workers/worker-teams.js",
      max_memory_restart: '600M',
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production", ACCOUNT_NAME: "${id}" }
    },\n    // --- Web UI Server ---`;
                if (eco.includes('// --- Web UI Server ---') && !eco.includes(workerName)) {
                    eco = eco.replace('// --- Web UI Server ---', insertStr);
                    safeWriteEcosystem(eco);
                }
            }

            exec(`npx pm2 start ./workers/worker-teams.js --name "${workerName}" --max-memory-restart 600M -- --env ACCOUNT_NAME=${id}`, {
                env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', ACCOUNT_NAME: id },
                cwd: path.join(__dirname, '..')
            }, (err, stdout, stderr) => {
                if (err) {
                    console.error('[server] PM2 start teams worker error:', err.message);
                }
            });

            res.json({ success: true, message: `账号 ${accountKey} 已创建，Worker 正在启动，请前往账号管理完成登录` });
        } catch (err) {
            console.error('[server] create-teams error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/chats/:name', (req, res) => {
        const { name } = req.params;
        const chatsCachePath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `teams-profile-${name}`, 'chats-cache.json');
        if (!fs.existsSync(chatsCachePath)) {
            return res.json({ success: true, chats: [], message: '暂无缓存，请确认账号已成功登录' });
        }
        try {
            const chats = JSON.parse(fs.readFileSync(chatsCachePath, 'utf8'));
            res.json({ success: true, chats });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    router.post('/whitelist/:name', (req, res) => {
        const { name } = req.params;
        const { chatIds } = req.body;

        const envKey = `TEAMS_WHITELIST_${name.toUpperCase().replace(/-/g, '_')}`;
        const value = Array.isArray(chatIds) ? chatIds.join(',') : '';

        try {
            writeEnvKeys({ [envKey]: value });
            res.json({ success: true, message: `白名单已设置，共 ${chatIds?.length || 0} 个群聊` });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    router.post('/backfill/:name/start', (req, res) => {
        const { name } = req.params;
        const flagPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `teams-profile-${name}`, 'backfill.flag');
        try {
            const profileDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `teams-profile-${name}`);
            if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
            fs.writeFileSync(flagPath, JSON.stringify({ action: 'start', days: req.body.days || 7, ts: Date.now() }));
            res.json({ success: true, message: '回溯指令已发送，Worker 将在下次轮询时开始回溯' });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    router.post('/backfill/:name/pause', (req, res) => {
        const { name } = req.params;
        const flagPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `teams-profile-${name}`, 'backfill.flag');
        try {
            fs.writeFileSync(flagPath, JSON.stringify({ action: 'pause', ts: Date.now() }));
            res.json({ success: true, message: '回溯已暂停' });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    router.post('/relogin/:name', async (req, res) => {
        const { name } = req.params;
        try {
            // 清除 OAuth token
            tokenStore.clearTokens(name);
            
            // 清除旧的 Playwright session（如果存在）
            const sessionStore = require('../lib/teams-session-store');
            sessionStore.clearSession(name);
            
            // 重启 worker
            exec(`npx pm2 restart worker-teams-${name}`, { cwd: path.join(__dirname, '..') }, () => {});
            
            res.json({ success: true, message: 'Token 已清除，请重新授权' });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    return router;
}

module.exports = createTeamsRouter;
