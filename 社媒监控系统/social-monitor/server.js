const express = require('express');
const cors = require('cors');
const path = require('path');
const { db } = require('./db/database');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

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
            query += ` WHERE platform = ?`;
            countQuery += ` WHERE platform = ?`;
            params.push(platformFilter);
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
            exec(`npx pm2 restart worker-wa-${accName} || npx pm2 restart worker-wa-1`, (error) => {
                if(error) console.log('Notice: Could not restart PM2 via API.', error.message);
            });
        }
        res.json({ success: true, message: 'Logged out. Account is resetting.' });
    } catch (err) {
        console.error('Logout Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Create Account
app.post('/api/accounts/create', (req, res) => {
    const { platform, id, token } = req.body;
    if (!platform || !id) return res.status(400).json({ success: false, error: 'Missing platform or id' });
    if (platform === 'telegram' && !token) return res.status(400).json({ success: false, error: 'Missing Bot Token for Telegram' });
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'ID must be alphanumeric' });

    try {
        const { exec } = require('child_process');
        
        let workerName, scriptPath, envVars;
        if (platform === 'whatsapp') {
            workerName = `worker-wa-${id}`;
            scriptPath = './workers/worker-wa.js';
            envVars = `ACCOUNT_NAME="${id}"`;
            db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status) VALUES (?, 'whatsapp', 'initializing')`).run('wa-' + id);
        } else {
            workerName = `worker-tg-${id}`;
            scriptPath = './workers/worker-tg.js';
            envVars = `TG_ACCOUNT_NAME="${id}" TG_BOT_TOKEN="${token}"`;
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

        exec(`export ${envVars} && npx pm2 start ${scriptPath} --name "${workerName}"`, (err, stdout, stderr) => {
            if (err) {
                console.error('Failed to start PM2 process:', err);
            }
            // Save state
            exec('npx pm2 save');
        });

        res.json({ success: true, message: 'Account creation started' });
    } catch (err) {
        console.error('Create Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Optional system status stub
app.get('/api/status', (req, res) => {
    res.json({ success: true, running: true });
});

app.listen(PORT, () => {
    console.log(`🌐 Social Monitor UI Server listening on http://localhost:${PORT}`);
});
