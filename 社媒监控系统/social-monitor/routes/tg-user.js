const express = require('express');
const path = require('path');
const fs = require('fs');
const { db } = require('../db/database');
const { readEnvFile, writeEnvKeys } = require('../lib/env-config');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { getSession, saveSession, revokeSession, getSessionStatus, getRateLimit, saveRateLimit } = require('../lib/tg-session-store');
const { getTasks, pauseTasks, resumeTasks, resetTask } = require('../lib/tg-backfill-queue');

function createTgUserRouter({ safeWriteEcosystem }) {
    const router = express.Router();

    const loginSessions = new Map();
    const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

    function cleanupLoginSession(accountName) {
        const s = loginSessions.get(accountName);
        if (s) {
            try { s.client.disconnect(); } catch (_) {}
            loginSessions.delete(accountName);
        }
    }

    setInterval(() => {
        const now = Date.now();
        for (const [name, s] of loginSessions.entries()) {
            if (s.expireAt < now) {
                console.log(`[TGUser API] Login session expired for: ${name}`);
                cleanupLoginSession(name);
            }
        }
    }, 30000);

    router.post('/start-login', async (req, res) => {
        const { account_name, phone, api_id, api_hash } = req.body;
        if (!account_name || !phone || !api_id || !api_hash) {
            return res.status(400).json({ success: false, error: '缺少必填参数: account_name, phone, api_id, api_hash' });
        }

        cleanupLoginSession(account_name);

        try {
            const session = new StringSession('');
            const client = new TelegramClient(session, parseInt(api_id, 10), api_hash, {
                connectionRetries: 3,
                testServers: process.env.TG_USE_TEST_SERVERS === 'true'
            });
            await client.connect();

            const result = await client.sendCode({ apiId: parseInt(api_id, 10), apiHash: api_hash }, phone);
            const phoneCodeHash = result.phoneCodeHash;

            loginSessions.set(account_name, {
                client,
                phoneCodeHash,
                phone,
                api_id,
                api_hash,
                expireAt: Date.now() + LOGIN_TIMEOUT_MS
            });

            db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status, updated_at) VALUES (?, 'telegram', 'logging_in', datetime('now'))`).run(`tgu-${account_name}`);

            res.json({ success: true, message: '验证码已发送到手机', status: 'logging_in' });
        } catch (err) {
            console.error('[TGUser API] start-login error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/verify-code', async (req, res) => {
        const { account_name, code } = req.body;
        if (!account_name || !code) {
            return res.status(400).json({ success: false, error: '缺少 account_name 或 code' });
        }

        const s = loginSessions.get(account_name);
        if (!s) {
            return res.status(400).json({ success: false, error: '登录会话不存在或已过期，请重新发起登录' });
        }

        try {
            await s.client.invoke(
                new (require('telegram').Api.auth.SignIn)({
                    phoneNumber: s.phone,
                    phoneCodeHash: s.phoneCodeHash,
                    phoneCode: code
                })
            );

            const sessionString = s.client.session.save();
            saveSession(account_name, sessionString);
            db.prepare(`UPDATE accounts SET status='authenticated', updated_at=datetime('now') WHERE id=?`).run(`tgu-${account_name}`);
            
            global[`tgu_client_${account_name}`] = s.client;

            res.json({ success: true, message: '登录成功！Session 已保存。', status: 'authenticated' });
        } catch (err) {
            const errName = err.constructor?.name || '';
            if (errName.includes('SessionPasswordNeeded') || err.message?.includes('SESSION_PASSWORD_NEEDED')) {
                s.expireAt = Date.now() + LOGIN_TIMEOUT_MS;
                db.prepare(`UPDATE accounts SET status='need_2fa', updated_at=datetime('now') WHERE id=?`).run(`tgu-${account_name}`);
                return res.json({ success: true, need2fa: true, status: 'need_2fa', message: '需要输入两步验证密码' });
            }
            console.error('[TGUser API] verify-code error:', err.message);
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.post('/verify-2fa', async (req, res) => {
        const { account_name, password } = req.body;
        if (!account_name || !password) {
            return res.status(400).json({ success: false, error: '缺少 account_name 或 password' });
        }

        const s = loginSessions.get(account_name);
        if (!s) {
            return res.status(400).json({ success: false, error: '登录会话不存在或已过期' });
        }

        try {
            const { computeCheck } = require('telegram/Password');
            const { Api } = require('telegram');
            await s.client.invoke(
                new Api.auth.CheckPassword({
                    password: await computeCheck(
                        await s.client.invoke(new Api.account.GetPassword()),
                        password
                    )
                })
            );

            const sessionString = s.client.session.save();
            saveSession(account_name, sessionString);
            db.prepare(`UPDATE accounts SET status='authenticated', updated_at=datetime('now') WHERE id=?`).run(`tgu-${account_name}`);
            
            global[`tgu_client_${account_name}`] = s.client;

            res.json({ success: true, message: '2FA 验证成功！Session 已保存。', status: 'authenticated' });
        } catch (err) {
            console.error('[TGUser API] verify-2fa error:', err.message);
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.get('/dialogs/:name', async (req, res) => {
        const { name } = req.params;
        let client = global[`tgu_client_${name}`];
        let isTemp = false;

        if (!client) {
            const sessionStr = getSession(name);
            if (!sessionStr) return res.status(400).json({ success: false, error: '无此账号的登录状态，请先登录' });

            const accountKey = name.toUpperCase().replace(/-/g, '_');
            const envMap = readEnvFile();
            const apiId = parseInt(
                process.env[`TG_API_ID_${accountKey}`] ||
                envMap[`TG_API_ID_${accountKey}`] ||
                process.env.TG_API_ID || '0', 10
            );
            const apiHash =
                process.env[`TG_API_HASH_${accountKey}`] ||
                envMap[`TG_API_HASH_${accountKey}`] ||
                process.env.TG_API_HASH || '';

            if (!apiId || !apiHash) {
                return res.status(400).json({ success: false, error: '未能找到 API ID/Hash，请在 .env 中配置 TG_API_ID_${ACCOUNT_NAME} 和 TG_API_HASH_${ACCOUNT_NAME}' });
            }

            try {
                const { TelegramClient } = require('telegram');
                const { StringSession } = require('telegram/sessions');
                const useTest = process.env.TG_USE_TEST_SERVERS === 'true';
                client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
                    connectionRetries: 1,
                    testServers: useTest,
                    useWSS: false
                });
                await client.connect();
                isTemp = true;
            } catch (e) {
                return res.status(500).json({ success: false, error: '临时连接失败：' + e.message });
            }
        }

        try {
            const dialogs = await client.getDialogs({ limit: 150 });
            const list = dialogs.map(d => {
                const entity = d.entity;
                if (!entity || !['Chat', 'Channel'].includes(entity.className)) return null;
                return {
                    id: String(entity.id),
                    title: entity.title || String(entity.id)
                };
            }).filter(Boolean);
            
            const wlEnv = process.env[`TG_WHITELIST_${name.toUpperCase()}`];
            let whitelist = null;
            if (wlEnv !== undefined) {
                 whitelist = wlEnv ? wlEnv.split(',') : [];
            }

            res.json({ success: true, data: list, whitelist });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        } finally {
            if (isTemp && client) {
                await client.disconnect();
            }
        }
    });

    router.post('/whitelist/:name', (req, res) => {
        const { name } = req.params;
        const { mode, whitelist } = req.body;
        try {
            const key = `TG_WHITELIST_${name.toUpperCase()}`;
            if (mode === 'all') {
                writeEnvKeys({ [key]: '' });
                delete process.env[key];
            } else {
                const val = Array.isArray(whitelist) ? whitelist.join(',') : '';
                writeEnvKeys({ [key]: val });
                process.env[key] = val;
            }
            
            cleanupLoginSession(name);
            global[`tgu_logged_in_${name}`] = true;
            const statusFilePath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `db/.tgu_status_${name}.json`);
            try {
                fs.writeFileSync(statusFilePath, JSON.stringify({ status: 'login_complete', account: name, updated_at: Date.now() }), 'utf8');
            } catch (_) { }

            res.json({ success: true, message: '配置保存成功，系统已启动监控' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/status/:name', (req, res) => {
        const { name } = req.params;
        try {
            const sessionStatus = getSessionStatus(name);
            const dbAccount = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(`tgu-${name}`);
            const statusFilePath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `db/.tgu_status_${name}.json`);
            let runtimeStatus = null;
            if (fs.existsSync(statusFilePath)) {
                try { runtimeStatus = JSON.parse(fs.readFileSync(statusFilePath, 'utf8')); } catch (_) {}
            }
            res.json({
                success: true,
                account_name: name,
                session: sessionStatus,
                db_status: dbAccount?.status || 'unknown',
                runtime: runtimeStatus
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/config/:name', (req, res) => {
        const { name } = req.params;
        const workerName = `worker-tgu-${name}`;
        
        const { exec } = require('child_process');
        exec('npx pm2 jlist', (err, stdout) => {
            let apiId = '';
            let apiHash = '';
            
            try {
                if (!err && stdout) {
                    const list = JSON.parse(stdout);
                    const app = list.find(x => x.name === workerName);
                    if (app && app.pm2_env) {
                        const accountKey = name.toUpperCase().replace(/-/g, '_');
                        apiId = app.pm2_env[`TG_API_ID_${accountKey}`] || app.pm2_env.TG_API_ID || '';
                        apiHash = app.pm2_env[`TG_API_HASH_${accountKey}`] || app.pm2_env.TG_API_HASH || '';
                    }
                }
            } catch (jsonErr) {
                console.error('[TGUser API] Failed to parse pm2 jlist:', jsonErr.message);
            }
            
            // 兜底：如果 PM2 未查询到，从环境及 .env 文件中加载
            if (!apiId || !apiHash) {
                const accountKey = name.toUpperCase().replace(/-/g, '_');
                const envMap = readEnvFile();
                apiId = apiId || process.env[`TG_API_ID_${accountKey}`] || envMap[`TG_API_ID_${accountKey}`] || process.env.TG_API_ID || '';
                apiHash = apiHash || process.env[`TG_API_HASH_${accountKey}`] || envMap[`TG_API_HASH_${accountKey}`] || process.env.TG_API_HASH || '';
            }
            
            res.json({
                success: true,
                account_name: name,
                api_id: apiId,
                api_hash: apiHash
            });
        });
    });

    router.post('/revoke/:name', (req, res) => {
        const { name } = req.params;
        try {
            revokeSession(name);
            cleanupLoginSession(name);
            db.prepare(`UPDATE accounts SET status='idle', updated_at=datetime('now') WHERE id=?`).run(`tgu-${name}`);

            const { exec } = require('child_process');
            exec(`npx pm2 delete worker-tgu-${name}`, () => {
                exec('npx pm2 save');
            });

            res.json({ success: true, message: `Session 已撤销，进程已停止: tgu-${name}` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/ratelimit/:name', (req, res) => {
        try {
            const cfg = getRateLimit(req.params.name);
            res.json({ success: true, data: cfg });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/ratelimit/:name', (req, res) => {
        const allowed = ['warmup_seconds', 'daily_limit', 'batch_size', 'sleep_min_ms', 'sleep_max_ms', 'backfill_days', 'enable_backfill'];
        try {
            const updates = {};
            for (const key of allowed) {
                if (req.body[key] !== undefined) updates[key] = req.body[key];
            }
            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ success: false, error: '没有提供任何有效配置项' });
            }
            saveRateLimit(req.params.name, updates);
            res.json({ success: true, message: '频控配置已保存', data: getRateLimit(req.params.name) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/backfill/:name', (req, res) => {
        try {
            const tasks = getTasks(req.params.name);
            res.json({ success: true, data: tasks });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/backfill/:name/pause', (req, res) => {
        try {
            pauseTasks(req.params.name);
            res.json({ success: true, message: `已暂停 ${req.params.name} 的历史回溯` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/backfill/:name/resume', (req, res) => {
        try {
            resumeTasks(req.params.name);
            res.json({ success: true, message: `已恢复 ${req.params.name} 的历史回溯` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/backfill/:name/reset', (req, res) => {
        const { chat_id } = req.body;
        if (!chat_id) return res.status(400).json({ success: false, error: '缺少 chat_id' });
        try {
            resetTask(req.params.name, chat_id);
            res.json({ success: true, message: `已重置群 ${chat_id} 的回溯进度` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // create-tg-user 挂在 /api/accounts 前缀下，由 server.js 挂载
    router.post('/create', (req, res) => {
        const { id, api_id, api_hash, warmup_seconds, daily_limit, batch_size,
                sleep_min_ms, sleep_max_ms, backfill_days, enable_backfill } = req.body;

        if (!id || !api_id || !api_hash) {
            return res.status(400).json({ success: false, error: '缺少必填参数: id, api_id, api_hash' });
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
            return res.status(400).json({ success: false, error: 'ID 只允许英文数字下划线中划线（支持驼峰命名）' });
        }

        try {
            const workerName = `worker-tgu-${id}`;
            const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');
            const accountKey = id.toUpperCase().replace(/-/g, '_');
            const cfg = {
                warmup_seconds: warmup_seconds || 600,
                daily_limit: daily_limit || 2000,
                batch_size: batch_size || 100,
                sleep_min_ms: sleep_min_ms || 3000,
                sleep_max_ms: sleep_max_ms || 8000,
                backfill_days: backfill_days !== undefined ? backfill_days : 7,
                enable_backfill: enable_backfill !== undefined ? enable_backfill : true
            };

            writeEnvKeys({
                [`TG_API_ID_${accountKey}`]: String(api_id),
                [`TG_API_HASH_${accountKey}`]: api_hash
            });
            saveRateLimit(id, cfg);

            const ecoPath = path.join(dataDir, 'ecosystem.config.js');
            if (fs.existsSync(ecoPath)) {
                let eco = fs.readFileSync(ecoPath, 'utf8');
                if (!eco.includes(workerName)) {
                    const insertStr = `    {
      name: "${workerName}",
      script: "./workers/worker-tg-user.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: "production",
        DATA_DIR: ${JSON.stringify(dataDir)},
        TG_ACCOUNT_NAME: "${id}",
        TG_WARMUP_SECONDS: "${cfg.warmup_seconds}",
        TG_DAILY_LIMIT: "${cfg.daily_limit}",
        TG_BATCH_SIZE: "${cfg.batch_size}",
        TG_SLEEP_MIN_MS: "${cfg.sleep_min_ms}",
        TG_SLEEP_MAX_MS: "${cfg.sleep_max_ms}",
        TG_BACKFILL_DAYS: "${cfg.backfill_days}",
        TG_ENABLE_BACKFILL: "${cfg.enable_backfill}"
      }
    },\n    // --- Web UI Server ---`;
                    eco = eco.replace('// --- Web UI Server ---', insertStr);
                    safeWriteEcosystem(eco);
                }
            }

            db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status, updated_at) VALUES (?, 'telegram', 'idle', datetime('now'))`).run(`tgu-${id}`);

            const { spawn, exec } = require('child_process');
            const spawnEnv = {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                NODE_ENV: 'production',
                DATA_DIR: dataDir,
                TG_ACCOUNT_NAME: id,
                [`TG_API_ID_${accountKey}`]: String(api_id),
                [`TG_API_HASH_${accountKey}`]: api_hash,
                TG_WARMUP_SECONDS: String(cfg.warmup_seconds),
                TG_DAILY_LIMIT: String(cfg.daily_limit),
                TG_BATCH_SIZE: String(cfg.batch_size),
                TG_SLEEP_MIN_MS: String(cfg.sleep_min_ms),
                TG_SLEEP_MAX_MS: String(cfg.sleep_max_ms),
                TG_BACKFILL_DAYS: String(cfg.backfill_days),
                TG_ENABLE_BACKFILL: String(cfg.enable_backfill)
            };
            const pm2 = spawn('npx', ['pm2', 'start', './workers/worker-tg-user.js', '--name', workerName], {
                env: spawnEnv,
                stdio: 'inherit'
            });
            pm2.on('close', () => exec('npx pm2 save'));

            res.json({ success: true, message: `TG 用户账号 tgu-${id} 创建成功，请调用 /api/tg-user/start-login 发起登录` });
        } catch (err) {
            console.error('[TGUser API] create-tg-user error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
}

module.exports = createTgUserRouter;
