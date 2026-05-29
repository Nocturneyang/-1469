#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const accountName = process.env.TG_ACCOUNT_NAME || process.env.ACCOUNT_NAME;
if (!accountName || !/^[a-zA-Z0-9_-]+$/.test(accountName)) {
    console.error('[TG Collector] TG_ACCOUNT_NAME is required and must contain only letters, numbers, underscores or dashes');
    process.exit(1);
}

if (process.env.COLLECTOR_API_URL && !process.env.COLLECTOR_TOKEN) {
    console.error('[TG Collector] COLLECTOR_TOKEN is required when COLLECTOR_API_URL is configured');
    process.exit(1);
}

process.env.TG_ACCOUNT_NAME = accountName;

const dataDir = process.env.DATA_DIR || '/data';
for (const dir of ['db', 'media', 'config']) {
    fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
}

const type = String(process.env.TG_COLLECTOR_TYPE || 'user').toLowerCase();
if (type === 'bot') {
    require('../workers/worker-tg');
} else {
    require('../workers/worker-tg-user');
}
