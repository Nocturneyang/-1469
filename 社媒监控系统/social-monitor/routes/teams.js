const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { db } = require('../db/database');
const { writeEnvKeys } = require('../lib/env-config');

function createTeamsRouter({ safeWriteEcosystem }) {
    const router = express.Router();

    router.post('/create', (req, res) => {
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, error: '缺少账号 ID' });
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'ID 只能包含字母、数字、下划线和横线' });

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
            const sessionStore = require('../lib/teams-session-store');
            sessionStore.clearSession(name);
            exec(`npx pm2 restart worker-teams-${name}`, { cwd: path.join(__dirname, '..') }, () => {});
            res.json({ success: true, message: 'Session 已清除，Worker 重启中，请准备完成 Teams 登录' });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    return router;
}

module.exports = createTeamsRouter;
