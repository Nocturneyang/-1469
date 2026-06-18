#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { checkStorageWatermark } = require('../lib/storage-health');

const ROOT = process.env.DATA_DIR || path.resolve(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const DB_FILES = ['database.sqlite', 'analytics.sqlite'];

function hasFlag(name) {
  return process.argv.includes(name);
}

function formatMb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function fileInfo(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, bytes: 0, mb: 0 };
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    bytes: stat.size,
    mb: formatMb(stat.size),
    mtime: stat.mtime.toISOString(),
  };
}

function runPragmaRows(db, sql) {
  return db.prepare(sql).all();
}

function checkDatabase(name) {
  const filePath = path.join(DB_DIR, name);
  const info = fileInfo(filePath);
  const wal = fileInfo(`${filePath}-wal`);
  const shm = fileInfo(`${filePath}-shm`);
  const result = {
    name,
    path: filePath,
    file: info,
    wal,
    shm,
    ok: false,
    quickCheck: [],
    integrityCheck: [],
    error: null,
  };

  if (!info.exists) {
    result.ok = name === 'analytics.sqlite';
    result.error = 'missing';
    return result;
  }

  let db = null;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    result.quickCheck = runPragmaRows(db, 'PRAGMA quick_check(20)');
    if (hasFlag('--integrity')) {
      result.integrityCheck = runPragmaRows(db, 'PRAGMA integrity_check');
    }
    const quickValues = result.quickCheck
      .flatMap(row => Object.values(row))
      .map(value => String(value || '').toLowerCase());
    result.ok = quickValues.length > 0 && quickValues.every(value => value === 'ok');
  } catch (err) {
    result.ok = false;
    result.error = err.message;
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
  }

  return result;
}

function printHuman(report) {
  const storage = report.storage;
  console.log(`DATA_DIR: ${ROOT}`);
  console.log(`Storage: free=${storage.freeMb ?? '?'}MB (${storage.freePercent ?? '?'}%), min=${storage.minFreeMb ?? '?'}MB/${storage.minFreePercent ?? '?'}%, ok=${storage.ok}`);
  for (const db of report.databases) {
    console.log('');
    console.log(`${db.name}: ok=${db.ok}`);
    console.log(`  file=${db.file.exists ? `${db.file.mb}MB` : 'missing'} wal=${db.wal.exists ? `${db.wal.mb}MB` : 'none'} shm=${db.shm.exists ? `${db.shm.mb}MB` : 'none'}`);
    if (db.error) console.log(`  error=${db.error}`);
    if (db.quickCheck.length) console.log(`  quick_check=${JSON.stringify(db.quickCheck)}`);
    if (db.integrityCheck.length) console.log(`  integrity_check_rows=${db.integrityCheck.length}`);
  }
}

function main() {
  const report = {
    ok: true,
    dataDir: ROOT,
    storage: checkStorageWatermark({ path: ROOT }),
    databases: DB_FILES.map(checkDatabase),
  };
  report.ok = report.storage.ok && report.databases.every(db => db.ok);

  if (hasFlag('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }

  if (!report.ok) process.exitCode = 2;
}

if (require.main === module) {
  main();
}
