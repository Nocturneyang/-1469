'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const ENV_FILE = process.env.RUNTIME_SECRET_ENV_FILE || path.join(DATA_DIR, '.env');
const SECRET_NAME = process.env.RUNTIME_SECRET_NAME ||
    process.env.CLOUD_COLLECTOR_SECRET_NAME ||
    'social-monitor-secrets';
const SECRET_KEYS = String(process.env.RUNTIME_SECRET_KEYS ||
    'JWT_SECRET,COLLECTOR_TOKEN,ACCOUNT_SESSION_ENCRYPTION_KEY,SYNC_TOKEN')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

function readFile(file) {
    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch (_) {
        return '';
    }
}

function getNamespace() {
    return process.env.KUBERNETES_NAMESPACE ||
        process.env.CLOUD_COLLECTOR_NAMESPACE ||
        readFile(path.join(SA_DIR, 'namespace'));
}

function decodeSecretData(secret) {
    const data = secret && secret.data ? secret.data : {};
    const values = {};
    for (const key of SECRET_KEYS) {
        if (!data[key]) continue;
        const value = Buffer.from(String(data[key]), 'base64').toString('utf8').trim();
        if (value) values[key] = value;
    }
    return values;
}

function fetchSecret() {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT || '443';
    const namespace = getNamespace();
    const token = readFile(path.join(SA_DIR, 'token'));
    const ca = readFile(path.join(SA_DIR, 'ca.crt'));

    if (!host || !namespace || !token) {
        console.log('[runtime-secrets] Kubernetes service account not available; skip hydration');
        return Promise.resolve(null);
    }

    const requestPath = `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(SECRET_NAME)}`;
    const options = {
        hostname: host,
        port,
        path: requestPath,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        ca: ca || undefined,
        timeout: 5000
    };

    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    console.warn(`[runtime-secrets] failed to read Secret ${SECRET_NAME}: HTTP ${res.statusCode}`);
                    resolve(null);
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    console.warn(`[runtime-secrets] failed to parse Secret ${SECRET_NAME}: ${err.message}`);
                    resolve(null);
                }
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', (err) => {
            console.warn(`[runtime-secrets] failed to read Secret ${SECRET_NAME}: ${err.message}`);
            resolve(null);
        });
        req.end();
    });
}

function quoteEnv(value) {
    return `"${String(value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')}"`;
}

function updateEnvFile(values) {
    if (!Object.keys(values).length) return [];

    let existing = '';
    try {
        existing = fs.readFileSync(ENV_FILE, 'utf8');
    } catch (_) {
        fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
    }

    const keys = new Set(Object.keys(values));
    const retained = existing
        .split(/\r?\n/)
        .filter((line) => {
            const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
            return !match || !keys.has(match[1]);
        });

    for (const key of keys) {
        retained.push(`${key}=${quoteEnv(values[key])}`);
    }

    fs.writeFileSync(ENV_FILE, `${retained.filter((line, index, arr) => line || index < arr.length - 1).join('\n')}\n`, {
        encoding: 'utf8',
        mode: 0o600
    });
    try { fs.chmodSync(ENV_FILE, 0o600); } catch (_) {}
    return Array.from(keys);
}

async function main() {
    const secret = await fetchSecret();
    const values = decodeSecretData(secret);
    const loaded = updateEnvFile(values);
    if (loaded.length) {
        console.log(`[runtime-secrets] hydrated ${loaded.length} key(s) into ${ENV_FILE}: ${loaded.join(', ')}`);
    } else {
        console.log(`[runtime-secrets] no configured keys found in Secret ${SECRET_NAME}`);
    }
}

main().catch((err) => {
    console.warn(`[runtime-secrets] hydration failed: ${err.message}`);
});
