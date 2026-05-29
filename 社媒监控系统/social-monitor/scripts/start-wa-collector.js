const fs = require('fs');
const path = require('path');

const accountName = process.env.ACCOUNT_NAME;
if (!accountName || !/^[a-zA-Z0-9_-]+$/.test(accountName)) {
    console.error('[WA Collector] ACCOUNT_NAME is required and must contain only letters, numbers, underscores or dashes');
    process.exit(1);
}

if (process.env.COLLECTOR_API_URL && !process.env.COLLECTOR_TOKEN) {
    console.error('[WA Collector] COLLECTOR_TOKEN is required when COLLECTOR_API_URL is configured');
    process.exit(1);
}

const dataDir = process.env.DATA_DIR || '/data';
for (const dir of ['db', 'media', 'config']) {
    fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
}

require('../workers/worker-wa');
