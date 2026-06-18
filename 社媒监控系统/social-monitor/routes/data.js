const express = require('express');
const { db } = require('../db/database');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getShanghaiParts } = require('../lib/time');
const { isMediaUploadDisabled } = require('../lib/media-policy');

const router = express.Router();

function shanghaiHourMinute(value) {
    const parts = getShanghaiParts(value);
    return `${parts.hour}:${parts.minute}`;
}

// Analytics database connection
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const analyticsDbPath = path.join(DATA_DIR, 'db', 'analytics.sqlite');
let analyticsDb = null;

// Account regions mapping file path
const ACCOUNT_REGIONS_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'config', 'account-regions.json');
const STATS_CACHE_TTL_MS = Number(process.env.STATS_CACHE_TTL_MS || 5000);
const REGION_CACHE_TTL_MS = Number(process.env.REGION_CACHE_TTL_MS || 60000);
let statsCache = { expiresAt: 0, data: null };
let regionCache = { expiresAt: 0, data: {} };

function envFlag(name) {
    return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function analyticsMaintenanceMode() {
    return envFlag('DB_DEGRADED_BOOT') || envFlag('ANALYTICS_MAINTENANCE_MODE');
}

function getAnalyticsDb() {
    if (analyticsMaintenanceMode()) return null;
    if (analyticsDb) return analyticsDb;
    if (!fs.existsSync(analyticsDbPath)) return null;
    try {
        analyticsDb = new Database(analyticsDbPath, { fileMustExist: true });
        try { analyticsDb.pragma('busy_timeout = 5000'); } catch (_) {}
        return analyticsDb;
    } catch (err) {
        console.error('Analytics DB open error:', err.message);
        analyticsDb = null;
        return null;
    }
}

function normalizeMediaPath(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw;
    const clean = raw.split('?')[0].replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean.startsWith('media/')) return clean;
    return `media/${path.posix.basename(clean)}`;
}

function isMediaAvailable(value) {
    if (isMediaUploadDisabled()) return false;
    const normalized = normalizeMediaPath(value);
    if (!normalized) return false;
    if (/^https?:\/\//i.test(normalized)) return true;
    const absolute = path.join(DATA_DIR, normalized);
    const mediaRoot = path.join(DATA_DIR, 'media');
    if (!absolute.startsWith(mediaRoot + path.sep)) return false;
    return fs.existsSync(absolute);
}

// Helper function to read account regions mapping
function getAccountRegions() {
    const now = Date.now();
    if (regionCache.data && now < regionCache.expiresAt) {
        return regionCache.data;
    }
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
        regionCache = { expiresAt: now + REGION_CACHE_TTL_MS, data: regionMap };
        return regionMap;
    } catch (err) {
        console.error('Error reading account regions:', err);
        return regionCache.data || {};
    }
}

router.get('/stats', (req, res) => {
    try {
        const now = Date.now();
        if (statsCache.data && now < statsCache.expiresAt) {
            return res.json(statsCache.data);
        }

        const totalRows = db.prepare(`SELECT COUNT(*) as count FROM messages`).get().count;
        const waRows = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE platform = 'whatsapp'`).get().count;
        const tgRows = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE platform = 'telegram'`).get().count;
        const mediaRows = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE has_media = 1`).get().count;
        
        const payload = {
            success: true,
            total: totalRows,
            platforms: {
                whatsapp: waRows,
                telegram: tgRows
            },
            withMedia: mediaRows
        };
        statsCache = { expiresAt: now + STATS_CACHE_TTL_MS, data: payload };
        res.json(payload);
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
            const mediaAvailable = isMediaAvailable(msg.media_path);
            return {
                ...msg,
                region: regionInfo.region || '',
                business_sector: regionInfo.business_sector || '',
                media_available: mediaAvailable,
                media_path: mediaAvailable ? msg.media_path : null
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
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [] });
        const alerts = adb.prepare(`
            SELECT id, alert_level as lvl, receiver_account as account, ai_title as text, 
                   created_at, business_sector
            FROM alert_records
            WHERE is_pushed = 1
            ORDER BY created_at DESC
            LIMIT 10
        `).all();
        
        const formattedAlerts = alerts.map(a => {
            return {
                id: a.id,
                lvl: a.lvl ? a.lvl.toUpperCase() : 'P1',
                text: a.text || a.account || '未知告警',
                time: shanghaiHourMinute(a.created_at),
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
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [] });
        const closedIssues = adb.prepare(`
            SELECT id, group_name, issue_type as text,
                   closed_at, business_sector as supplier,
                   duration_mins
            FROM issue_records
            WHERE status = 'closed' AND closed_at IS NOT NULL
            ORDER BY closed_at DESC
            LIMIT 10
        `).all();
        
        const formattedClosed = closedIssues.map(c => {
            return {
                id: c.id,
                supplier: c.supplier || c.group_name || '未知',
                text: c.text || '未知问题',
                time: shanghaiHourMinute(c.closed_at * 1000),
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
