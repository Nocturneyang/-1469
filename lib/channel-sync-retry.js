'use strict';

function channelSyncRetryDelay(failureCount, options = {}) {
  const baseMs = boundedNumber(options.baseMs, 30000, 1000, 60 * 60 * 1000);
  const maxMs = boundedNumber(options.maxMs, 10 * 60 * 1000, baseMs, 24 * 60 * 60 * 1000);
  const failures = Math.max(1, Math.floor(Number(failureCount) || 1));
  const exponent = Math.min(failures - 1, 30);
  return Math.min(maxMs, baseMs * (2 ** exponent));
}

function boundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

module.exports = {
  channelSyncRetryDelay,
};
