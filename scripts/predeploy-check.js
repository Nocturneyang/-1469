'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEPLOY_ROOT = path.join(ROOT, '.deploy-worktree');
const SKIP_INSTALL = process.argv.includes('--skip-install');
const SYNC_PATHS = [
  '.deployhub', 'db', 'docs', 'frontend', 'lib', 'middleware', 'routes', 'scripts', 'server', 'tests', 'workers',
  '.dockerignore', '.gitignore', 'AGENTS.md', 'DEVELOPMENT_GUIDE.md', 'Dockerfile', 'README.md',
  'docker-entrypoint.sh', 'ecosystem.cloud.config.js', 'package.json', 'package-lock.json',
];
const IGNORED = new Set(['dist', 'node_modules', '.local-data', '.git', '.deploy-worktree', '.DS_Store']);

function main() {
  assertDatabaseBoundaries();
  if (!SKIP_INSTALL) run('npm', ['ci'], { PUPPETEER_SKIP_DOWNLOAD: 'true' });
  run('npm', ['ls']);
  run('npm', ['test']);
  run('npm', ['run', 'build']);
  run('npm', ['audit', '--omit=dev']);
  assertDeployWorktreeSynchronized();
  console.log('[predeploy] all checks passed');
}

function run(command, args, extraEnv = {}) {
  console.log(`[predeploy] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`);
}

function assertDatabaseBoundaries() {
  const forbidden = ['/社媒监控/', '/social-monitor/'];
  const envKeys = ['DATA_DIR', 'WORKBENCH_DB_DIR', 'WORKBENCH_AUTH_DB_PATH', 'WORKBENCH_RAW_DB_PATH', 'WORKBENCH_DB_PATH', 'WORKBENCH_RUNTIME_DB_PATH', 'WORKBENCH_ACCOUNT_DATA_DIR'];
  for (const key of envKeys) {
    const value = String(process.env[key] || '');
    if (forbidden.some((part) => value.includes(part))) throw new Error(`${key} points outside the workbench boundary`);
  }
  const historical = walk(ROOT).filter((file) => /\.(?:sqlite|sqlite-wal|sqlite-shm)$/.test(file) && !file.includes(`${path.sep}.local-data${path.sep}`));
  if (historical.length) throw new Error(`SQLite runtime files outside .local-data: ${historical.join(', ')}`);
}

function assertDeployWorktreeSynchronized() {
  if (!fs.existsSync(path.join(DEPLOY_ROOT, '.git'))) throw new Error('.deploy-worktree is missing');
  const mismatches = [];
  for (const relative of SYNC_PATHS) comparePath(relative, mismatches);
  if (mismatches.length) {
    throw new Error(`root and .deploy-worktree differ; deployment blocked:\n${mismatches.slice(0, 50).join('\n')}`);
  }
}

function comparePath(relative, mismatches) {
  const source = path.join(ROOT, relative);
  const target = path.join(DEPLOY_ROOT, relative);
  const sourceMap = fileMap(source, relative);
  const targetMap = fileMap(target, relative);
  const names = new Set([...sourceMap.keys(), ...targetMap.keys()]);
  for (const name of [...names].sort()) {
    if (sourceMap.get(name) !== targetMap.get(name)) mismatches.push(name);
  }
}

function fileMap(target, relative) {
  const map = new Map();
  if (!fs.existsSync(target)) return map;
  if (fs.statSync(target).isFile()) {
    map.set(relative, digest(target));
    return map;
  }
  for (const file of walk(target)) {
    map.set(path.relative(target, file) ? path.join(relative, path.relative(target, file)) : relative, digest(file));
  }
  return map;
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  if (fs.statSync(root).isFile()) return [root];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

try {
  main();
} catch (err) {
  console.error(`[predeploy] ${err.message}`);
  process.exitCode = 1;
}
