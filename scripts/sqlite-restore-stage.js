'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { resolveDataDir } = require('../db/paths');

async function main() {
  const snapshotDir = path.resolve(process.argv[2] || '');
  if (!snapshotDir || !fs.existsSync(path.join(snapshotDir, 'manifest.json'))) {
    throw new Error('usage: node scripts/sqlite-restore-stage.js <snapshot-directory>');
  }
  const restoreRoot = path.resolve(process.env.WORKBENCH_RESTORE_STAGE_DIR || path.join(resolveDataDir(), 'restore-staging'));
  if (isInside(restoreRoot, snapshotDir)) throw new Error('restore staging directory must not be inside the snapshot');
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'manifest.json'), 'utf8'));
  const stageDir = path.join(restoreRoot, `restore-${Date.now()}-${process.pid}`);
  fs.mkdirSync(stageDir, { recursive: true });
  try {
    for (const entry of manifest.files || []) {
      const source = confinedPath(snapshotDir, entry.file);
      const destination = confinedPath(stageDir, entry.file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const db = new Database(source, { readonly: true, fileMustExist: true });
      try {
        await db.backup(destination);
      } finally {
        db.close();
      }
      verifySqlite(destination);
    }
    fs.writeFileSync(path.join(stageDir, 'RESTORE_READY.json'), `${JSON.stringify({
      source_snapshot: snapshotDir,
      verified_at: new Date().toISOString(),
      database_count: (manifest.files || []).length,
      activation: 'manual-only',
    }, null, 2)}\n`);
    console.log(`[workbench-restore] verified staging directory: ${stageDir}`);
    console.log('[workbench-restore] no live database was replaced; activation requires an explicit manual switch');
  } catch (err) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw err;
  }
}

function confinedPath(root, relative) {
  const resolved = path.resolve(root, String(relative || ''));
  const rel = path.relative(path.resolve(root), resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`unsafe manifest path: ${relative}`);
  return resolved;
}

function verifySqlite(filePath) {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma('integrity_check', { simple: true });
    if (String(result).toLowerCase() !== 'ok') throw new Error(`integrity_check failed for ${filePath}: ${result}`);
  } finally {
    db.close();
  }
}

function isInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

main().catch((err) => {
  console.error(`[workbench-restore] ${err.stack || err.message}`);
  process.exitCode = 1;
});
