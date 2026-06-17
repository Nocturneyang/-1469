#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { shanghaiISOString, shanghaiMonthKey } = require('../lib/time');

const ROOT = process.env.DATA_DIR || path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const SOURCE_DB_PATH = path.join(DB_DIR, 'database.sqlite');
const ANALYTICS_DB_PATH = path.join(DB_DIR, 'analytics.sqlite');
const DEFAULT_ARCHIVE_DIR = path.join(DB_DIR, 'archives');

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

function toPositiveNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function monthKey(timestamp) {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) return 'unknown';
    return shanghaiMonthKey(date);
}

function getColumns(db) {
    return db.prepare('PRAGMA table_info(messages)').all().map(col => col.name);
}

function ensureArchiveSchema(sourceDb, archiveDb) {
    const row = sourceDb.prepare(`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table' AND name = 'messages'
    `).get();
    if (!row?.sql) throw new Error('messages table schema not found');

    const createSql = row.sql.replace(/^CREATE TABLE\s+messages/i, 'CREATE TABLE IF NOT EXISTS messages');
    archiveDb.exec(`
        ${createSql};
        CREATE TABLE IF NOT EXISTS archive_manifest (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_db TEXT NOT NULL,
            cutoff_ts INTEGER NOT NULL,
            archived_month TEXT NOT NULL,
            archived_rows INTEGER NOT NULL,
            min_msg_id INTEGER,
            max_msg_id INTEGER,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        );
        CREATE INDEX IF NOT EXISTS idx_archive_messages_timestamp ON messages(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_archive_messages_group_name ON messages(group_name);
        CREATE INDEX IF NOT EXISTS idx_archive_messages_receiver ON messages(receiver_account);
    `);
}

function getCursorGate(maxEligibleId) {
    if (!fs.existsSync(ANALYTICS_DB_PATH)) {
        return { ok: false, reason: 'analytics.sqlite missing', cursors: [] };
    }

    const analyticsDb = new Database(ANALYTICS_DB_PATH, { readonly: true, fileMustExist: true });
    try {
        const table = analyticsDb.prepare(`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = 'analysis_cursor'
        `).get();
        if (!table) return { ok: false, reason: 'analysis_cursor missing', cursors: [] };

        const cursors = analyticsDb.prepare(`
            SELECT analyzer, last_msg_id, updated_at
            FROM analysis_cursor
            ORDER BY analyzer
        `).all();
        if (cursors.length === 0) {
            return { ok: false, reason: 'analysis_cursor empty', cursors, blocking: [] };
        }
        const blocking = cursors.filter(row => Number(row.last_msg_id || 0) < maxEligibleId);
        return {
            ok: blocking.length === 0,
            reason: blocking.length ? 'cursor_not_caught_up' : 'ok',
            cursors,
            blocking
        };
    } finally {
        analyticsDb.close();
    }
}

function summarizeEligible(sourceDb, cutoffTs, maxRows) {
    const summary = sourceDb.prepare(`
        SELECT
            COUNT(*) AS total_rows,
            MIN(id) AS min_msg_id,
            MAX(id) AS max_msg_id,
            MIN(timestamp) AS min_ts,
            MAX(timestamp) AS max_ts
        FROM messages
        WHERE timestamp IS NOT NULL
          AND timestamp < ?
    `).get(cutoffTs);

    const byMonthRows = sourceDb.prepare(`
        SELECT id, timestamp
        FROM messages
        WHERE timestamp IS NOT NULL
          AND timestamp < ?
        ORDER BY timestamp ASC, id ASC
        LIMIT ?
    `).all(cutoffTs, maxRows);

    const byMonth = new Map();
    for (const row of byMonthRows) {
        const key = monthKey(row.timestamp);
        const item = byMonth.get(key) || { month: key, rows: 0, min_msg_id: row.id, max_msg_id: row.id };
        item.rows += 1;
        item.min_msg_id = Math.min(item.min_msg_id, row.id);
        item.max_msg_id = Math.max(item.max_msg_id, row.id);
        byMonth.set(key, item);
    }

    return {
        totalRows: summary.total_rows || 0,
        selectedRows: byMonthRows.length,
        minMsgId: summary.min_msg_id || null,
        maxMsgId: summary.max_msg_id || null,
        minTimestamp: summary.min_ts || null,
        maxTimestamp: summary.max_ts || null,
        truncated: (summary.total_rows || 0) > byMonthRows.length,
        byMonth: Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month))
    };
}

