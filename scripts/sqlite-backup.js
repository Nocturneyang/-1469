'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { DEFAULT_AUTH_DB_PATH } = require('../db/auth-db');
const { DEFAULT_RAW_DB_PATH } = require('../db/raw-db');
const { DEFAULT_RUNTIME_DB_PATH } = require('../db/runtime-db');
const { DEFAULT_WORKBENCH_DB_PATH } = require('../db/workbench-db');
const { listAccountRefs } = require('../db/account-db');
const { resolveDataDir } = require('../db/paths');

async function main() {
  const cadence = process.argv[2] === 'weekly' ? 'weekly' : 'daily';
  const backupRoot = path.resolve(process.env.WORKBENCH_BACKUP_DIR || path.join(resolveDataDir(), 'backups'));
  const sourceRoot = resolveDataDir();
  if (isInside(backupRoot, sourceRoot) && process.env.NODE_ENV === 'production') {
    throw new Error('WORKBENCH_BACKUP_DIR must be an independent production mount outside DATA_DIR');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const cadenceRoot = path.join(backupRoot, cadence);
  const tempDir = path.join(cadenceRoot, `.${stamp}.${process.pid}.tmp`);
  const finalDir = path.join(cadenceRoot, stamp);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const sources = collectSources();
    const files = [];
    for (const source of sources) {
      if (!fs.existsSync(source.source)) continue;
      const destination = path.join(tempDir, source.relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const db = new Database(source.source, { readonly: true, fileMustExist: true });
      try {
        await db.backup(destination);
      } finally {
        db.close();
      }
      verifySqlite(destination);
      files.push({ source: source.label, file: source.relative, bytes: fs.statSync(destination).size });
    }
    if (!files.length) throw new Error('no SQLite databases were found to back up');
    fs.writeFileSync(path.join(tempDir, 'manifest.json'), `${JSON.stringify({
      version: 1,
      cadence,
      created_at: new Date().toISOString(),
      files,
    }, null, 2)}\n`);
    fs.renameSync(tempDir, finalDir);
    pruneSnapshots(cadenceRoot, cadence === 'weekly' ? 4 : 7);
    console.log(`[workbench-backup] created ${finalDir} (${files.length} databases)`);
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

function collectSources() {
  const sources = [
    { label: 'global:auth', source: DEFAULT_AUTH_DB_PATH, relative: 'global/auth.sqlite' },
    { label: 'global:workbench', source: DEFAULT_WORKBENCH_DB_PATH, relative: 'global/workbench.sqlite' },
    { label: 'global:raw', source: DEFAULT_RAW_DB_PATH, relative: 'global/raw.sqlite' },
    { label: 'global:runtime', source: DEFAULT_RUNTIME_DB_PATH, relative: 'global/runtime.sqlite' },
  ];
  for (const ref of listAccountRefs()) {
    for (const kind of ['raw', 'runtime', 'workbench']) {
      sources.push({
        label: `${ref.platform}:${ref.account}:${kind}`,
        source: ref.paths[`${kind}DbPath`],
        relative: path.join('accounts', ref.platform, path.basename(ref.paths.accountDir), `${kind}.sqlite`),
      });
    }
  }
  return sources;
}

function verifySqlite(filePath) {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma('quick_check', { simple: true });
    if (String(result).toLowerCase() !== 'ok') throw new Error(`quick_check failed for ${filePath}: ${result}`);
  } finally {
    db.close();
  }
}

function pruneSnapshots(root, keep) {
  if (!fs.existsSync(root)) return;
  const snapshots = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: path.join(root, entry.name) }))
    .sort((a, b) => b.name.localeCompare(a.name));
  snapshots.slice(keep).forEach((entry) => fs.rmSync(entry.path, { recursive: true, force: true }));
  fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.tmp'))
    .forEach((entry) => fs.rmSync(path.join(root, entry.name), { recursive: true, force: true }));
}

function isInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

main().catch((err) => {
  console.error(`[workbench-backup] ${err.stack || err.message}`);
  process.exitCode = 1;
});
