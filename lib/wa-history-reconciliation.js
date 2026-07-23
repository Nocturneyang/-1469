'use strict';

function createNativeMessageDeduper({ ttlMs = 2 * 60 * 1000, maxEntries = 10000, now = () => Date.now() } = {}) {
  const entries = new Map();

  function prune() {
    const cutoff = now() - Math.max(1000, Number(ttlMs) || 0);
    for (const [key, entry] of entries) {
      if (entry.promise || entry.completedAt >= cutoff) continue;
      entries.delete(key);
    }
    while (entries.size > Math.max(100, Number(maxEntries) || 100)) entries.delete(entries.keys().next().value);
  }

  async function run(key, work) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return work();
    prune();
    const existing = entries.get(normalizedKey);
    if (existing?.promise) return existing.promise;
    if (existing && existing.completedAt >= now() - ttlMs) return existing.result;

    const entry = { promise: null, completedAt: 0, result: undefined };
    const promise = Promise.resolve().then(work);
    entry.promise = promise;
    entries.set(normalizedKey, entry);
    try {
      entry.result = await promise;
      entry.completedAt = now();
      entry.promise = null;
      return entry.result;
    } catch (error) {
      if (entries.get(normalizedKey) === entry) entries.delete(normalizedKey);
      throw error;
    }
  }

  return { run, size: () => entries.size };
}

function nextHistoryFetchLimit(state, { batchSize = 100, maxMessages = 1000 } = {}) {
  const normalizedBatch = Math.max(1, Math.min(Number(batchSize) || 100, 500));
  const normalizedMax = Math.max(normalizedBatch, Math.min(Number(maxMessages) || 1000, 10000));
  if (Number(state?.completed)) return null;
  const loadedLimit = Math.max(0, Number(state?.loaded_limit) || 0);
  if (loadedLimit >= normalizedMax) return null;
  return Math.min(normalizedMax, Math.max(normalizedBatch, loadedLimit + normalizedBatch));
}

function historySyncOutcome({ requestedLimit, receivedCount, maxMessages = 1000 } = {}) {
  const requested = Math.max(1, Number(requestedLimit) || 1);
  const received = Math.max(0, Number(receivedCount) || 0);
  const maximum = Math.max(requested, Number(maxMessages) || requested);
  return {
    loaded_limit: requested,
    completed: received < requested || requested >= maximum,
    capped: received >= requested && requested >= maximum,
  };
}

module.exports = {
  createNativeMessageDeduper,
  nextHistoryFetchLimit,
  historySyncOutcome,
};
