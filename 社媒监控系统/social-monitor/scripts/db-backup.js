#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { shanghaiFilenameTimestamp, shanghaiISOString } = require('../lib/time');

const ROOT = process.env.DATA_DIR || path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(ROOT, 'backups');

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

function timestamp() {
    return shanghaiFilenameTimestamp().replace(/\./g, '-');
}

function safeName(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function fileInfo(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    return {
        path: filePath,
        bytes: stat.size,
        mtime: shanghaiISOString(stat.mtime)
    };
}

async function backupSqlite(source, destination) {
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
        await db.backup(destination);
    } finally {
        db.close();
    }
}

async function createBackup(options = {}) {
    const label = safeName(options.label || timestamp());
    const targetDir = path.join(BACKUP_DIR, label);
    fs.mkdirSync(targetDir, { recursive: true });

    const databases = [
        { name: 'database.sqlite', required: true },
        { name: 'analytics.sqlite', required: false }
    ];
    const manifest = {
        createdAt: shanghaiISOString(),
        root: ROOT,
        targetDir,
        files: []
    };

    for (const item of databases) {
        const source = path.join(DB_DIR, item.name);
        const destination = path.join(targetDir, item.name);
        if (!fs.existsSync(source)) {
            manifest.files.push({ name: item.name, skipped: true, required: item.required, reason: 'missing' });
            if (item.required) throw new Error(`Required database is missing: ${source}`);
            continue;
        }

        await backupSqlite(source, destination);
        manifest.files.push({
            name: item.name,
            required: item.required,
            source: fileInfo(source),
            backup: fileInfo(destination)
        });
    }

    fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return manifest;
}

function listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
            const dir = path.join(BACKUP_DIR, entry.name);
            const manifestPath = path.join(dir, 'manifest.json');
            const stat = fs.statSync(dir);
            let manifest = null;
            try {
                manifest = fs.existsSync(manifestPath)
                    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
                    : null;
            } catch (_) {
                manifest = null;
            }
            return {
                name: entry.name,
                path: dir,
                createdAt: manifest?.createdAt || shanghaiISOString(stat.mtime),
                files: manifest?.files || []
            };
        })
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function pruneBackups(retentionDays, execute) {
    const cutoff = Date.now() - retentionDays * 86400000;
    const eligible = listBackups().filter(item => new Date(item.createdAt).getTime() < cutoff);
    const deleted = [];
    const failed = [];

    if (execute) {
        for (const item of eligible) {
            try {
                fs.rmSync(item.path, { recursive: true, force: true });
                deleted.push(item);
            } catch (err) {
                failed.push({ ...item, error: err.message });
            }
        }
    }

    return { eligible, deleted, failed };
}

function printList(backups) {
    if (!backups.length) {
        console.log(`No backups found in ${BACKUP_DIR}`);
        return;
    }
    console.table(backups.map(item => ({
        name: item.name,
        createdAt: item.createdAt,
        files: item.files.filter(file => !file.skipped).map(file => file.name).join(', ')
    })));
}

async function main() {
    const args = parseArgs(process.argv);
    const mode = args.list ? 'list' : (args.prune ? 'prune' : 'backup');

    if (mode === 'list') {
        const backups = listBackups();
        if (args.json) process.stdout.write(`${JSON.stringify(backups, null, 2)}\n`);
        else printList(backups);
        return;
    }

    if (mode === 'prune') {
        const retentionDays = Number(args['retention-days'] || process.env.BACKUP_RETENTION_DAYS || 14);
        const result = pruneBackups(retentionDays, Boolean(args.execute));
        if (args.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
            console.log(`Eligible backups older than ${retentionDays}d: ${result.eligible.length}`);
            console.log(`Deleted: ${result.deleted.length}, failed=${result.failed.length}`);
            if (!args.execute && result.eligible.length) console.log('Run with --prune --execute to delete eligible backups.');
        }
        if (result.failed.length) process.exitCode = 1;
        return;
    }

    const manifest = await createBackup({ label: args.label });
    if (args.json) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    else {
        console.log(`Backup created: ${manifest.targetDir}`);
        for (const file of manifest.files) {
            if (file.skipped) console.log(`- ${file.name}: skipped (${file.reason})`);
            else console.log(`- ${file.name}: ${file.backup.bytes} bytes`);
        }
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error(`[db-backup] ${err.message}`);
        process.exit(1);
    });
}

module.exports = {
    createBackup,
    listBackups,
    pruneBackups
};
