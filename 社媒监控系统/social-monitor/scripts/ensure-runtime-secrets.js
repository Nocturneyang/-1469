'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const ENV_FILE = process.env.RUNTIME_SECRET_ENV_FILE || path.join(DATA_DIR, '.env');
const SECRET_SPECS = [
    { key: 'JWT_SECRET', minLength: 32 },
    { key: 'COLLECTOR_TOKEN', minLength: 32 },
    { key: 'ACCOUNT_SESSION_ENCRYPTION_KEY', minLength: 32 }
];

function parseEnv(content) {
    const values = {};
    for (const line of String(content || '').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match) continue;
        let value = match[2] || '';
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        values[match[1]] = value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return values;
}

function quoteEnv(value) {
    return `"${String(value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')}"`;
}

function isUsable(value, spec) {
    const normalized = String(value || '').trim();
    return normalized.length >= spec.minLength && !/^your[_-]/i.test(normalized);
}

function randomSecret() {
    return crypto.randomBytes(48).toString('base64url');
}

function writeEnvFile(existing, updates) {
    const updateKeys = new Set(Object.keys(updates));
    const retained = String(existing || '')
        .split(/\r?\n/)
        .filter((line) => {
            const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
            return !match || !updateKeys.has(match[1]);
        })
        .filter((line, index, lines) => line || index < lines.length - 1);

    for (const key of updateKeys) {
        retained.push(`${key}=${quoteEnv(updates[key])}`);
    }

    fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
    fs.writeFileSync(ENV_FILE, `${retained.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(ENV_FILE, 0o600); } catch (_) {}
}

function main() {
    let existing = '';
    try {
        existing = fs.readFileSync(ENV_FILE, 'utf8');
    } catch (_) {
        existing = '';
    }

    const values = parseEnv(existing);
    const updates = {};
    for (const spec of SECRET_SPECS) {
        const current = process.env[spec.key] || values[spec.key];
        if (isUsable(current, spec)) continue;
        updates[spec.key] = randomSecret();
        process.env[spec.key] = updates[spec.key];
    }

    if (!Object.keys(updates).length) {
        console.log('[runtime-secrets] persistent runtime secrets already configured');
        return;
    }

    writeEnvFile(existing, updates);
    console.log(`[runtime-secrets] generated persistent key(s) in ${ENV_FILE}: ${Object.keys(updates).join(', ')}`);
}

main();
