const express = require('express');
const cors = require('cors');
const path = require('path');
const { db } = require('./db/database');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── 复用 analytics DB 只读连接 ────────────────────────────────
const ANALYTICS_PATH = path.join(__dirname, 'db', 'analytics.sqlite');
let _analyticsDb = null;
function getAnalyticsDb() {
    if (_analyticsDb) return _analyticsDb;
    if (!fs.existsSync(ANALYTICS_PATH)) return null;
    try {
        const Database = require('better-sqlite3');
        _analyticsDb = new Database(ANALYTICS_PATH, { readonly: true });
        return _analyticsDb;
    } catch (e) {
        console.error('[server] 无法打开 analytics.sqlite:', e.message);
        return null;
    }
}

app.use(cors());
app.use(express.json());

// Serve static UI files
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}
app.use(express.static(publicDir));

// Serve media files route
app.use('/media', express.static(path.join(__dirname, 'media')));

// API: Get Stats
app.get('/api/stats', (req, res) => {
    try {
        const totalRows = db.prepare(`SELECT COUNT(*) as count FROM messages`).get().count;
        const waRows = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE platform = 'whatsapp'`).get().count;
        const tgRows = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE platform = 'telegram'`).get().count;
        const mediaRows = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE has_media = 1`).get().count;
        
        res.json({
            success: true,
            total: totalRows,
            platforms: {
                whatsapp: waRows,
                telegram: tgRows
            },
            withMedia: mediaRows
        });
    } catch (err) {
        console.error('Stats DB Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Get Recent Messages
app.get('/api/messages', (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        
        const platformFilter = req.query.platform; // optional 'all', 'whatsapp', 'telegram'
        
        let query = `SELECT * FROM messages`;
        let countQuery = `SELECT COUNT(*) as count FROM messages`;
        let params = [];
        
        if (platformFilter && platformFilter !== 'all') {
            if (platformFilter === 'telegram_user') {
                query += ` WHERE platform = 'telegram' AND receiver_account LIKE 'tgu-%'`;
                countQuery += ` WHERE platform = 'telegram' AND receiver_account LIKE 'tgu-%'`;
            } else {
                query += ` WHERE platform = ?`;
                countQuery += ` WHERE platform = ?`;
                params.push(platformFilter);
            }
        }
        
        query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
        
        const total = db.prepare(countQuery).get(...params).count;
        const messages = db.prepare(query).all(...params, limit, offset);
        
        res.json({
            success: true,
            total,
            page,
            pages: Math.ceil(total / limit),
            data: messages
        });
    } catch (err) {
        console.error('Messages DB Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Get Accounts
app.get('/api/accounts', (req, res) => {
    try {
        const accounts = db.prepare(`SELECT * FROM accounts ORDER BY updated_at DESC`).all();
        res.json({ success: true, data: accounts });
    } catch (err) {
        console.error('Accounts DB Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Logout/Delete Account
app.post('/api/accounts/logout', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'Missing account id' });
    if (!/^(wa|tg|tgu)-[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'Invalid account id format' });
    
    try {
        if (id.startsWith('wa-')) {
            const accName = id.replace('wa-', '');
            // update status
            db.prepare(`UPDATE accounts SET status = 'disconnected', qr_code = NULL WHERE id = ?`).run(id);
            // clear session folder if needed, pm2 handles restart mapping
            const sessionPath = path.join(__dirname, `whatsapp-session-${accName}`);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
            
            // To properly log out, we can restart the PM2 worker to pick up the cleared session
            const { exec } = require('child_process');
            exec(`npx pm2 restart worker-wa-${accName}`, (error) => {
                if(error) console.log('Notice: Could not restart PM2 via API.', error.message);
            });
        }
        res.json({ success: true, message: 'Logged out. Account is resetting.' });
    } catch (err) {
        console.error('Logout Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Relogin/Restart Account
app.post('/api/accounts/relogin', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'Missing account id' });
    if (!/^(wa|tg|tgu|teams)-[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'Invalid account id format' });
    
    try {
        let workerName = '';
        let accName = '';
        if (id.startsWith('wa-')) {
            accName = id.replace('wa-', '');
            workerName = `worker-wa-${accName}`;
        } else if (id.startsWith('tg-')) {
            accName = id.replace('tg-', '');
            workerName = `worker-tg-${accName}`;
        } else if (id.startsWith('tgu-')) {
            accName = id.replace('tgu-', '');
            workerName = `worker-tgu-${accName}`;
        } else if (id.startsWith('teams-')) {
            accName = id.replace('teams-', '');
            workerName = `worker-teams-${accName}`;
        } else {
            return res.status(400).json({ success: false, error: 'Invalid account id prefix' });
        }
        
        db.prepare(`UPDATE accounts SET status = 'initializing' WHERE id = ?`).run(id);
        
        const { exec } = require('child_process');
        exec(`npx pm2 restart ${workerName}`, (error) => {
            if(error) console.log(`Notice: Could not restart PM2 ${workerName}.`, error.message);
        });
        
        res.json({ success: true, message: 'Restart command sent. Account is initializing.' });
    } catch (err) {
        console.error('Relogin Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Delete Account Permanently
app.delete('/api/accounts/:id', (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: 'Missing account id' });
    if (!/^(wa|tg|tgu|teams)-[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'Invalid account id format' });
    
    try {
        let workerName = '';
        let accName = '';
        if (id.startsWith('wa-')) {
            accName = id.replace('wa-', '');
            workerName = `worker-wa-${accName}`;
        } else if (id.startsWith('tg-')) {
            accName = id.replace('tg-', '');
            workerName = `worker-tg-${accName}`;
        } else if (id.startsWith('tgu-')) {
            accName = id.replace('tgu-', '');
            workerName = `worker-tgu-${accName}`;
        } else if (id.startsWith('teams-')) {
            accName = id.replace('teams-', '');
            workerName = `worker-teams-${accName}`;
        } else {
            return res.status(400).json({ success: false, error: 'Invalid account id prefix' });
        }

        // 1. Delete from SQLite
        db.prepare('DELETE FROM accounts WHERE id = ?').run(id);

        // 2. Delete session folder (if WA)
        if (id.startsWith('wa-')) {
            const sessionPath = path.join(__dirname, `whatsapp-session-${accName}`);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
        }

        // 3. Remove from ecosystem.config.js
        const ecoPath = path.join(__dirname, 'ecosystem.config.js');
        if (fs.existsSync(ecoPath)) {
            let eco = fs.readFileSync(ecoPath, 'utf8');
            // matches { name: "workerName", ... },
            const regex = new RegExp(`\\s*\\{\\s*name:\\s*["']${workerName}["'][\\s\\S]*?\\},`, 'g');
            if (regex.test(eco)) {
                eco = eco.replace(regex, '');
                fs.writeFileSync(ecoPath, eco);
            }
        }

        // 4. Delete PM2 process
        const { exec } = require('child_process');
        exec(`npx pm2 delete ${workerName}`, (error) => {
            if (error) console.log(`Notice: Could not delete PM2 process ${workerName} (may already be stopped).`);
            exec('npx pm2 save');
        });

        res.json({ success: true, message: 'Account permanently deleted.' });
    } catch (err) {
        console.error('Delete Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Create Account
app.post('/api/accounts/create', (req, res) => {
    const { platform, id, token } = req.body;
    if (!platform || !id) return res.status(400).json({ success: false, error: 'Missing platform or id' });
    if (platform === 'telegram' && !token) return res.status(400).json({ success: false, error: 'Missing Bot Token for Telegram' });
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'ID must be alphanumeric' });
    // Token 只允许 Telegram bot token 合法字符，防止命令注入
    if (token && !/^[a-zA-Z0-9_:.-]+$/.test(token)) return res.status(400).json({ success: false, error: 'Invalid token format' });

    try {
        const { spawn, exec } = require('child_process');

        let workerName, scriptPath, spawnEnv;
        if (platform === 'whatsapp') {
            workerName = `worker-wa-${id}`;
            scriptPath = './workers/worker-wa.js';
            spawnEnv = { ...process.env, ACCOUNT_NAME: id };
            db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status) VALUES (?, 'whatsapp', 'initializing')`).run('wa-' + id);
        } else {
            workerName = `worker-tg-${id}`;
            scriptPath = './workers/worker-tg.js';
            spawnEnv = { ...process.env, TG_ACCOUNT_NAME: id, TG_BOT_TOKEN: token };
            db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status) VALUES (?, 'telegram', 'initializing')`).run('tg-' + id);
        }

        // Dynamically add to ecosystem.config.js
        const ecoPath = path.join(__dirname, 'ecosystem.config.js');
        if (fs.existsSync(ecoPath)) {
            let eco = fs.readFileSync(ecoPath, 'utf8');
            let insertStr = '';
            if (platform === 'whatsapp') {
                insertStr = `    {
      name: "${workerName}",
      script: "${scriptPath}",
      max_memory_restart: '1G',
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production", ACCOUNT_NAME: "${id}" }
    },\n    // --- Web UI Server ---`;
            } else {
                insertStr = `    {
      name: "${workerName}",
      script: "${scriptPath}",
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production", TG_ACCOUNT_NAME: "${id}", TG_BOT_TOKEN: "${token}" }
    },\n    // --- Web UI Server ---`;
            }
            if (eco.includes('// --- Web UI Server ---') && !eco.includes(workerName)) {
                eco = eco.replace('// --- Web UI Server ---', insertStr);
                fs.writeFileSync(ecoPath, eco);
            }
        }

        // 使用 spawn 参数数组启动，避免 shell 命令注入
        const pm2 = spawn('npx', ['pm2', 'start', scriptPath, '--name', workerName], {
            env: spawnEnv,
            stdio: 'inherit'
        });
        pm2.on('close', (code) => {
            if (code !== 0) console.error(`Failed to start PM2 process, exit code: ${code}`);
            exec('npx pm2 save');
        });

        res.json({ success: true, message: 'Account creation started' });
    } catch (err) {
        console.error('Create Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── 配置中心 API ─────────────────────────────────────────────────

const ENV_PATH = path.join(__dirname, '.env');
const ACCOUNT_REGIONS_PATH = path.join(__dirname, 'config', 'account-regions.json');

/** 读取 .env 文件并解析为 key=value 对象 */
function readEnvFile() {
    if (!fs.existsSync(ENV_PATH)) return {};
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    const result = {};
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx < 0) continue;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        result[key] = val;
    }
    return result;
}

/** 将 key-value 对象写回 .env，保留注释行和原有格式 */
function writeEnvKeys(updates) {
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    for (const [key, value] of Object.entries(updates)) {
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (value === '') {
            if (regex.test(content)) {
                content = content.replace(new RegExp(`^${key}=.*\\n?`, 'm'), '');
            }
        } else {
            if (regex.test(content)) {
                content = content.replace(regex, `${key}=${value}`);
            } else {
                content += `\n${key}=${value}`;
            }
        }
    }
    fs.writeFileSync(ENV_PATH, content, 'utf8');
}

const WEBHOOKS_PATH = path.join(__dirname, 'config', 'webhooks.json');
function readWebhooksFile() {
    if (!fs.existsSync(WEBHOOKS_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(WEBHOOKS_PATH, 'utf8'));
    } catch(e) { return {}; }
}
function writeWebhooksFile(data) {
    fs.writeFileSync(WEBHOOKS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// GET /api/config/webhooks — 读取区域专属 Webhook 配置
app.get('/api/config/webhooks', (req, res) => {
    try {
        const hooks = readWebhooksFile();
        res.json({ success: true, data: hooks });
    } catch(err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/config/webhooks — 添加/更新区域专属 Webhook
app.post('/api/config/webhooks', (req, res) => {
    const { type, platform, regions, url, secret } = req.body;
    if (!type || !platform || !regions || !Array.isArray(regions) || regions.length === 0 || !url) {
        return res.status(400).json({ success: false, error: '缺少必填参数或区域列表为空' });
    }
    try {
        const hooks = readWebhooksFile();
        regions.forEach(region => {
            const key = `${type.toUpperCase()}_${platform.toLowerCase()}_${region}`;
            hooks[key] = { url, secret: secret || '' };
        });
        writeWebhooksFile(hooks);
        res.json({ success: true, message: '区域 Webhook 保存成功' });
    } catch(err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/config/webhooks/:key — 删除区域专属 Webhook
app.delete('/api/config/webhooks/:key', (req, res) => {
    const { key } = req.params;
    if (!/^[\w\u4e00-\u9fa5]+$/.test(key)) return res.status(400).json({ success: false, error: 'Invalid webhook key format' });
    try {
        const hooks = readWebhooksFile();
        if (hooks[req.params.key]) {
            delete hooks[req.params.key];
            writeWebhooksFile(hooks);
        }
        res.json({ success: true, message: '已删除' });
    } catch(err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/config/env — 读取当前可配置的 env 值（敏感字段脱敏）
app.get('/api/config/env', (req, res) => {
    try {
        const env = readEnvFile();
        const KEYS = ['DINGTALK_ALERT', 'DINGTALK_DIGEST', 'DINGTALK_WEEKLY',
                      'DINGTALK_ALERT_WA', 'DINGTALK_DIGEST_WA', 'DINGTALK_WEEKLY_WA',
                      'DINGTALK_ALERT_TG', 'DINGTALK_DIGEST_TG', 'DINGTALK_WEEKLY_TG',
                      'DINGTALK_ALERT_TGU', 'DINGTALK_DIGEST_TGU', 'DINGTALK_WEEKLY_TGU',
                      'DINGTALK_ALERT_TEAMS', 'DINGTALK_DIGEST_TEAMS', 'DINGTALK_WEEKLY_TEAMS',
                      'DINGTALK_SYSTEM_OPS',
                      'DINGTALK_ALERT_SECRET', 'DINGTALK_DIGEST_SECRET', 'DINGTALK_WEEKLY_SECRET',
                      'DINGTALK_ALERT_WA_SECRET', 'DINGTALK_DIGEST_WA_SECRET', 'DINGTALK_WEEKLY_WA_SECRET',
                      'DINGTALK_ALERT_TG_SECRET', 'DINGTALK_DIGEST_TG_SECRET', 'DINGTALK_WEEKLY_TG_SECRET',
                      'DINGTALK_ALERT_TGU_SECRET', 'DINGTALK_DIGEST_TGU_SECRET', 'DINGTALK_WEEKLY_TGU_SECRET',
                      'DINGTALK_ALERT_TEAMS_SECRET', 'DINGTALK_DIGEST_TEAMS_SECRET', 'DINGTALK_WEEKLY_TEAMS_SECRET',
                      'DINGTALK_SYSTEM_OPS_SECRET',
                      'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'GEMINI_API_KEY'];
        const result = {};
        for (const k of KEYS) {
            const v = env[k] || '';
            const isPlaceholder = v.includes('YOUR_') || v.includes('your_');
            const isSet = !!(v && !isPlaceholder);
            // API Key / Webhook 脱敏；Base URL / Model 直接返回明文
            const isSensitive = k.includes('KEY') || k.includes('DINGTALK');
            result[k] = isSet
                ? (isSensitive ? (v.length > 16 ? v.slice(0, 12) + '****' + v.slice(-4) : '****') : v)
                : '';
            result[k + '_set'] = isSet;
        }
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/config/env — 更新指定 env 变量（空值不覆盖）
app.post('/api/config/env', (req, res) => {
    const ALLOWED = ['DINGTALK_ALERT', 'DINGTALK_DIGEST', 'DINGTALK_WEEKLY',
                     'DINGTALK_ALERT_WA', 'DINGTALK_DIGEST_WA', 'DINGTALK_WEEKLY_WA',
                     'DINGTALK_ALERT_TG', 'DINGTALK_DIGEST_TG', 'DINGTALK_WEEKLY_TG',
                     'DINGTALK_ALERT_TGU', 'DINGTALK_DIGEST_TGU', 'DINGTALK_WEEKLY_TGU',
                     'DINGTALK_ALERT_TEAMS', 'DINGTALK_DIGEST_TEAMS', 'DINGTALK_WEEKLY_TEAMS',
                     'DINGTALK_SYSTEM_OPS',
                     'DINGTALK_ALERT_SECRET', 'DINGTALK_DIGEST_SECRET', 'DINGTALK_WEEKLY_SECRET',
                     'DINGTALK_ALERT_WA_SECRET', 'DINGTALK_DIGEST_WA_SECRET', 'DINGTALK_WEEKLY_WA_SECRET',
                     'DINGTALK_ALERT_TG_SECRET', 'DINGTALK_DIGEST_TG_SECRET', 'DINGTALK_WEEKLY_TG_SECRET',
                     'DINGTALK_ALERT_TGU_SECRET', 'DINGTALK_DIGEST_TGU_SECRET', 'DINGTALK_WEEKLY_TGU_SECRET',
                     'DINGTALK_ALERT_TEAMS_SECRET', 'DINGTALK_DIGEST_TEAMS_SECRET', 'DINGTALK_WEEKLY_TEAMS_SECRET',
                     'DINGTALK_SYSTEM_OPS_SECRET',
                     'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'GEMINI_API_KEY'];
    try {
        const updates = {};
        for (const key of ALLOWED) {
            const val = req.body[key];
            if (val !== undefined && typeof val === 'string') {
                updates[key] = val.trim();
            }
        }
        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ success: false, error: '没有提供任何有效配置项' });
        }
        writeEnvKeys(updates);
        // Sync to current process memory so subsequent tests use the latest values
        for (const [key, value] of Object.entries(updates)) {
            if (value === '') delete process.env[key];
            else process.env[key] = value;
        }
        res.json({ success: true, message: `已更新 ${Object.keys(updates).join(', ')}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/ai/test — 对当前 AI 配置发起一次小型连通性测试
app.get('/api/ai/test', async (req, res) => {
    const env    = readEnvFile();
    const apiKey = env['OPENAI_API_KEY'] || '';
    const base   = (env['OPENAI_BASE_URL'] || 'https://api.openai.com/v1').replace(/\/$/, '');
    const model  = env['OPENAI_MODEL'] || 'gpt-4o-mini';
    if (!apiKey || apiKey.includes('your_')) {
        return res.json({ success: false, error: 'OPENAI_API_KEY 未配置' });
    }
    try {
        const start = Date.now();
        const r = await require('axios').post(
            `${base}/chat/completions`,
            { model, messages: [{ role: 'user', content: 'Reply with the single word: OK' }], max_tokens: 16 },
            { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        const reply = r.data?.choices?.[0]?.message?.content?.trim() || '(empty)';
        res.json({ success: true, model, baseUrl: base, reply, latencyMs: Date.now() - start });
    } catch (err) {
        res.json({
            success: false,
            status: err?.response?.status,
            error:  err?.response?.data?.error?.message || err.message,
            model, baseUrl: base
        });
    }
});

// GET /api/config/regions — 读取区域账号映射
app.get('/api/config/regions', (req, res) => {
    try {
        const config = JSON.parse(fs.readFileSync(ACCOUNT_REGIONS_PATH, 'utf8'));
        res.json({ success: true, data: config.accounts || [] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/config/regions — 添加/更新区域账号映射条目
app.post('/api/config/regions', (req, res) => {
    const { account, region, platform, owner, owner_dingtalk_id, description } = req.body;
    if (!account || !region || !platform) {
        return res.status(400).json({ success: false, error: '缺少 account / region / platform 字段' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(account)) {
        return res.status(400).json({ success: false, error: 'account 只允许英文数字下划线中划线' });
    }
    try {
        const config = JSON.parse(fs.readFileSync(ACCOUNT_REGIONS_PATH, 'utf8'));
        const accounts = config.accounts || [];
        const idx = accounts.findIndex(a => a.account === account);
        const entry = { account, region, platform, owner: owner || '', owner_dingtalk_id: owner_dingtalk_id || '', description: description || '' };
        if (idx >= 0) {
            accounts[idx] = entry;
        } else {
            accounts.push(entry);
        }
        config.accounts = accounts;
        fs.writeFileSync(ACCOUNT_REGIONS_PATH, JSON.stringify(config, null, 2), 'utf8');
        res.json({ success: true, message: `${idx >= 0 ? '更新' : '新增'}成功：${account}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/config/regions/:account — 删除区域映射条目
app.delete('/api/config/regions/:account', (req, res) => {
    const { account } = req.params;
    try {
        const config = JSON.parse(fs.readFileSync(ACCOUNT_REGIONS_PATH, 'utf8'));
        config.accounts = (config.accounts || []).filter(a => a.account !== account);
        fs.writeFileSync(ACCOUNT_REGIONS_PATH, JSON.stringify(config, null, 2), 'utf8');
        res.json({ success: true, message: `已删除：${account}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

const STAFF_CONFIG_PATH = path.join(__dirname, 'config', 'internal-staff.json');

// GET /api/config/staff — 读取内部员工白名单配置
app.get('/api/config/staff', (req, res) => {
    try {
        if (!fs.existsSync(STAFF_CONFIG_PATH)) {
             return res.json({ success: true, data: { whitelist: ['ITNIO~ DJ', 'ITNIO Support', 'Routing'], keywords: ['itnio', 'support', 'routing'] } });
        }
        const config = JSON.parse(fs.readFileSync(STAFF_CONFIG_PATH, 'utf8'));
        res.json({ success: true, data: config });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/config/staff — 更新内部员工白名单配置
app.post('/api/config/staff', (req, res) => {
    try {
        const { whitelist, keywords } = req.body;
        const config = {
            whitelist: Array.isArray(whitelist) ? whitelist : [],
            keywords: Array.isArray(keywords) ? keywords : []
        };
        fs.writeFileSync(STAFF_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
        res.json({ success: true, message: '内部员工配置已更新' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/analytics/summary — 读取 analytics.sqlite 汇总（告警 / 问题统计）
app.get('/api/analytics/summary', (req, res) => {
    const adb = getAnalyticsDb();
    if (!adb) {
        return res.json({ success: true, data: { ready: false } });
    }
    try {
        const totalAlerts = adb.prepare("SELECT COUNT(*) AS c FROM alert_records").get()?.c || 0;
        const p0 = adb.prepare("SELECT COUNT(*) AS c FROM alert_records WHERE alert_level='p0'").get()?.c || 0;
        const p1 = adb.prepare("SELECT COUNT(*) AS c FROM alert_records WHERE alert_level='p1'").get()?.c || 0;
        const openIssues = adb.prepare("SELECT COUNT(*) AS c FROM issue_records WHERE status='open'").get()?.c || 0;
        const closedIssues = adb.prepare("SELECT COUNT(*) AS c FROM issue_records WHERE status='closed'").get()?.c || 0;
        const avgRecovery = adb.prepare("SELECT AVG(duration_mins) AS v FROM issue_records WHERE status='closed' AND duration_mins IS NOT NULL").get()?.v || 0;
        res.json({ success: true, data: { ready: true, totalAlerts, p0, p1, openIssues, closedIssues, avgRecoveryMins: Math.round(avgRecovery) } });
    } catch (err) {
        res.json({ success: true, data: { ready: false, error: err.message } });
    }
});

// Optional system status stub
app.get('/api/status', (req, res) => {
    res.json({ success: true, running: true });
});

// POST /api/config/test-webhook — 测试 Webhook 连通性
app.post('/api/config/test-webhook', async (req, res) => {
    let { key, url, secret, isRegionWebhook } = req.body;
    
    // 如果前端没有传入新的 URL（文本框为空），则尝试读取系统中已保存的配置
    if (!url && key) {
        if (isRegionWebhook) {
            const hooks = readWebhooksFile();
            if (hooks[key]) {
                url = hooks[key].url;
                secret = hooks[key].secret;
            }
        } else {
            url = process.env[key];
            if (!secret) {
                secret = process.env[`${key}_SECRET`];
            }
        }
    }

    if (!url || !url.startsWith('http')) {
        return res.json({ success: false, error: '未提供有效的 Webhook URL，且系统未配置此项' });
    }
    
    let targetUrl = url;
    if (secret) {
        const crypto = require('crypto');
        const timestamp = Date.now();
        const stringToSign = `${timestamp}\n${secret}`;
        const sign = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
        targetUrl = `${url}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
    }

    try {
        const payload = {
            msgtype: "markdown",
            markdown: {
                title: "✅ 连通性测试成功",
                text: "### ✅ ITNIO 社媒监控系统\n\n您已成功配置并联通了此通道机器人的 Webhook！\n\n> *This is an automated test message.*"
            }
        };
        const axios = require('axios');
        const start = Date.now();
        const r = await axios.post(targetUrl, payload, { timeout: 10000 });
        if (r.data && r.data.errcode !== 0 && r.data.errcode !== undefined) {
            return res.json({ success: false, error: r.data.errmsg || 'Unknown DingTalk Error' });
        }
        res.json({ success: true, latencyMs: Date.now() - start });
    } catch (err) {
        res.json({ success: false, error: err?.response?.data?.errmsg || err?.response?.data?.description || err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// TG 用户账号（MTProto）Phase 2 API
// ─────────────────────────────────────────────────────────────────────────────
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { getSession, saveSession, revokeSession, getSessionStatus, getRateLimit, saveRateLimit } = require('./lib/tg-session-store');
const { getTasks, pauseTasks, resumeTasks, resetTask } = require('./lib/tg-backfill-queue');

// 内存中的登录临时状态（phoneCodeHash / client 实例），超时自动清理
const loginSessions = new Map(); // accountName -> { client, phoneCodeHash, expireAt }

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

function cleanupLoginSession(accountName) {
    const s = loginSessions.get(accountName);
    if (s) {
        try { s.client.disconnect(); } catch (_) {}
        loginSessions.delete(accountName);
    }
}

// 定时清理过期登录会话
setInterval(() => {
    const now = Date.now();
    for (const [name, s] of loginSessions.entries()) {
        if (s.expireAt < now) {
            console.log(`[TGUser API] Login session expired for: ${name}`);
            cleanupLoginSession(name);
        }
    }
}, 30000);

// ─── POST /api/tg-user/start-login ──────────────────────────────────────────
// 发起登录：输入手机号 + api_id + api_hash，TG 推送验证码到手机
app.post('/api/tg-user/start-login', async (req, res) => {
    const { account_name, phone, api_id, api_hash } = req.body;
    if (!account_name || !phone || !api_id || !api_hash) {
        return res.status(400).json({ success: false, error: '缺少必填参数: account_name, phone, api_id, api_hash' });
    }

    // 清理旧的登录会话
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

// ─── POST /api/tg-user/verify-code ──────────────────────────────────────────
// 输入验证码，完成登录或触发 2FA
app.post('/api/tg-user/verify-code', async (req, res) => {
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

        // 登录成功，保存 Session
        const sessionString = s.client.session.save();
        saveSession(account_name, sessionString);
        db.prepare(`UPDATE accounts SET status='authenticated', updated_at=datetime('now') WHERE id=?`).run(`tgu-${account_name}`);
        
        // 注意：不在这里清除 loginSession 和设 tgu_logged_in 标志，保留 client 供选群拉取 Dialog
        // 等待在 whitelist 接口调用时才清理

        // 把 client 交接给全局
        global[`tgu_client_${account_name}`] = s.client;

        res.json({ success: true, message: '登录成功！Session 已保存。', status: 'authenticated' });
    } catch (err) {
        const errName = err.constructor?.name || '';
        if (errName.includes('SessionPasswordNeeded') || err.message?.includes('SESSION_PASSWORD_NEEDED')) {
            // 需要 2FA 密码
            s.expireAt = Date.now() + LOGIN_TIMEOUT_MS; // 延长超时
            db.prepare(`UPDATE accounts SET status='need_2fa', updated_at=datetime('now') WHERE id=?`).run(`tgu-${account_name}`);
            return res.json({ success: true, need2fa: true, status: 'need_2fa', message: '需要输入两步验证密码' });
        }
        console.error('[TGUser API] verify-code error:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// ─── POST /api/tg-user/verify-2fa ───────────────────────────────────────────
// 输入 2FA 密码，最终完成登录
app.post('/api/tg-user/verify-2fa', async (req, res) => {
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

// ─── GET /api/tg-user/dialogs/:name ─────────────────────────────────────────
// 获取账号下的所有群组/频道列表（在登录刚成功时调用）
app.get('/api/tg-user/dialogs/:name', async (req, res) => {
    const { name } = req.params;
    let client = global[`tgu_client_${name}`];
    let isTemp = false;

    if (!client) {
        const sessionStr = getSession(name);
        if (!sessionStr) return res.status(400).json({ success: false, error: '无此账号的登录状态，请先登录' });

        const ecoPath = path.join(__dirname, 'ecosystem.config.js');
        let apiId, apiHash;
        if (fs.existsSync(ecoPath)) {
            const ecoStr = fs.readFileSync(ecoPath, 'utf8');
            const workerName = `worker-tgu-${name}`;
            const workerIdx = ecoStr.indexOf(workerName);
            if (workerIdx !== -1) {
                const apiIdMatch = ecoStr.substring(workerIdx).match(/TG_API_ID:\s*["'](\d+)["']/);
                const apiHashMatch = ecoStr.substring(workerIdx).match(/TG_API_HASH:\s*["']([^"']+)["']/);
                if (apiIdMatch && apiHashMatch) {
                    apiId = parseInt(apiIdMatch[1]);
                    apiHash = apiHashMatch[1];
                }
            }
        }

        if (!apiId || !apiHash) {
            return res.status(400).json({ success: false, error: '未能找到 API ID/Hash，请重新添加账号' });
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

// ─── POST /api/tg-user/whitelist/:name ──────────────────────────────────────
// 保存监控白名单并最终放行 worker
app.post('/api/tg-user/whitelist/:name', (req, res) => {
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
        
        // 结束登录会话
        cleanupLoginSession(name);
        // 通知 worker 放行（同进程兼容）
        global[`tgu_logged_in_${name}`] = true;
        // 写文件信号（跨进程，worker 轮询此文件）
        const statusFilePath = path.join(__dirname, `db/.tgu_status_${name}.json`);
        try {
            fs.writeFileSync(statusFilePath, JSON.stringify({ status: 'login_complete', account: name, updated_at: Date.now() }), 'utf8');
        } catch (_) { }

        res.json({ success: true, message: '配置保存成功，系统已启动监控' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /api/tg-user/status/:name ──────────────────────────────────────────
// 查询账号状态（session 有效性 + 运行状态）
app.get('/api/tg-user/status/:name', (req, res) => {
    const { name } = req.params;
    try {
        const sessionStatus = getSessionStatus(name);
        const dbAccount = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(`tgu-${name}`);
        const statusFilePath = path.join(__dirname, `db/.tgu_status_${name}.json`);
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

// ─── POST /api/tg-user/revoke/:name ─────────────────────────────────────────
// 撤销 Session，停止进程
app.post('/api/tg-user/revoke/:name', (req, res) => {
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

// ─── GET /api/tg-user/ratelimit/:name ───────────────────────────────────────
// 读取账号频控配置
app.get('/api/tg-user/ratelimit/:name', (req, res) => {
    try {
        const cfg = getRateLimit(req.params.name);
        res.json({ success: true, data: cfg });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── POST /api/tg-user/ratelimit/:name ──────────────────────────────────────
// 更新账号频控配置（写入 .env）
app.post('/api/tg-user/ratelimit/:name', (req, res) => {
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

// ─── GET /api/tg-user/backfill/:name ────────────────────────────────────────
// 查看回溯任务列表及进度
app.get('/api/tg-user/backfill/:name', (req, res) => {
    try {
        const tasks = getTasks(req.params.name);
        res.json({ success: true, data: tasks });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── POST /api/tg-user/backfill/:name/pause ─────────────────────────────────
// 暂停回溯
app.post('/api/tg-user/backfill/:name/pause', (req, res) => {
    try {
        pauseTasks(req.params.name);
        res.json({ success: true, message: `已暂停 ${req.params.name} 的历史回溯` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── POST /api/tg-user/backfill/:name/resume ────────────────────────────────
// 恢复回溯
app.post('/api/tg-user/backfill/:name/resume', (req, res) => {
    try {
        resumeTasks(req.params.name);
        res.json({ success: true, message: `已恢复 ${req.params.name} 的历史回溯` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── POST /api/tg-user/backfill/:name/reset ─────────────────────────────────
// 重置某群回溯进度（body: { chat_id }）
app.post('/api/tg-user/backfill/:name/reset', (req, res) => {
    const { chat_id } = req.body;
    if (!chat_id) return res.status(400).json({ success: false, error: '缺少 chat_id' });
    try {
        resetTask(req.params.name, chat_id);
        res.json({ success: true, message: `已重置群 ${chat_id} 的回溯进度` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── POST /api/accounts/create-tg-user ──────────────────────────────────────
// 创建 TG 用户账号（MTProto）采集节点并写入 ecosystem.config.js
app.post('/api/accounts/create-tg-user', (req, res) => {
    const { id, api_id, api_hash, warmup_seconds, daily_limit, batch_size,
            sleep_min_ms, sleep_max_ms, backfill_days, enable_backfill } = req.body;

    if (!id || !api_id || !api_hash) {
        return res.status(400).json({ success: false, error: '缺少必填参数: id, api_id, api_hash' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).json({ success: false, error: 'ID 只允许英文数字下划线中划线' });
    }

    try {
        const workerName = `worker-tgu-${id}`;
        const cfg = {
            warmup_seconds: warmup_seconds || 600,
            daily_limit: daily_limit || 2000,
            batch_size: batch_size || 100,
            sleep_min_ms: sleep_min_ms || 3000,
            sleep_max_ms: sleep_max_ms || 8000,
            backfill_days: backfill_days !== undefined ? backfill_days : 7,
            enable_backfill: enable_backfill !== undefined ? enable_backfill : true
        };

        // 保存频控配置到 .env
        saveRateLimit(id, cfg);

        // 写入 ecosystem.config.js
        const ecoPath = path.join(__dirname, 'ecosystem.config.js');
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
        TG_ACCOUNT_NAME: "${id}",
        TG_API_ID: "${api_id}",
        TG_API_HASH: "${api_hash}",
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
                fs.writeFileSync(ecoPath, eco);
            }
        }

        // 初始化账号数据库记录
        db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status, updated_at) VALUES (?, 'telegram', 'idle', datetime('now'))`).run(`tgu-${id}`);

        // 启动 PM2 进程
        const { spawn, exec } = require('child_process');
        const spawnEnv = {
            ...process.env,
            TG_ACCOUNT_NAME: id,
            TG_API_ID: String(api_id),
            TG_API_HASH: api_hash,
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

// ─── Teams 账号 API ────────────────────────────────────────────────

/**
 * POST /api/accounts/create-teams
 * 创建 Teams 采集账号，启动 Worker 进程（需要用户手动登录）
 */
app.post('/api/accounts/create-teams', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: '缺少账号 ID' });
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'ID 只能包含字母、数字、下划线和横线' });

    const { exec } = require('child_process');
    const workerName = `worker-teams-${id}`;
    const accountKey = `teams-${id}`;

    try {
        // 写入数据库
        db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status) VALUES (?, 'teams', 'initializing')`).run(accountKey);

        // 写入 ecosystem.config.js
        const ecoPath = path.join(__dirname, 'ecosystem.config.js');
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
                fs.writeFileSync(ecoPath, eco, 'utf8');
            }
        }

        // 启动 Worker（首次需要用户登录，Worker 检测到需要登录后会发运维告警）
        exec(`npx pm2 start ./workers/worker-teams.js --name "${workerName}" --max-memory-restart 600M -- --env ACCOUNT_NAME=${id}`, {
            env: { ...process.env, ACCOUNT_NAME: id },
            cwd: __dirname
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

/**
 * GET /api/teams/chats/:name
 * 获取指定账号当前已发现的群聊列表（供白名单选择）
 * 注意：群聊列表存储在进程内存，通过状态文件传递
 */
app.get('/api/teams/chats/:name', (req, res) => {
    const { name } = req.params;
    const chatsCachePath = path.join(__dirname, `teams-profile-${name}`, 'chats-cache.json');
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

/**
 * POST /api/teams/whitelist/:name
 * 设置群聊白名单
 * body: { chatIds: ['chatId1', 'chatId2'] }
 */
app.post('/api/teams/whitelist/:name', (req, res) => {
    const { name } = req.params;
    const { chatIds } = req.body;

    const envKey = `TEAMS_WHITELIST_${name.toUpperCase().replace(/-/g, '_')}`;
    const value = Array.isArray(chatIds) ? chatIds.join(',') : '';

    try {
        // 写入 .env 文件
        const envPath = path.join(__dirname, '.env');
        let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
        const regex = new RegExp(`^${envKey}=.*$`, 'm');
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${envKey}=${value}`);
        } else {
            envContent += `\n${envKey}=${value}`;
        }
        fs.writeFileSync(envPath, envContent, 'utf8');

        res.json({ success: true, message: `白名单已设置，共 ${chatIds?.length || 0} 个群聊` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * POST /api/teams/backfill/:name/start
 * 手动触发历史回溯（在 Worker 进程内存中设置标志位）
 */
app.post('/api/teams/backfill/:name/start', (req, res) => {
    const { name } = req.params;
    const flagPath = path.join(__dirname, `teams-profile-${name}`, 'backfill.flag');
    try {
        const profileDir = path.join(__dirname, `teams-profile-${name}`);
        if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
        fs.writeFileSync(flagPath, JSON.stringify({ action: 'start', days: req.body.days || 7, ts: Date.now() }));
        res.json({ success: true, message: '回溯指令已发送，Worker 将在下次轮询时开始回溯' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * POST /api/teams/backfill/:name/pause
 * 暂停历史回溯
 */
app.post('/api/teams/backfill/:name/pause', (req, res) => {
    const { name } = req.params;
    const flagPath = path.join(__dirname, `teams-profile-${name}`, 'backfill.flag');
    try {
        fs.writeFileSync(flagPath, JSON.stringify({ action: 'pause', ts: Date.now() }));
        res.json({ success: true, message: '回溯已暂停' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * POST /api/teams/relogin/:name
 * 触发重新登录（清除 Session，发送运维告警引导用户通过 UI 重新登录）
 */
app.post('/api/teams/relogin/:name', async (req, res) => {
    const { name } = req.params;
    try {
        const sessionStore = require('./lib/teams-session-store');
        sessionStore.clearSession(name);
        // 重启 Worker（重启后会检测到无 Session，转入需要登录状态）
        const { exec } = require('child_process');
        exec(`npx pm2 restart worker-teams-${name}`, { cwd: __dirname }, () => {});
        res.json({ success: true, message: 'Session 已清除，Worker 重启中，请准备完成 Teams 登录' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Social Monitor UI Server listening on http://localhost:${PORT}`);
});

// ─── 全局错误处理 ──────────────────────────────────────────────
// Express 路由中未捕获的同步错误
app.use((err, req, res, next) => {
    console.error('[server] Unhandled route error:', err.message, err.stack);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// Node.js 进程级未捕获异常（防止进程崩溃）
process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection:', reason);
});

