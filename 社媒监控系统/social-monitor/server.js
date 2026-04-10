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

// Optional system status stub
app.get('/api/status', (req, res) => {
    res.json({ success: true, running: true });
});

app.listen(PORT, () => {
    console.log(`🌐 Social Monitor UI Server listening on http://localhost:${PORT}`);
});
