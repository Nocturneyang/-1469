#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { configureSqlite, sqliteJournalMode } = require('../lib/sqlite-runtime');

const ROOT = process.env.DATA_DIR || path.resolve(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const DB_FILES = [
  { name: 'database.sqlite', required: false },
  { name: 'analytics.sqlite', required: false },
];

function configureFile(file) {
  const dbPath = path.join(DB_DIR, file.name);
  if (!fs.existsSync(dbPath)) {
    const message = `[sqlite-storage] ${file.name} missing, skip`;
    if (file.required) throw new Error(message);
    console.log(message);
    return;
  }

  const db = new Database(dbPath);
  try {
    const result = configureSqlite(db, { label: file.name });
    console.log(`[sqlite-storage] ${file.name}: journal=${result.journalMode}, busy_timeout=${result.busyTimeoutMs}ms`);
  } finally {
    db.close();
  }
}

function main() {
  console.log(`[sqlite-storage] configuring ${DB_DIR} with target journal=${sqliteJournalMode()}`);
  for (const file of DB_FILES) configureFile(file);
}

main();
