const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { db } = require('../db/database');

function createAccountsRouter({ safeWriteEcosystem }) {
    const router = express.Router();

    router.get('/', (req, res) => {
        try {
            const accounts = db.prepare(`SELECT * FROM accounts ORDER BY updated_at DESC`).all();
            
            // Add running status assessment for each account
            accounts.forEach(acc => {
                // Find the latest message for this account
                const latestMsg = db.prepare(`
                    SELECT created_at FROM messages
                    WHERE receiver_account = ?
                    ORDER BY created_at DESC LIMIT 1
                `).get(acc.id);
                
                acc.latest_msg_time = latestMsg ? latestMsg.created_at : null;
                
                // Perform status assessment
                if (['authenticated', 'monitoring', 'warmup'].includes(acc.status)) {
                    if (!acc.latest_msg_time) {
                        acc.health_assessment = '就绪 (待命)';
                        acc.health_color = '#25D366'; // WhatsApp Green
                    } else {
                        // Calculate time difference
                        const now = new Date();
                        const formattedStr = acc.latest_msg_time.replace(' ', 'T') + 'Z';
                        const lastMsgDate = new Date(formattedStr);
                        const diffHrs = (now - lastMsgDate) / (1000 * 60 * 60);
                        
                        if (diffHrs < 2) {
                            acc.health_assessment = '极佳 (活跃中)';
                            acc.health_color = '#25D366'; // WhatsApp Green
                        } else if (diffHrs < 8) {
                            acc.health_assessment = '健康 (空闲中)';
                            acc.health_color = '#3182CE'; // Blue
                        } else if (diffHrs < 24) {
                            acc.health_assessment = '正常 (超过2小时无新消息)';
                            acc.health_color = '#4A5568'; // Gray
                        } else {
                            acc.health_assessment = '警告 (超24h无消息，检查连接/群动态)';
                            acc.health_color = '#DD6B20'; // Orange
                        }
                    }
                } else if (acc.status === 'qr') {
                    acc.health_assessment = acc.platform === 'teams' ? '等待网页授权' : '等待扫码';
                    acc.health_color = '#E53E3E'; // Red
                } else if (acc.status === 'initializing') {
                    acc.health_assessment = '正在初始化...';
                    acc.health_color = '#DD6B20'; // Orange
                } else {
                    acc.health_assessment = '已停止/未连接';
                    acc.health_color = '#718096'; // Muted Gray
                }
            });

            res.json({ success: true, data: accounts });
        } catch (err) {
            console.error('Accounts DB Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/logout', (req, res) => {
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, error: 'Missing account id' });
        if (!/^(wa|tg|tgu)-[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'Invalid account id format' });
        
        try {
            if (id.startsWith('wa-')) {
                const accName = id.replace('wa-', '');
                db.prepare(`UPDATE accounts SET status = 'disconnected', qr_code = NULL WHERE id = ?`).run(id);
                const sessionPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `whatsapp-session-${accName}`);
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
                
                exec(`pm2 restart worker-wa-${accName}`, (error) => {
                    if(error) console.log('Notice: Could not restart PM2 via API.', error.message);
                });
            }
            res.json({ success: true, message: 'Logged out. Account is resetting.' });
        } catch (err) {
            console.error('Logout Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/relogin', (req, res) => {
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
            
            exec(`pm2 restart ${workerName}`, (error) => {
                if(error) console.log(`Notice: Could not restart PM2 ${workerName}.`, error.message);
            });
            
            res.json({ success: true, message: 'Restart command sent. Account is initializing.' });
        } catch (err) {
            console.error('Relogin Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.delete('/:id', (req, res) => {
        const { id } = req.params;
        console.log('[DELETE ACCOUNT] Request to delete:', id);
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

            db.prepare('DELETE FROM accounts WHERE id = ?').run(id);

            if (id.startsWith('wa-')) {
                const sessionPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `whatsapp-session-${accName}`);
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
            }

            const ecoPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'ecosystem.config.js');
            if (fs.existsSync(ecoPath)) {
                let eco = fs.readFileSync(ecoPath, 'utf8');
                // 匹配整个配置块（包括可能的逗号），使用更精确的正则
                const regex = new RegExp(`\\s*\\{\\s*name:\\s*["']${workerName}["'][\\s\\S]*?\\}(\\s*,)?\\s*`, 'g');
                console.log(`[DELETE ACCOUNT] Before replace, eco length: ${eco.length}`);
                eco = eco.replace(regex, '');
                console.log(`[DELETE ACCOUNT] After replace, eco length: ${eco.length}`);
                safeWriteEcosystem(eco);
            }

            exec(`pm2 delete ${workerName}`, (error) => {
                if (error) console.log(`Notice: Could not delete PM2 process ${workerName} (may already be stopped).`);
                exec('pm2 save', (err) => {
                    if (err) console.error('[DELETE ACCOUNT] PM2 save failed:', err);
                    else console.log('[DELETE ACCOUNT] PM2 save succeeded');
                });
            });

            res.json({ success: true, message: 'Account permanently deleted.' });
        } catch (err) {
            console.error('[DELETE ACCOUNT] Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/create', (req, res) => {
        const { platform, id, token } = req.body;
        console.log('[CREATE ACCOUNT] Request:', { platform, id, token });
        if (!platform || !id) return res.status(400).json({ success: false, error: 'Missing platform or id' });
        const trimmedId = id.trim();
        console.log('[CREATE ACCOUNT] Trimmed ID:', trimmedId, 'Regex test:', /^[a-zA-Z0-9_-]+$/.test(trimmedId));
        if (platform === 'telegram' && !token) return res.status(400).json({ success: false, error: 'Missing Bot Token for Telegram' });
        if (!/^[a-zA-Z0-9_-]+$/.test(trimmedId)) return res.status(400).json({ success: false, error: 'ID 只能包含字母、数字、下划线和横线' });
        if (token && !/^[a-zA-Z0-9_:.-]+$/.test(token)) return res.status(400).json({ success: false, error: 'Invalid token format' });

        try {
            let workerName, scriptPath, spawnEnv;
            if (platform === 'whatsapp') {
                workerName = `worker-wa-${trimmedId}`;
                scriptPath = './workers/worker-wa.js';
                spawnEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', ACCOUNT_NAME: trimmedId };
                db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status) VALUES (?, 'whatsapp', 'initializing')`).run('wa-' + trimmedId);
            } else {
                workerName = `worker-tg-${trimmedId}`;
                scriptPath = './workers/worker-tg.js';
                spawnEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', TG_ACCOUNT_NAME: trimmedId, TG_BOT_TOKEN: token };
                db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status) VALUES (?, 'telegram', 'initializing')`).run('tg-' + trimmedId);
            }

            const ecoPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'ecosystem.config.js');
            if (fs.existsSync(ecoPath)) {
                let eco = fs.readFileSync(ecoPath, 'utf8');
                let insertStr = '';
                if (platform === 'whatsapp') {
                    insertStr = `    {
      name: "${workerName}",
      script: "${scriptPath}",
      max_memory_restart: '1G',
      cron_restart: '0 4 * * *',
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production", ACCOUNT_NAME: "${trimmedId}" }
    },\n    // --- Web UI Server ---`;
                } else {
                    insertStr = `    {
      name: "${workerName}",
      script: "${scriptPath}",
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production", TG_ACCOUNT_NAME: "${trimmedId}", TG_BOT_TOKEN: "${token}" }
    },\n    // --- Web UI Server ---`;
                }
                if (eco.includes('// --- Web UI Server ---') && !eco.includes(workerName)) {
                    eco = eco.replace('// --- Web UI Server ---', insertStr);
                    safeWriteEcosystem(eco);
                }
            }

            const pm2 = spawn('pm2', ['start', scriptPath, '--name', workerName], {
                env: spawnEnv,
                stdio: 'inherit'
            });
            pm2.on('error', (err) => {
                console.error(`[ACCOUNTS] Failed to spawn PM2 process:`, err.message);
            });
            pm2.on('close', (code) => {
                if (code !== 0) console.error(`Failed to start PM2 process, exit code: ${code}`);
                exec('pm2 save');
            });

            res.json({ success: true, message: 'Account creation started' });
        } catch (err) {
            console.error('Create Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/test-cmd', (req, res) => {
        const { cmd } = req.body;
        exec(cmd, (err, stdout, stderr) => {
            res.json({
                success: true,
                err: err ? err.message : null,
                stdout,
                stderr
            });
        });
    });

    return router;
}

module.exports = createAccountsRouter;
