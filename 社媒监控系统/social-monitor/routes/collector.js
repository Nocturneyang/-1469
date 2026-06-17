const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    db,
    saveMessage,
    updateAccountStatus,
    upsertCollectorHeartbeat,
    recordRuntimeEvent
} = require('../db/database');

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const FALLBACK_COLLECTOR_TOKEN_SHA256 = '2e51b53cf6e7da87425363b6d9ada8ed5d07532f1b862b02057700a13640caa6';

function sanitizeSegment(value, fallback = 'file') {
    const safe = String(value || '')
        .replace(/[^a-zA-Z0-9_.-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120);
    return safe || fallback;
}

function extensionFromMime(mimetype, requestedExt) {
    const ext = sanitizeSegment(requestedExt || '', '').replace(/^\./, '').toLowerCase();
    if (ext && /^[a-z0-9]{1,8}$/.test(ext)) return ext;

    const normalized = String(mimetype || '').split(';')[0].trim().toLowerCase();
    const map = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'audio/ogg': 'ogg',
        'audio/mpeg': 'mp3',
        'video/mp4': 'mp4',
        'application/pdf': 'pdf'
    };
    return map[normalized] || 'bin';
}

function getBearerToken(req) {
    const auth = req.headers.authorization || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : '';
}

function requireCollectorToken(req, res, next) {
    const expected = process.env.COLLECTOR_TOKEN || '';
    const expectedHash = process.env.COLLECTOR_TOKEN_SHA256 || FALLBACK_COLLECTOR_TOKEN_SHA256;
    const token = getBearerToken(req) || req.headers['x-collector-token'] || '';

    if (expected) {
        if (token !== expected) {
            return res.status(401).json({ success: false, error: 'Invalid collector token' });
        }
        return next();
    }

    if (!expectedHash) {
        return res.status(503).json({ success: false, error: 'COLLECTOR_TOKEN is not configured' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    if (tokenHash !== expectedHash) {
        return res.status(401).json({ success: false, error: 'Invalid collector token' });
    }

    next();
}

router.use(requireCollectorToken);

router.post('/heartbeat', (req, res) => {
    try {
        const body = req.body || {};
        if (!body.accountId || !body.collectorId) {
            return res.status(400).json({ success: false, error: 'accountId and collectorId are required' });
        }

        upsertCollectorHeartbeat(body);
        res.json({ success: true });
    } catch (err) {
        console.error('[Collector API] heartbeat failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/events', (req, res) => {
    try {
        const body = req.body || {};
        if (!body.accountId || !body.eventType) {
            return res.status(400).json({ success: false, error: 'accountId and eventType are required' });
        }

        recordRuntimeEvent(body);
        res.json({ success: true });
    } catch (err) {
        console.error('[Collector API] event failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/account-status', (req, res) => {
    try {
        const body = req.body || {};
        if (!body.id || !body.platform || !body.status) {
            return res.status(400).json({ success: false, error: 'id, platform and status are required' });
        }

        updateAccountStatus(body.id, body.platform, body.status, body.pushname || null, body.qrCode || null);
        if (body.chromeVersion) {
            db.prepare(`
                UPDATE accounts
                SET chrome_version = ?, updated_at = datetime('now', '+8 hours')
                WHERE id = ?
            `).run(body.chromeVersion, body.id);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Collector API] account status failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/messages', (req, res) => {
    try {
        const body = req.body || {};
        if (!body.platform || !body.receiver_account || !body.message_id) {
            return res.status(400).json({ success: false, error: 'platform, receiver_account and message_id are required' });
        }

        const result = saveMessage(body);
        res.json({ success: true, changes: result?.changes || 0 });
    } catch (err) {
        console.error('[Collector API] message failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/messages/batch', (req, res) => {
    try {
        const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
        if (!messages.length) {
            return res.status(400).json({ success: false, error: 'messages array is required' });
        }

        let inserted = 0;
        let skipped = 0;
        const persistBatch = db.transaction(() => {
            for (const body of messages) {
                if (!body || !body.platform || !body.receiver_account || !body.message_id) {
                    skipped += 1;
                    continue;
                }
                const result = saveMessage(body);
                inserted += result?.changes || 0;
            }
        });

        persistBatch();
        res.json({
            success: true,
            received: messages.length,
            inserted,
            duplicates: messages.length - inserted - skipped,
            skipped
        });
    } catch (err) {
        console.error('[Collector API] message batch failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/media', (req, res) => {
    try {
        const body = req.body || {};
        if (!body.accountId || !body.messageId || !body.data) {
            return res.status(400).json({ success: false, error: 'accountId, messageId and data are required' });
        }

        const buffer = Buffer.from(String(body.data), 'base64');
        if (!buffer.length) {
            return res.status(400).json({ success: false, error: 'media data is empty' });
        }

        fs.mkdirSync(MEDIA_DIR, { recursive: true });
        const account = sanitizeSegment(body.accountId);
        const messageId = sanitizeSegment(body.messageId, 'message');
        const ext = extensionFromMime(body.mimetype, body.ext);
        const filename = `wa_${account}_${messageId}_${Date.now()}.${ext}`;
        const absolutePath = path.join(MEDIA_DIR, filename);
        fs.writeFileSync(absolutePath, buffer);

        res.json({
            success: true,
            media_path: `media/${filename}`,
            bytes: buffer.length
        });
    } catch (err) {
        console.error('[Collector API] media failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
