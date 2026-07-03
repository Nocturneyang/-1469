'use strict';

const fs = require('fs');
const path = require('path');
const {
    defaultWorkbenchDbPath,
    defaultWorkbenchOutboxDir,
    getMatchedAccountAlias,
    sanitizeSegment,
    splitCsv,
    truthy,
} = require('./workbench-outbound-runtime');

const DEFAULT_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const DOORBELL_DEBOUNCE_MS = 100;

function defaultChannelSyncModulePath() {
    return path.resolve(__dirname, '..', '..', '..', 'workbench', 'lib', 'channel-sync-store.js');
}

function loadChannelSyncStore(modulePath = process.env.WORKBENCH_CHANNEL_SYNC_MODULE || defaultChannelSyncModulePath()) {
    return require(modulePath);
}

function isWorkbenchChannelSyncEnabled({ accountAliases = [], logger = console } = {}) {
    if (!truthy(process.env.ENABLE_WORKBENCH)) return false;
    if (!truthy(process.env.ENABLE_WORKBENCH_SYNC)) return false;
    const allowed = splitCsv(process.env.WORKBENCH_SYNC_ACCOUNTS || process.env.WORKBENCH_SEND_ACCOUNTS);
    const matchedAccount = getMatchedAccountAlias(accountAliases, allowed);
    if (!matchedAccount) {
        logger.warn('[WorkbenchChannelSync] ENABLE_WORKBENCH_SYNC is on, but this account is not in WORKBENCH_SYNC_ACCOUNTS');
        return false;
    }
    return true;
}

function startWorkbenchChannelSyncRuntime({
    platform,
    accountAliases = [],
    collectSnapshot,
    logger = console,
    label,
    dbPath = process.env.WORKBENCH_DB_PATH || defaultWorkbenchDbPath(),
    outboxDir = process.env.WORKBENCH_OUTBOX_DIR || defaultWorkbenchOutboxDir(),
    intervalMs = Number(process.env.WORKBENCH_CHANNEL_SYNC_INTERVAL_MS || DEFAULT_SYNC_INTERVAL_MS),
    store = loadChannelSyncStore(),
} = {}) {
    if (!platform) throw new Error('platform is required');
    if (typeof collectSnapshot !== 'function') throw new Error('collectSnapshot function is required');

    const allowed = splitCsv(process.env.WORKBENCH_SYNC_ACCOUNTS || process.env.WORKBENCH_SEND_ACCOUNTS);
    const matchedAccount = getMatchedAccountAlias(accountAliases, allowed);
    if (!isWorkbenchChannelSyncEnabled({ accountAliases, logger }) || !matchedAccount) {
        return { enabled: false, account: matchedAccount, stop() { }, tick: async () => ({ status: 'disabled' }) };
    }

    const safeIntervalMs = Number.isFinite(intervalMs) && intervalMs >= 60 * 1000 ? intervalMs : DEFAULT_SYNC_INTERVAL_MS;
    const runtimeLabel = label || `${platform}:${matchedAccount}`;
    const timers = new Set();
    const watchers = [];
    let running = false;
    let stopped = false;

    async function tick(reason = 'poll') {
        if (stopped) return { status: 'stopped' };
        if (running) return { status: 'busy' };
        running = true;
        try {
            if (reason === 'doorbell') {
                store.readAndClearChannelSyncRequests(outboxDir, platform, matchedAccount);
            }
            const snapshot = await collectSnapshot();
            const result = store.replaceChannelSnapshot({
                dbPath,
                platform,
                account: matchedAccount,
                groups: snapshot.groups || [],
                ...(Array.isArray(snapshot.labels) ? { labels: snapshot.labels } : {}),
                ...(Array.isArray(snapshot.maps) ? { maps: snapshot.maps } : {}),
            });
            logger.log(
                `[WorkbenchChannelSync:${runtimeLabel}] ${reason}: groups=${result.group_count}, labels=${result.label_count == null ? 'skip' : result.label_count}, maps=${result.map_count == null ? 'skip' : result.map_count}`
            );
            return { status: 'synced', ...result };
        } catch (err) {
            logger.warn(`[WorkbenchChannelSync:${runtimeLabel}] ${reason} failed: ${err.message}`);
            return { status: 'error', error: err.message };
        } finally {
            running = false;
        }
    }

    const intervalTimer = setInterval(() => {
        tick('poll').catch(err => logger.error(`[WorkbenchChannelSync:${runtimeLabel}] poll crashed:`, err.message));
    }, safeIntervalMs);
    intervalTimer.unref();
    timers.add(intervalTimer);

    const startupTimer = setTimeout(() => {
        tick('startup').catch(err => logger.error(`[WorkbenchChannelSync:${runtimeLabel}] startup crashed:`, err.message));
    }, Number(process.env.WORKBENCH_CHANNEL_SYNC_STARTUP_DELAY_MS || 5000));
    startupTimer.unref();
    timers.add(startupTimer);

    const requestDir = path.join(outboxDir, `sync-worker-${platform}-${sanitizeSegment(matchedAccount)}`);
    try {
        fs.mkdirSync(requestDir, { recursive: true });
        const watcher = fs.watch(requestDir, () => {
            const timer = setTimeout(() => {
                timers.delete(timer);
                tick('doorbell').catch(err => logger.error(`[WorkbenchChannelSync:${runtimeLabel}] doorbell crashed:`, err.message));
            }, DOORBELL_DEBOUNCE_MS);
            timer.unref();
            timers.add(timer);
        });
        watcher.unref();
        watchers.push(watcher);
    } catch (err) {
        logger.warn(`[WorkbenchChannelSync:${runtimeLabel}] request watcher disabled: ${err.message}`);
    }

    logger.log(`[WorkbenchChannelSync:${runtimeLabel}] enabled for account=${matchedAccount}, db=${dbPath}`);

    return {
        enabled: true,
        account: matchedAccount,
        tick,
        stop() {
            stopped = true;
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            for (const watcher of watchers) watcher.close();
            watchers.length = 0;
        },
    };
}

module.exports = {
    defaultChannelSyncModulePath,
    isWorkbenchChannelSyncEnabled,
    loadChannelSyncStore,
    startWorkbenchChannelSyncRuntime,
};
