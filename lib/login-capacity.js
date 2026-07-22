'use strict';

function boundedLoginConcurrency(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(1, Number(fallback) || 1);
  return Math.max(1, Math.min(20, Math.floor(numeric)));
}

function hasLoginCapacity(activeCount, limit) {
  return Math.max(0, Number(activeCount) || 0) < boundedLoginConcurrency(limit);
}

module.exports = {
  boundedLoginConcurrency,
  hasLoginCapacity,
};
