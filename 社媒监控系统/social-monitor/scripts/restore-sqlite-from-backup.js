#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { listBackups } = require('./db-backup');
const { shanghaiFilenameTimestamp } = require('../lib/time');

const ROOT = process.env.DATA_DIR || path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const DEFAULT_ENV_FILE = '/tmp/social-monitor-recovery.env';
const DATABASES = [
    { name: 'database.sqlite', required: true, envName: 'DB_MAINTENANCE_MODE' },
    { name: 'analytics.sqlite', required: false, envName: 'ANALYTICS_MAINTENANCE_MODE' }
];

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i += 1) {
        const item = argv[i];
        if (!item.startsWith('--')) continue;
        const key = item.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i += 1;
        }
    }
    return args;
}

function checkSqlite(filePath) {
    const result = { ok: false, error: null, quickCheck: [] };
    if (!fs.existsSync(filePath)) {
        result.error = 'missing';
        return result;
    }

    let db = null;
    try {
        db = new Database(filePath, { readonly: true, fileMustExist: true });
        db.pragma('busy_timeout = 5000');
        result.quickCheck = db.prepare('PRAGMA quick_check(20)').all();
        const values = result.quickCheck
            .flatMap(row => Object.values(row))
            .map(value => String(value || '').toLowerCase());
        result.ok = values.length > 0 && values.every(value => value === 'ok');
        if (!result.ok) result.error = JSON.stringify(result.quickCheck);
    } catch (err) {
        result.error = err.message;
    } finally {
        if (db) {
            try { db.close(); } catch (_) {}
        }
    }
    return result;
}

function findValidBackup(dbName) {
    const backups = listBackups();
    for (const backup of backups) {
        const candidate = path.join(backup.path, dbName);
        const health = checkSqlite(candidate);
        if (health.ok) {
            return { backup, path: candidate, health };
        }
        if (fs.existsSync(candidate)) {
            console.warn(`[sqlite-restore] Skip invalid backup ${candidate}: ${health.error || 'quick_check failed'}`);
        }
    }
    return null;
}

function recoveryDir() {
    const stamp = shanghaiFilenameTimestamp().replace(/[^0-9A-Za-z_.-]+/g, '-');
    const dir = path.join(DB_DIR, `recovery-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function moveIfExists(source, targetDir) {
    if (!fs.existsSync(source)) return null;
    const target = path.join(targetDir, path.basename(source));
    fs.renameSync(source, target);
    return target;
}

function archiveLiveFiles(dbName, targetDir) {
    const livePath = path.join(DB_DIR, dbName);
    return [livePath, `${livePath}-wal`, `${livePath}-shm`]
        .map(file => moveIfExists(file, targetDir))
        .filter(Boolean);
}

function restoreFromBackup(dbName, backupPath) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    const archiveDir = recoveryDir();
    const archived = archiveLiveFiles(dbName, archiveDir);
    const livePath = path.join(DB_DIR, dbName);
    fs.copyFileSync(backupPath, livePath);
    const restored = checkSqlite(livePath);
    if (!restored.ok) {
        throw new Error(`restored ${dbName} failed quick_check: ${restored.error || 'unknown error'}`);
    }
    return { livePath, archiveDir, archived, restored };
}

function archiveBadOptionalDb(dbName) {
    const livePath = path.join(DB_DIR, dbName);
    if (!fs.existsSync(livePath)) return null;
    const archiveDir = recoveryDir();
    const archived = archiveLiveFiles(dbName, archiveDir);
    return { archiveDir, archived };
}

function writeEnvFile(filePath, values) {
    const content = Object.entries(values)
        .map(([key, value]) => `export ${key}=${value ? '1' : '0'}`)
        .join('\n') + '\n';
    fs.writeFileSync(filePath, content, 'utf8');
}

function recoverDatabase(item) {
    const livePath = path.join(DB_DIR, item.name);
    const current = checkSqlite(livePath);
    if (current.ok) {
        return { name: item.name, ok: true, action: 'kept-current', current };
    }

    console.warn(`[sqlite-restore] ${item.name} is unhealthy: ${current.error || 'quick_check failed'}`);
    const validBackup = findValidBackup(item.name);
    if (validBackup) {
        const restored = restoreFromBackup(item.name, validBackup.path);
        console.log(`[sqlite-restore] Restored ${item.name} from ${validBackup.path}`);
        return {
            name: item.name,
            ok: true,
            action: 'restored-from-backup',
            backup: validBackup.path,
            backupName: validBackup.backup.name,
            ...restored
        };
    }

    if (!item.required) {
        const archived = archiveBadOptionalDb(item.name);
        console.warn(`[sqlite-restore] No valid backup for optional ${item.name}; archived bad file and will allow re-init.`);
        return { name: item.name, ok: true, action: 'archived-optional-for-reinit', archived };
    }

    console.error(`[sqlite-restore] No valid backup found for required ${item.name}; keeping maintenance mode enabled.`);
    return { name: item.name, ok: false, action: 'no-valid-backup', current };
}

function main() {
    const args = parseArgs(process.argv);
    const envFile = args['env-file'] || DEFAULT_ENV_FILE;
    const results = DATABASES.map(recoverDatabase);
    const databaseOk = results.find(item => item.name === 'database.sqlite')?.ok === true;
    const analyticsOk = results.find(item => item.name === 'analytics.sqlite')?.ok === true;

    writeEnvFile(envFile, {
        DB_MAINTENANCE_MODE: !databaseOk,
        ANALYTICS_MAINTENANCE_MODE: !analyticsOk || !databaseOk
    });

    console.log(`[sqlite-restore] Recovery env written to ${envFile}`);
    console.log(JSON.stringify({ databaseOk, analyticsOk, results }, null, 2));

    if (!databaseOk) process.exitCode = 2;
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error(`[sqlite-restore] ${err.stack || err.message}`);
        try {
            writeEnvFile(DEFAULT_ENV_FILE, {
                DB_MAINTENANCE_MODE: true,
                ANALYTICS_MAINTENANCE_MODE: true
            });
        } catch (_) {}
        process.exit(1);
    }
}
