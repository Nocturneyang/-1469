'use strict';

function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function normalizeJournalMode(value) {
  const mode = String(value || '').trim().toUpperCase();
  if (!mode) return '';
  const allowed = new Set(['DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'WAL', 'OFF']);
  return allowed.has(mode) ? mode : '';
}

function isNasRuntime() {
  const dataDir = String(process.env.DATA_DIR || '').replace(/\/+$/, '');
  return envFlag(process.env.SQLITE_NAS_MODE) || dataDir === '/data';
}

function defaultJournalMode() {
  return isNasRuntime() ? 'DELETE' : 'WAL';
}

function sqliteJournalMode() {
  return normalizeJournalMode(process.env.SQLITE_JOURNAL_MODE) || defaultJournalMode();
}

function sqliteBusyTimeoutMs() {
  const raw = Number(process.env.SQLITE_BUSY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15000;
}

function safePragma(db, statement, label, logger = console) {
  try {
    return db.pragma(statement);
  } catch (err) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`[sqlite] ${label || statement} failed: ${err.message}`);
    }
    return null;
  }
}

function configureSqlite(db, options = {}) {
  const label = options.label || 'sqlite';
  const logger = options.logger === undefined ? console : options.logger;
  const busyTimeoutMs = options.busyTimeoutMs || sqliteBusyTimeoutMs();

  safePragma(db, `busy_timeout = ${busyTimeoutMs}`, `${label} busy_timeout`, logger);

  if (options.readonly) {
    safePragma(db, 'query_only = ON', `${label} query_only`, logger);
    return {
      journalMode: null,
      busyTimeoutMs,
    };
  }

  const journalMode = normalizeJournalMode(options.journalMode) || sqliteJournalMode();
  const result = safePragma(db, `journal_mode = ${journalMode}`, `${label} journal_mode=${journalMode}`, logger);
  const appliedJournalMode = Array.isArray(result) && result[0] && result[0].journal_mode
    ? String(result[0].journal_mode).toUpperCase()
    : journalMode;

  return {
    journalMode: appliedJournalMode,
    busyTimeoutMs,
  };
}

module.exports = {
  configureSqlite,
  defaultJournalMode,
  isNasRuntime,
  normalizeJournalMode,
  safePragma,
  sqliteBusyTimeoutMs,
  sqliteJournalMode,
};
