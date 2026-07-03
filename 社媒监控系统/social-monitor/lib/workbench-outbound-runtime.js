'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_POLL_MS = 30 * 1000;
const DOORBELL_DEBOUNCE_MS = 50;

function truthy(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function splitCsv(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function sanitizeSegment(value) {
    return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function defaultWorkbenchDbPath() {
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');
    return path.resolve(dataDir, '..', '..', 'workbench', 'db', 'workbench.sqlite');
}

function defaultWorkbenchOutboxDir() {
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');
    return path.resolve(dataDir, '..', '..', 'workbench', 'outbox');
}

function defaultConsumerModulePath() {
    return path.resolve(__dirname, '..', '..', '..', 'workbench', 'lib', 'outbound-consumer.js');
}

function loadConsumerFactory(modulePath = process.env.WORKBENCH_OUTBOUND_CONSUMER_MODULE || defaultConsumerModulePath()) {
    // Lazy load keeps production workers independent unless Workbench sending is explicitly enabled.
    return require(modulePath).createOutboundConsumer;
}

function getMatchedAccountAlias(accountAliases = [], allowedAccounts = splitCsv(process.env.WORKBENCH_SEND_ACCOUNTS)) {
    const aliases = accountAliases.map(alias => String(alias || '').trim()).filter(Boolean);
    const allowed = new Set(allowedAccounts.map(account => String(account || '').trim()).filter(Boolean));
    if (!allowed.size) return null;
    return aliases.some(alias => allowed.has(alias)) ? aliases[0] : null;
}

function isWorkbenchSendEnabled({ accountAliases = [], logger = console } = {}) {
    if (!truthy(process.env.ENABLE_WORKBENCH) || !truthy(process.env.ENABLE_WORKBENCH_SEND)) {
        return false;
    }
    const matchedAccount = getMatchedAccountAlias(accountAliases);
    if (!matchedAccount) {
        logger.warn('[WorkbenchOutbound] ENABLE_WORKBENCH_SEND is on, but this account is not in WORKBENCH_SEND_ACCOUNTS');
        return false;
    }
    return true;
}

function startWorkbenchOutboundRuntime({
    platform,
    accountAliases = [],
    sendMessage,
    logger = console,
    label,
    dbPath = process.env.WORKBENCH_DB_PATH || defaultWorkbenchDbPath(),
    outboxDir = process.env.WORKBENCH_OUTBOX_DIR || defaultWorkbenchOutboxDir(),
    pollMs = Number(process.env.WORKBENCH_SEND_POLL_MS || DEFAULT_POLL_MS),
    createConsumer,
} = {}) {
    if (!platform) throw new Error('platform is required');
    if (typeof sendMessage !== 'function') throw new Error('sendMessage function is required');

    const matchedAccount = getMatchedAccountAlias(accountAliases);
    if (!isWorkbenchSendEnabled({ accountAliases, logger }) || !matchedAccount) {
        return { enabled: false, account: matchedAccount, stop() { }, tick: async () => ({ status: 'disabled' }) };
    }

    const safePollMs = Number.isFinite(pollMs) && pollMs >= 1000 ? pollMs : DEFAULT_POLL_MS;
    const consumerFactory = createConsumer || loadConsumerFactory();
    const consumer = consumerFactory({
        dbPath,
        platform,
        account: matchedAccount,
        sendMessage,
    });

    let running = false;
    let stopped = false;
    const timers = new Set();
    const watchers = [];
    const runtimeLabel = label || `${platform}:${matchedAccount}`;

    async function tick(reason = 'poll') {
        if (stopped) return { status: 'stopped' };
        if (running) return { status: 'busy' };
        running = true;
        try {
            const result = await consumer.runOnce();
            if (result && result.status && result.status !== 'idle') {
                logger.log(`[WorkbenchOutbound:${runtimeLabel}] ${reason}: ${result.status}`);
            }
            return result;
        } catch (err) {
            logger.error(`[WorkbenchOutbound:${runtimeLabel}] ${reason} failed:`, err.message);
            return { status: 'error', error: err.message };
        } finally {
            running = false;
        }
    }

    const pollTimer = setInterval(() => {
        tick('poll').catch(err => logger.error(`[WorkbenchOutbound:${runtimeLabel}] poll crashed:`, err.message));
    }, safePollMs);
    pollTimer.unref();
    timers.add(pollTimer);

    const startupTimer = setTimeout(() => {
        tick('startup').catch(err => logger.error(`[WorkbenchOutbound:${runtimeLabel}] startup crashed:`, err.message));
    }, 1000);
    startupTimer.unref();
    timers.add(startupTimer);

    const accountOutboxDir = path.join(outboxDir, `worker-${platform}-${sanitizeSegment(matchedAccount)}`);
    try {
        fs.mkdirSync(accountOutboxDir, { recursive: true });
        const watcher = fs.watch(accountOutboxDir, () => {
            const timer = setTimeout(() => {
                timers.delete(timer);
                tick('doorbell').catch(err => logger.error(`[WorkbenchOutbound:${runtimeLabel}] doorbell crashed:`, err.message));
            }, DOORBELL_DEBOUNCE_MS);
            timer.unref();
            timers.add(timer);
        });
        watcher.unref();
        watchers.push(watcher);
    } catch (err) {
        logger.warn(`[WorkbenchOutbound:${runtimeLabel}] outbox watcher disabled: ${err.message}`);
    }

    logger.log(`[WorkbenchOutbound:${runtimeLabel}] enabled for account=${matchedAccount}, db=${dbPath}`);

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
            if (consumer && typeof consumer.close === 'function') consumer.close();
        },
    };
}

module.exports = {
    defaultConsumerModulePath,
    defaultWorkbenchDbPath,
    defaultWorkbenchOutboxDir,
    getMatchedAccountAlias,
    isWorkbenchSendEnabled,
    loadConsumerFactory,
    sanitizeSegment,
    splitCsv,
    startWorkbenchOutboundRuntime,
    truthy,
};
