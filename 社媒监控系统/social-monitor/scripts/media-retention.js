#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { db } = require('../db/database');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

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

function toNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function formatMb(bytes) {
    return Number((bytes / 1024 / 1024).toFixed(2));
}

function normalizeMediaPath(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const noQuery = raw.split('?')[0].replace(/\\/g, '/').replace(/^\/+/, '');
    if (noQuery.startsWith('media/')) return noQuery;
    return `media/${path.posix.basename(noQuery)}`;
}

function getReferencedMedia() {
    const rows = db.prepare(`
        SELECT id, media_path
        FROM messages
        WHERE media_path IS NOT NULL AND media_path != ''
    `).all();
    const refs = new Map();

    for (const row of rows) {
        const normalized = normalizeMediaPath(row.media_path);
        if (!normalized) continue;
        const list = refs.get(normalized) || [];
        list.push(row.id);
        refs.set(normalized, list);
    }

    return refs;
}

function walkFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    const files = [];
    const stack = [dir];

    while (stack.length) {
        const current = stack.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const absolutePath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(absolutePath);
            } else if (entry.isFile()) {
                const stat = fs.statSync(absolutePath);
                const relativePath = path.relative(DATA_DIR, absolutePath).replace(/\\/g, '/');
                files.push({
                    absolutePath,
                    relativePath,
                    bytes: stat.size,
                    mtimeMs: stat.mtimeMs,
                    ageDays: (Date.now() - stat.mtimeMs) / 86400000
                });
            }
        }
    }

    return files;
}

function analyze(options) {
    const refs = getReferencedMedia();
    const files = walkFiles(MEDIA_DIR);
    const orphanGraceDays = toNumber(options.orphanGraceDays, 7);
    const retentionDays = toNumber(options.retentionDays, 0);
    const includeReferenced = Boolean(options.includeReferenced);

    const summary = {
        mediaDir: MEDIA_DIR,
        totalFiles: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
        referencedFiles: 0,
        referencedBytes: 0,
        orphanFiles: 0,
        orphanBytes: 0,
        eligibleFiles: 0,
        eligibleBytes: 0,
        orphanGraceDays,
        retentionDays,
        includeReferenced,
        execute: Boolean(options.execute)
    };
    const eligible = [];

    for (const file of files) {
        const refIds = refs.get(file.relativePath) || refs.get(normalizeMediaPath(file.relativePath)) || [];
        const referenced = refIds.length > 0;
        if (referenced) {
            summary.referencedFiles += 1;
            summary.referencedBytes += file.bytes;
        } else {
            summary.orphanFiles += 1;
            summary.orphanBytes += file.bytes;
        }

        const orphanEligible = !referenced && file.ageDays >= orphanGraceDays;
        const referencedEligible = referenced && includeReferenced && retentionDays > 0 && file.ageDays >= retentionDays;
        if (orphanEligible || referencedEligible) {
            eligible.push({
                ...file,
                referenced,
                messageIds: refIds,
                reason: orphanEligible ? 'orphan' : `referenced_older_than_${retentionDays}d`
            });
            summary.eligibleFiles += 1;
            summary.eligibleBytes += file.bytes;
        }
    }

    return { summary, eligible };
}

function applyRetention(eligible) {
    const deleted = [];
    const failed = [];
    const clearMessageMedia = db.transaction((messageIds) => {
        const stmt = db.prepare(`
            UPDATE messages
            SET has_media = 0, media_path = NULL
            WHERE id = ?
        `);
        for (const id of messageIds) stmt.run(id);
    });

    for (const file of eligible) {
        try {
            fs.unlinkSync(file.absolutePath);
            if (file.referenced && file.messageIds.length) clearMessageMedia(file.messageIds);
            deleted.push(file);
        } catch (err) {
            failed.push({
                relativePath: file.relativePath,
                error: err.message
            });
        }
    }

    return { deleted, failed };
}

function printHuman(result, applied) {
    const { summary } = result;
    console.log(`Media dir: ${summary.mediaDir}`);
    console.log(`Files: ${summary.totalFiles}, total=${formatMb(summary.totalBytes)}MB`);
    console.log(`Referenced: ${summary.referencedFiles}, ${formatMb(summary.referencedBytes)}MB`);
    console.log(`Orphan: ${summary.orphanFiles}, ${formatMb(summary.orphanBytes)}MB`);
    console.log(`Eligible: ${summary.eligibleFiles}, ${formatMb(summary.eligibleBytes)}MB`);
    console.log(`Mode: ${summary.execute ? 'execute' : 'dry-run'}`);
    if (applied) {
        console.log(`Deleted: ${applied.deleted.length}, failed=${applied.failed.length}`);
    } else if (summary.eligibleFiles > 0) {
        console.log('Run with --execute to delete eligible files.');
    }
}

function main() {
    const args = parseArgs(process.argv);
    const options = {
        execute: Boolean(args.execute),
        json: Boolean(args.json),
        orphanGraceDays: args['orphan-grace-days'] || process.env.MEDIA_ORPHAN_GRACE_DAYS || 7,
        retentionDays: args['retention-days'] || process.env.MEDIA_RETENTION_DAYS || 0,
        includeReferenced: Boolean(args['include-referenced'])
    };
    const result = analyze(options);
    const applied = options.execute ? applyRetention(result.eligible) : null;
    const output = {
        ...result,
        applied: applied ? {
            deletedFiles: applied.deleted.length,
            deletedBytes: applied.deleted.reduce((sum, file) => sum + file.bytes, 0),
            failed: applied.failed
        } : null
    };

    if (options.json) {
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
        printHuman(result, applied);
    }

    if (applied && applied.failed.length) process.exitCode = 1;
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error(`[media-retention] ${err.message}`);
        process.exit(1);
    }
}

module.exports = {
    analyze,
    normalizeMediaPath
};
