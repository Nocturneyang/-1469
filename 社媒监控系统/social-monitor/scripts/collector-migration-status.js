#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.env') });

const DEFAULT_WA = ['wa_shebi'];
const DEFAULT_TG_USER = ['tgu_supplier', 'laffic_service'];

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i += 1) {
        const item = argv[i];
        if (!item.startsWith('--')) continue;
        const key = item.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) args[key] = true;
        else {
            args[key] = next;
            i += 1;
        }
    }
    return args;
}

function splitList(value, fallback) {
    if (!value) return fallback;
    return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function excludedSet(args) {
    return new Set(splitList(args.exclude || process.env.MIGRATION_EXCLUDE_ACCOUNTS, []));
}

function withoutExcluded(accounts, excluded) {
    return accounts.filter(account => !excluded.has(account));
}

function keyFor(accountName) {
    return String(accountName).toUpperCase().replace(/-/g, '_');
}

function sessionKey(accountName) {
    return `TG_USER_SESSION_${String(accountName).toUpperCase()}`;
}

function inspectWa(accountName) {
    const missing = [];
    if (!process.env.COLLECTOR_API_URL) missing.push('COLLECTOR_API_URL');
    if (!process.env.COLLECTOR_TOKEN) missing.push('COLLECTOR_TOKEN');
    return {
        type: 'wa',
        accountName,
        accountId: `wa-${accountName}`,
        migratable: missing.length === 0,
        missing,
        note: 'Existing session is not copied by manifest; first remote start may require QR login unless the session directory is migrated to the collector PVC.'
    };
}

function inspectTgUser(accountName) {
    const accountKey = keyFor(accountName);
    const apiId = process.env[`TG_API_ID_${accountKey}`] || process.env.TG_API_ID;
    const apiHash = process.env[`TG_API_HASH_${accountKey}`] || process.env.TG_API_HASH;
    const session = process.env[sessionKey(accountName)];
    const missing = [];
    if (!process.env.COLLECTOR_API_URL) missing.push('COLLECTOR_API_URL');
    if (!process.env.COLLECTOR_TOKEN) missing.push('COLLECTOR_TOKEN');
    if (!apiId) missing.push(`TG_API_ID_${accountKey} or TG_API_ID`);
    if (!apiHash) missing.push(`TG_API_HASH_${accountKey} or TG_API_HASH`);
    if (!session) missing.push(sessionKey(accountName));
    return {
        type: 'tgu',
        accountName,
        accountId: `tgu-${accountName}`,
        migratable: missing.length === 0,
        missing
    };
}

function main() {
    const args = parseArgs(process.argv);
    const excluded = excludedSet(args);
    const waAccounts = withoutExcluded(splitList(args.wa || process.env.MIGRATE_WA_ACCOUNTS, DEFAULT_WA), excluded);
    const tgUserAccounts = withoutExcluded(splitList(args.tgu || process.env.MIGRATE_TGU_ACCOUNTS, DEFAULT_TG_USER), excluded);
    const rows = [
        ...waAccounts.map(inspectWa),
        ...tgUserAccounts.map(inspectTgUser)
    ];

    if (args.json) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return;
    }

    console.table(rows.map(row => ({
        type: row.type,
        account: row.accountName,
        accountId: row.accountId,
        migratable: row.migratable ? 'yes' : 'no',
        missing: row.missing.join(', ') || '-'
    })));
}

if (require.main === module) {
    main();
}

module.exports = {
    inspectWa,
    inspectTgUser
};
