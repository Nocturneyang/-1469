'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SECRET_DIR = '/var/run/social-monitor-secrets';
const DEFAULT_SECRET_KEYS = [
    'JWT_SECRET',
    'COLLECTOR_TOKEN',
    'COLLECTOR_TOKEN_SHA256',
    'ACCOUNT_SESSION_ENCRYPTION_KEY',
    'SYNC_TOKEN'
];

function readSecretFile(dir, key) {
    const file = path.join(dir, key);
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) return '';
        return fs.readFileSync(file, 'utf8').trim();
    } catch (_) {
        return '';
    }
}

function hydrateRuntimeSecrets(keys = DEFAULT_SECRET_KEYS, options = {}) {
    const dir = options.dir || process.env.RUNTIME_SECRET_DIR || DEFAULT_SECRET_DIR;
    const logger = options.logger || console;
    const loaded = [];

    try {
        if (!dir || !fs.existsSync(dir)) return loaded;
    } catch (_) {
        return loaded;
    }

    for (const key of keys) {
        if (process.env[key]) continue;
        const value = readSecretFile(dir, key);
        if (!value) continue;
        process.env[key] = value;
        loaded.push(key);
    }

    if (loaded.length && logger && typeof logger.log === 'function') {
        logger.log(`[runtime-secrets] loaded ${loaded.length} key(s): ${loaded.join(', ')}`);
    }

    return loaded;
}

module.exports = {
    DEFAULT_SECRET_DIR,
    DEFAULT_SECRET_KEYS,
    hydrateRuntimeSecrets
};
