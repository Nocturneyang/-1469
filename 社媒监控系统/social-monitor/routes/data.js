const express = require('express');
const { db } = require('../db/database');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Analytics database connection
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const analyticsDbPath = path.join(DATA_DIR, 'db', 'analytics.sqlite');
const analyticsDb = new Database(analyticsDbPath);

// Account regions mapping file path
const ACCOUNT_REGIONS_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'config', 'account-regions.json');

// Helper function to read account regions mapping
function getAccountRegions() {
    try {
        if (!fs.existsSync(ACCOUNT_REGIONS_PATH)) {
            return {};
        }
        const config = JSON.parse(fs.readFileSync(ACCOUNT_REGIONS_PATH, 'utf8'));
        const accounts = config.accounts || [];
        const regionMap = {};
        accounts.forEach(acc => {
            regionMap[acc.account] = {
                region: acc.region || '',
                business_sector: acc.business_sector || ''
            };
        });
        return regionMap;
    } catch (err) {
        console.error('Error reading account regions:', err);
        return {};
    }
}

router.get('/stats', (req, res) => {
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

router.get('/messages', (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        
        const platformFilter = req.query.platform;
        
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
        
        // Add region information from account-regions.json
        const regionMap = getAccountRegions();
        const messagesWithRegion = messages.map(msg => {
            const regionInfo = regionMap[msg.receiver_account] || {};
            return {
                ...msg,
                region: regionInfo.region || '',
                business_sector: regionInfo.business_sector || ''
            };
        });
        
        res.json({
            success: true,
            total,
            page,
            pages: Math.ceil(total / limit),
            data: messagesWithRegion
        });
    } catch (err) {
        console.error('Messages DB Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/groups', (req, res) => {
    try {
        const accountFilter = req.query.account;
        let query = 'SELECT DISTINCT group_name, group_id, receiver_account FROM messages WHERE group_name IS NOT NULL AND group_name != \'\'';
        const params = [];
        if (accountFilter) {
            query += ' AND receiver_account = ?';
            params.push(accountFilter);
        }
        query += ' ORDER BY group_name';
        const rows = db.prepare(query).all(...params);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get real-time alerts
router.get('/alerts', (req, res) => {
    try {
        const alerts = analyticsDb.prepare(`
            SELECT id, alert_level as lvl, receiver_account as account, ai_title as text, 
                   created_at, business_sector
            FROM alert_records
            WHERE is_pushed = 1
            ORDER BY created_at DESC
            LIMIT 10
        `).all();
        
        const formattedAlerts = alerts.map(a => {
            const date = new Date(a.created_at);
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            return {
                id: a.id,
                lvl: a.lvl ? a.lvl.toUpperCase() : 'P1',
                text: a.text || a.account || '未知告警',
                time: `${hours}:${minutes}`,
                group: a.business_sector || '未知'
            };
        });
        
        res.json({ success: true, data: formattedAlerts });
    } catch (err) {
        console.error('Alerts DB Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get recent closed issues
router.get('/closed-recent', (req, res) => {
    try {
        const closedIssues = analyticsDb.prepare(`
            SELECT id, group_name, issue_type as text,
                   closed_at, business_sector as supplier,
                   duration_mins
            FROM issue_records
            WHERE status = 'closed' AND closed_at IS NOT NULL
            ORDER BY closed_at DESC
            LIMIT 10
        `).all();
        
        const formattedClosed = closedIssues.map(c => {
            const date = new Date(c.closed_at * 1000);
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            return {
                id: c.id,
                supplier: c.supplier || c.group_name || '未知',
                text: c.text || '未知问题',
                time: `${hours}:${minutes}`,
                mttr: c.duration_mins ? `${Math.round(c.duration_mins)}min` : '-'
            };
        });
        
        res.json({ success: true, data: formattedClosed });
    } catch (err) {
        console.error('Closed Recent DB Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
