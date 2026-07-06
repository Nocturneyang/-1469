const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { shanghaiISOString } = require('./time');

const DURABLE_ENDPOINTS = new Set([
    '/api/collector/events',
    '/api/collector/messages',
    '/api/collector/media'
]);

function normalizeBaseUrl(baseUrl) {
    return String(baseUrl || '')
        .trim()
        .replace(/\/+$/, '')
        .replace(/\/api\/collector$/i, '');
}

function endpointFileName(endpoint) {
    return endpoint.replace(/^\/+/, '').replace(/[^a-zA-Z0-9_-]+/g, '_') + '.jsonl';
}

function createCollectorClient({ baseUrl, token, timeoutMs = 8000, logger = console, outboxDir = null } = {}) {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    if (!normalizedBaseUrl) return null;
    const durableEnabled = process.env.COLLECTOR_OUTBOX_ENABLED !== 'false';
    const queueDir = outboxDir || process.env.COLLECTOR_OUTBOX_DIR || path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'collector-outbox');
    const flushing = new Set();

    function enqueue(endpoint, payload) {
        if (!durableEnabled || !DURABLE_ENDPOINTS.has(endpoint)) return;
        try {
            fs.mkdirSync(queueDir, { recursive: true });
            const record = JSON.stringify({ endpoint, payload, queued_at: shanghaiISOString() });
            fs.appendFileSync(path.join(queueDir, endpointFileName(endpoint)), record + '\n', 'utf8');
        } catch (err) {
            logger.warn(`[CollectorClient] Failed to enqueue ${endpoint}: ${err.message}`);
        }
    }

    async function rawPost(endpoint, payload, options = {}) {
        const url = `${normalizedBaseUrl}${endpoint}`;
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await axios.post(url, payload, { headers, timeout: timeoutMs });
        return options.returnData ? response.data : true;
    }

    async function post(endpoint, payload, options = {}) {
        try {
            return await rawPost(endpoint, payload, options);
        } catch (err) {
            const status = err.response?.status;
            const detail = err.response?.data?.error || err.message;
            logger.warn(`[CollectorClient] POST ${endpoint} failed${status ? ` (${status})` : ''}: ${detail}`);
            enqueue(endpoint, payload);
            return false;
        }
    }

    async function flushEndpoint(endpoint) {
        if (!durableEnabled || flushing.has(endpoint)) return { sent: 0, kept: 0 };
        const file = path.join(queueDir, endpointFileName(endpoint));
        if (!fs.existsSync(file)) return { sent: 0, kept: 0 };

        flushing.add(endpoint);
        let sent = 0;
        const kept = [];
        try {
            const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
            for (const line of lines) {
                let record;
                try {
                    record = JSON.parse(line);
                } catch (_) {
                    continue;
                }

                try {
                    await rawPost(record.endpoint || endpoint, record.payload || {});
                    sent += 1;
                } catch (_) {
                    kept.push(line);
                }
            }

            if (kept.length) {
                fs.writeFileSync(file, kept.join('\n') + '\n', 'utf8');
            } else {
                fs.unlinkSync(file);
            }
        } catch (err) {
            logger.warn(`[CollectorClient] Failed to flush ${endpoint}: ${err.message}`);
        } finally {
            flushing.delete(endpoint);
        }
        return { sent, kept: kept.length };
    }

    async function flushOutbox() {
        const results = [];
        for (const endpoint of DURABLE_ENDPOINTS) {
            results.push(await flushEndpoint(endpoint));
        }
        return results;
    }

    if (durableEnabled) {
        const timer = setInterval(() => {
            flushOutbox().catch(err => logger.warn(`[CollectorClient] Outbox flush failed: ${err.message}`));
        }, Number(process.env.COLLECTOR_OUTBOX_FLUSH_MS || 30000));
        timer.unref();
        flushOutbox().catch(() => {});
    }

    return {
        baseUrl: normalizedBaseUrl,
        heartbeat: (payload) => post('/api/collector/heartbeat', payload),
        event: (payload) => post('/api/collector/events', payload),
        accountStatus: (payload) => post('/api/collector/account-status', payload),
        message: (payload) => post('/api/collector/messages', payload),
        media: (payload) => post('/api/collector/media', payload, { returnData: true }),
        flushOutbox
    };
}

module.exports = {
    createCollectorClient,
    normalizeBaseUrl
};
