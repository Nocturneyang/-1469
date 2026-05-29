#!/usr/bin/env node
const path = require('path');
const { getWaWebVersionCacheInfo } = require('../lib/wa-chrome-runtime');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');
const info = getWaWebVersionCacheInfo(dataDir);

console.log(`WA WebVersion cache: ${info.cacheDir}`);
if (!info.exists || info.files.length === 0) {
    console.log('No cached WhatsApp Web HTML files found.');
    process.exit(0);
}

console.log(`Latest: ${info.latest ? info.latest.file : '-'}`);
console.table(info.files.map(file => ({
    file: file.file,
    version: file.version || '-',
    size_kb: file.sizeKb,
    age_hours: file.ageHours
})));