function archiveMonth(sourceDb, columns, archiveDir, cutoffTs, month, maxRows) {
    const rows = sourceDb.prepare(`
        SELECT *
        FROM messages
        WHERE timestamp IS NOT NULL
          AND timestamp < ?
        ORDER BY timestamp ASC, id ASC
        LIMIT ?
    `).all(cutoffTs, maxRows).filter(row => monthKey(row.timestamp) === month);

    if (!rows.length) return { month, archivedRows: 0, deletedRows: 0 };

    fs.mkdirSync(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `database-archive-${month}.sqlite`);
    const archiveDb = new Database(archivePath);
    archiveDb.pragma('journal_mode = WAL');

    try {
        ensureArchiveSchema(sourceDb, archiveDb);
        const columnList = columns.map(col => `"${col}"`).join(', ');
        const valueList = columns.map(col => `@${col}`).join(', ');
        const insert = archiveDb.prepare(`INSERT OR IGNORE INTO messages (${columnList}) VALUES (${valueList})`);
        const insertManifest = archiveDb.prepare(`
            INSERT INTO archive_manifest
              (source_db, cutoff_ts, archived_month, archived_rows, min_msg_id, max_msg_id)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const writeArchive = archiveDb.transaction((items) => {
            for (const row of items) insert.run(row);
            insertManifest.run(
                SOURCE_DB_PATH,
                cutoffTs,
                month,
                items.length,
                Math.min(...items.map(row => row.id)),
                Math.max(...items.map(row => row.id))
            );
        });
        writeArchive(rows);
    } finally {
        archiveDb.close();
    }

    const deleteStmt = sourceDb.prepare('DELETE FROM messages WHERE id = ?');
    const deleteRows = sourceDb.transaction((items) => {
        let deleted = 0;
        for (const row of items) {
            deleted += deleteStmt.run(row.id).changes;
        }
        return deleted;
    });

    return {
        month,
        archivePath,
        archivedRows: rows.length,
        deletedRows: deleteRows(rows),
        minMsgId: Math.min(...rows.map(row => row.id)),
        maxMsgId: Math.max(...rows.map(row => row.id))
    };
}

function runArchive(options) {
    const execute = Boolean(options.execute);
    const retentionDays = toPositiveNumber(options.retentionDays || process.env.MESSAGE_ARCHIVE_RETENTION_DAYS, 180);
    const maxRows = toPositiveNumber(options.maxRows || process.env.MESSAGE_ARCHIVE_MAX_ROWS, 50000);
    const archiveDir = options.archiveDir || process.env.MESSAGE_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR;
    const cutoffTs = Date.now() - retentionDays * 86400000;

    const sourceDb = new Database(SOURCE_DB_PATH, {
        readonly: !execute,
        fileMustExist: true
    });

    try {
        const summary = summarizeEligible(sourceDb, cutoffTs, maxRows);
        const cursorGate = summary.maxMsgId ? getCursorGate(summary.maxMsgId) : { ok: true, reason: 'no_eligible_rows', cursors: [] };
        const result = {
            mode: execute ? 'execute' : 'dry-run',
            sourceDb: SOURCE_DB_PATH,
            archiveDir,
            retentionDays,
            cutoffTs,
            cutoffIso: shanghaiISOString(cutoffTs),
            maxRows,
            summary,
            cursorGate,
            applied: []
        };

        if (!execute || summary.selectedRows === 0) return result;
        if (!cursorGate.ok && !options.force) {
            result.blocked = true;
            result.blockReason = cursorGate.reason;
            return result;
        }

        const columns = getColumns(sourceDb);
        for (const item of summary.byMonth) {
            const applied = archiveMonth(sourceDb, columns, archiveDir, cutoffTs, item.month, maxRows);
            result.applied.push(applied);
        }
        return result;
    } finally {
        sourceDb.close();
    }
}

function printHuman(result) {
    console.log(`Mode: ${result.mode}`);
    console.log(`Source DB: ${result.sourceDb}`);
    console.log(`Archive dir: ${result.archiveDir}`);
    console.log(`Cutoff: ${result.cutoffIso} (${result.retentionDays}d)`);
    console.log(`Eligible rows: ${result.summary.totalRows}, selected this run: ${result.summary.selectedRows}`);
    if (result.summary.truncated) {
        console.log(`Selection capped by --max-rows=${result.maxRows}; run again after execute.`);
    }
    if (result.summary.byMonth.length) {
        console.table(result.summary.byMonth);
    }
    if (!result.cursorGate.ok) {
        console.log(`Cursor gate: blocked (${result.cursorGate.reason})`);
        console.table((result.cursorGate.blocking || []).map(row => ({
            analyzer: row.analyzer,
            last_msg_id: row.last_msg_id,
            updated_at: row.updated_at
        })));
    } else {
        console.log(`Cursor gate: ${result.cursorGate.reason}`);
    }
    if (result.blocked) {
        console.log('Archive not executed. Use --force only after manually confirming analyzers no longer need these messages.');
    } else if (result.mode === 'dry-run' && result.summary.selectedRows > 0) {
        console.log('Run with --execute to move selected messages into monthly archive DBs.');
    } else if (result.applied.length) {
        console.table(result.applied);
    }
}

function main() {
    const args = parseArgs(process.argv);
    const result = runArchive({
        execute: Boolean(args.execute),
        force: Boolean(args.force),
        retentionDays: args['retention-days'],
        maxRows: args['max-rows'],
        archiveDir: args['archive-dir']
    });

    if (args.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
        printHuman(result);
    }

    if (result.blocked) process.exitCode = 1;
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error(`[archive-messages] ${err.message}`);
        process.exit(1);
    }
}

module.exports = {
    runArchive,
    summarizeEligible,
    getCursorGate
};
