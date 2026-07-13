const fs = require('fs');
const path = require('path');

const WORKBENCH_ROOT = path.resolve(__dirname, '..');

function resolveDataDir() {
  return path.resolve(process.env.DATA_DIR || path.join(WORKBENCH_ROOT, '.local-data'));
}

function resolveDbDir() {
  return path.resolve(process.env.WORKBENCH_DB_DIR || path.join(resolveDataDir(), 'db'));
}

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function resolveDbPath(envNames, fileName) {
  const names = Array.isArray(envNames) ? envNames : [envNames];
  const configured = names.map((name) => process.env[name]).find((value) => String(value || '').trim());
  const resolved = configured
    ? path.resolve(configured)
    : path.join(resolveDbDir(), fileName);
  assertNotMonitorDbPath(resolved, fileName);
  return resolved;
}

function assertNotMonitorDbPath(filePath, label = 'sqlite database') {
  const normalized = path.resolve(String(filePath || ''));
  const looksLikeMonitorDb = normalized.includes(`${path.sep}社媒监控系统${path.sep}social-monitor${path.sep}`) ||
    normalized.includes(`${path.sep}social-monitor${path.sep}db${path.sep}database.sqlite`) ||
    normalized.includes(`${path.sep}social-monitor${path.sep}db${path.sep}analytics.sqlite`);
  if (looksLikeMonitorDb) {
    throw new Error(`[workbench] ${label} must not point to social-monitor data: ${normalized}`);
  }
}

module.exports = {
  WORKBENCH_ROOT,
  assertNotMonitorDbPath,
  ensureDirectory,
  resolveDataDir,
  resolveDbDir,
  resolveDbPath,
};
