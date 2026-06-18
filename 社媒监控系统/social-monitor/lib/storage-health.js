'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const DISK_FULL_CODES = new Set(['ENOSPC', 'EDQUOT']);

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getStorageStats(targetPath = DATA_DIR) {
  const stats = fs.statfsSync(targetPath);
  const blockSize = Number(stats.bsize || stats.frsize || 0);
  const totalBytes = Number(stats.blocks || 0) * blockSize;
  const freeBytes = Number(stats.bavail || 0) * blockSize;
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const freePercent = totalBytes > 0 ? Number(((freeBytes / totalBytes) * 100).toFixed(2)) : 0;

  return {
    path: targetPath,
    totalBytes,
    usedBytes,
    freeBytes,
    totalMb: Math.round(totalBytes / 1024 / 1024),
    usedMb: Math.round(usedBytes / 1024 / 1024),
    freeMb: Math.round(freeBytes / 1024 / 1024),
    freePercent,
  };
}

function checkStorageWatermark(options = {}) {
  const targetPath = options.path || DATA_DIR;
  const minFreeMb = Number.isFinite(Number(options.minFreeMb))
    ? Number(options.minFreeMb)
    : numberFromEnv('STORAGE_MIN_FREE_MB', 512);
  const minFreePercent = Number.isFinite(Number(options.minFreePercent))
    ? Number(options.minFreePercent)
    : numberFromEnv('STORAGE_MIN_FREE_PERCENT', 5);
  const reserveBytes = Math.max(0, Number(options.reserveBytes || 0));

  try {
    const stats = getStorageStats(targetPath);
    const minFreeBytes = minFreeMb * 1024 * 1024;
    const freeAfterReserve = stats.freeBytes - reserveBytes;
    const ok = freeAfterReserve >= minFreeBytes && stats.freePercent >= minFreePercent;

    return {
      ok,
      ...stats,
      minFreeMb,
      minFreePercent,
      reserveMb: Math.round(reserveBytes / 1024 / 1024),
      warning: ok ? null : 'Persistent storage is below the configured free-space watermark',
    };
  } catch (err) {
    return { ok: false, path: targetPath, error: err.message };
  }
}

function isDiskFullError(err) {
  const code = String(err?.code || '').toUpperCase();
  const message = String(err?.message || '').toLowerCase();
  return DISK_FULL_CODES.has(code)
    || message.includes('no space left')
    || message.includes('disk quota')
    || message.includes('unknown system error -122');
}

function isSqliteStorageError(err) {
  const code = String(err?.code || '').toUpperCase();
  const message = String(err?.message || '').toLowerCase();
  return code.includes('SQLITE_CORRUPT')
    || code.includes('SQLITE_IOERR')
    || message.includes('database disk image is malformed')
    || message.includes('disk i/o error')
    || isDiskFullError(err);
}

module.exports = {
  DATA_DIR,
  checkStorageWatermark,
  getStorageStats,
  isDiskFullError,
  isSqliteStorageError,
  numberFromEnv,
};
