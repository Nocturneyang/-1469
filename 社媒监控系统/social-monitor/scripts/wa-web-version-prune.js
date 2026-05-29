#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { getWaWebVersionCacheInfo } = require('../lib/wa-chrome-runtime');

const keep = Math.max(1, Number(process.argv[2] || 5));
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');
const info = getWaWebVersionCacheInfo(dataDir);

if (!info.exists || info.files.length === 0) {
    console.log('No cached WhatsApp Web HTML files found.');
    process.exit(0);
}

const versioned = info.files.filter(file => file.version);
const remove = versioned.slice(keep);

for (const file of remove) {
    fs.unlinkSync(file.path);
    console.log(`Removed ${file.file}`);
}

console.log(`Kept ${Math.min(keep, versioned.length)} versioned cache files; removed ${remove.length}.`);
