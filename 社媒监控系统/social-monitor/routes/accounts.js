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
            
            exec(`npx pm2 restart ${workerName}`, (error) => {
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
                const regex = new RegExp(`\\s*\\{\\s*name:\\s*["']${workerName}["'][\\s\\S]*?\\},`, 'g');
                if (regex.test(eco)) {
                    eco = eco.replace(regex, '');
                    safeWriteEcosystem(eco);
                }
            }

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

    router.post('/create', (req, res) => {
        const { platform, id, token } = req.body;
        if (!platform || !id) return res.status(400).json({ success: false, error: 'Missing platform or id' });
        if (platform === 'telegram' && !token) return res.status(400).json({ success: false, error: 'Missing Bot Token for Telegram' });
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'ID must be alphanumeric' });
        if (token && !/^[a-zA-Z0-9_:.-]+$/.test(token)) return res.status(400).json({ success: false, error: 'Invalid token format' });

        try {
            let workerName, scriptPath, spawnEnv;
            if (platform === 'whatsapp') {
                workerName = `worker-wa-${id}`;
                scriptPath = './workers/worker-wa.js';
                spawnEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', ACCOUNT_NAME: id };
                db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status) VALUES (?, 'whatsapp', 'initializing')`).run('wa-' + id);
            } else {
                workerName = `worker-tg-${id}`;
                scriptPath = './workers/worker-tg.js';
                spawnEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', TG_ACCOUNT_NAME: id, TG_BOT_TOKEN: token };
                db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status) VALUES (?, 'telegram', 'initializing')`).run('tg-' + id);
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
                    safeWriteEcosystem(eco);
                }
            }

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

    return router;
}

module.exports = createAccountsRouter;
