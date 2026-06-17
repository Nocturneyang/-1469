const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.env') });

const { db, recordRuntimeEvent } = require('../db/database');
const { getWaChromeStats, getPuppeteerChromeInfo } = require('../lib/wa-chrome-runtime');
const { createRuntimeAdapter } = require('../lib/wa-runtime-adapters');
const { parseShanghaiDate, shanghaiISOString } = require('../lib/time');
const puppeteer = require('puppeteer');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const CONFIG_PATH = path.join(DATA_DIR, 'config', 'wa-accounts.json');
const INIT_LOCK_FILE = '/tmp/wa_chrome_init.lock';
const runtimeAdapter = createRuntimeAdapter({ dataDir: DATA_DIR, logger: console });

const DEFAULT_CONFIG = {
    capacity: {
        maxOnlineAccounts: 5,
        maxStartingAccounts: 1,
        maxChromeRssMbPerAccount: 3200,
        maxChromeRssMbTotal: 12000,
        restartConsecutiveBreaches: 3,
        noChromeConsecutiveChecks: 3,
        runtimeDownConsecutiveChecks: 2,
        pm2DownConsecutiveChecks: 2,
        supervisorIntervalMs: 60000,
        staleInitLockSeconds: 720,
        restartCooldownSeconds: 900
    },
    deletedAccounts: [],
    accounts: []
};

const breachCounts = new Map();
const noChromeCounts = new Map();
const runtimeDownCounts = new Map();
const restartCooldowns = new Map();
const HEARTBEAT_FRESH_SECONDS = 90;
const BOOT_PHASES = new Set(['booting', 'profile_cleanup', 'init_lock_acquired', 'browser_starting', 'web_loading', 'wa_injecting', 'session_restoring', 'wa_state', 'init_retry']);
const READY_PHASES = new Set(['authenticated', 'ready']);
const RECOVERABLE_INIT_FAILURES = new Set(['init_timeout', 'init_failed', 'no_browser_timeout']);

function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
        const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return {
            capacity: { ...DEFAULT_CONFIG.capacity, ...(parsed.capacity || {}) },
            deletedAccounts: Array.isArray(parsed.deletedAccounts) ? parsed.deletedAccounts : [],
            accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
        };
    } catch (err) {
        console.error('[WA Supervisor] Failed to read config:', err.message);
        return DEFAULT_CONFIG;
    }
}

function getDeletedAccountNames(config) {
    return new Set((config.deletedAccounts || []).map(item => typeof item === 'string' ? item : item.id).filter(Boolean));
}

function collectStats() {
    return new Promise((resolve, reject) => {
        getWaChromeStats((err, stats) => {
            if (err) return reject(err);
            resolve(stats);
        });
    });
}

function collectRuntimeStatus() {
    return runtimeAdapter.listCollectors();
}

function mergeDiscoveredWaAccounts(config, runtimeByName) {
    const accounts = Array.isArray(config.accounts) ? [...config.accounts] : [];
    const seen = new Set(accounts.map(account => account.id || account.name).filter(Boolean));
    const deletedNames = getDeletedAccountNames(config);

    for (const accountName of runtimeByName.keys()) {
        if (deletedNames.has(accountName)) {
            console.warn(`[WA Supervisor] Ignoring deleted ${runtimeAdapter.name} WA account: ${accountName}`);
            continue;
        }
        if (seen.has(accountName)) continue;
        accounts.push({
            id: accountName,
            enabled: true,
            priority: 0,
            source: `${runtimeAdapter.name}-discovered`
        });
        seen.add(accountName);
        console.warn(`[WA Supervisor] Discovered unmanaged ${runtimeAdapter.name} WA account: ${accountName}`);
    }

    return { ...config, accounts };
}

async function cleanupDeletedRuntime(config, runtimeByName) {
    const deletedNames = getDeletedAccountNames(config);
    for (const accountName of deletedNames) {
        if (!runtimeByName.has(accountName)) continue;
        console.warn(`[WA Supervisor] Removing deleted runtime collector: ${runtimeAdapter.workerName(accountName)}`);
        try {
            await runtimeAdapter.deleteCollector(accountName);
        } catch (err) {
            console.warn(`[WA Supervisor] Failed to delete runtime collector ${accountName}: ${err.message}`);
        }
        db.prepare('DELETE FROM accounts WHERE id = ?').run(`wa-${accountName}`);
        db.prepare('DELETE FROM collector_heartbeats WHERE account_id = ?').run(`wa-${accountName}`);
        db.prepare('DELETE FROM wa_runtime_events WHERE account_id = ?').run(`wa-${accountName}`);
        runtimeByName.delete(accountName);
    }
}

function updateAccountRuntime(accountId, patch) {
    const fields = [];
    const params = { id: accountId };
    const patchKeys = Object.keys(patch);

    for (const [key, value] of Object.entries(patch)) {
        fields.push(`${key} = @${key}`);
        params[key] = value;
    }

    fields.push("last_supervisor_check_at = datetime('now', '+8 hours')");
    fields.push("updated_at = datetime('now', '+8 hours')");

    const insertColumns = ['id', 'platform', 'status', ...patchKeys, 'last_supervisor_check_at', 'updated_at'];
    const insertValues = ['@id', "'whatsapp'", "'unknown'", ...patchKeys.map(key => `@${key}`), "datetime('now', '+8 hours')", "datetime('now', '+8 hours')"];

    db.prepare(`
        INSERT INTO accounts (${insertColumns.join(', ')})
        VALUES (${insertValues.join(', ')})
        ON CONFLICT(id) DO UPDATE SET ${fields.join(', ')}
    `).run(params);
}

function getCurrentAccountRows() {
    const rows = db.prepare(`
        SELECT id, status, pushname, health_status, orchestrator_state
        FROM accounts
        WHERE platform = 'whatsapp' OR id LIKE 'wa-%'
    `).all();
    return new Map(rows.map(row => [row.id, row]));
}

function getCollectorHeartbeats() {
    const rows = db.prepare(`
        SELECT *
        FROM collector_heartbeats
        WHERE platform = 'whatsapp'
        ORDER BY updated_at DESC
    `).all();
    const map = new Map();
    for (const row of rows) {
        if (!map.has(row.account_id)) map.set(row.account_id, row);
    }
    return map;
}

function secondsSince(value) {
    if (!value) return null;
    const ts = parseShanghaiDate(value).getTime();
    if (Number.isNaN(ts)) return null;
    return Math.max(0, Math.round((Date.now() - ts) / 1000));
}

function buildState(state, reason, severity = 'info') {
    return { state, reason, severity };
}

function getOrchestratorState(account, dbRow, runtime, config, runtimeStatus, cooldown, initLock, heartbeat) {
    const dbStatus = dbRow ? dbRow.status : 'unknown';
    const heartbeatAge = heartbeat ? secondsSince(heartbeat.updated_at) : null;
    const heartbeatFresh = heartbeatAge !== null && heartbeatAge <= HEARTBEAT_FRESH_SECONDS;
    const hasChrome = Boolean(runtime && runtime.processCount > 0);
    const collectorPhase = heartbeat ? heartbeat.phase : null;

    if (!account.enabled) return buildState('disabled', 'Account disabled in WA config');
    if (dbStatus === 'timeout' || collectorPhase === 'qr_timeout') {
        return buildState('qr_timeout', 'QR login timed out; waiting for manual relogin', 'warn');
    }
    if (!runtimeStatus || runtimeStatus.status !== 'online') {
        return buildState('runtime_down', `${runtimeAdapter.name} status is ${runtimeStatus ? runtimeStatus.status : 'missing'}`, 'warn');
    }
    if (cooldown) return buildState('cooling_down', `Init cooldown ${cooldown.remainingSeconds}s remaining`);
    if (dbStatus === 'qr' || collectorPhase === 'qr_required') return buildState('qr_required', 'Waiting for QR login');
    if (dbStatus === 'disconnected' || collectorPhase === 'disconnected') return buildState('disconnected', 'WA account disconnected', 'warn');
    if (collectorPhase === 'auth_failure') return buildState('auth_failure', heartbeat.last_error || 'Authentication failure', 'error');
    if (['init_timeout', 'init_failed', 'no_browser_timeout'].includes(collectorPhase)) {
        return buildState(collectorPhase, heartbeat.last_error || collectorPhase, 'warn');
    }
    if (initLock && initLock.holder !== account.id && !hasChrome) {
        return buildState('queued', `Waiting for init lock held by ${initLock.holder}`);
    }
    if (collectorPhase === 'queued') return buildState('queued', 'Waiting for init slot');
    if (BOOT_PHASES.has(collectorPhase)) return buildState('starting', `Collector phase ${collectorPhase}`);
    if (!heartbeatFresh && ['authenticated', 'monitoring', 'warmup'].includes(dbStatus)) {
        return buildState('stale_heartbeat', `Collector heartbeat stale (${heartbeatAge ?? 'missing'}s)`, 'warn');
    }
    if (!hasChrome && ['authenticated', 'monitoring', 'warmup'].includes(dbStatus)) {
        return buildState('stale_online', 'Database says online but no Chrome process exists', 'warn');
    }
    if (!hasChrome) return buildState('no_chrome', 'No Chrome process found', 'warn');
    if (runtime.rssMb >= config.capacity.maxChromeRssMbPerAccount) {
        return buildState('degraded_high_rss', `Chrome RSS ${Math.round(runtime.rssMb)}MB exceeds ${config.capacity.maxChromeRssMbPerAccount}MB`, 'warn');
    }
    if (READY_PHASES.has(collectorPhase) && ['authenticated', 'monitoring', 'warmup'].includes(dbStatus)) {
        return buildState('healthy', 'Collector heartbeat fresh and Chrome process exists');
    }
    return buildState('starting', `status=${dbStatus}, phase=${collectorPhase || 'none'}`);
}

function recordStateChange(accountId, previousState, nextState, reason, severity, context) {
    if (previousState === nextState) return;
    recordRuntimeEvent({
        accountId,
        platform: 'whatsapp',
        source: 'orchestrator',
        eventType: 'state_changed',
        severity,
        message: `${previousState || 'unknown'} -> ${nextState}: ${reason}`,
        data: context
    });
}

function getInitLockInfo() {
    if (!fs.existsSync(INIT_LOCK_FILE)) return null;
    const lock = JSON.parse(fs.readFileSync(INIT_LOCK_FILE, 'utf8'));
    return {
        ...lock,
        ageSeconds: Math.round((Date.now() - lock.ts) / 1000)
    };
}

function getInitCooldownInfo(accountName) {
    const cooldownFile = path.join('/tmp', `wa_chrome_init_cooldown_${accountName}.json`);
    try {
        if (!fs.existsSync(cooldownFile)) return null;
        const cooldown = JSON.parse(fs.readFileSync(cooldownFile, 'utf8'));
        const remainingMs = Number(cooldown.cooldownMs || 0) - (Date.now() - Number(cooldown.ts || 0));
        if (remainingMs <= 0) return null;
        return {
            ...cooldown,
            remainingSeconds: Math.ceil(remainingMs / 1000)
        };
    } catch (err) {
        console.warn(`[WA Supervisor] Failed to read init cooldown for ${accountName}: ${err.message}`);
        return null;
    }
}

function cleanupStaleInitLock(config, statsByName) {
    try {
        const lock = getInitLockInfo();
        if (!lock) return null;
        const holderStats = statsByName.get(lock.holder);

        if (lock.ageSeconds < config.capacity.staleInitLockSeconds) return lock;
        if (holderStats && holderStats.processCount > 0) return lock;

        fs.unlinkSync(INIT_LOCK_FILE);
        console.warn(`[WA Supervisor] Removed stale init lock holder=${lock.holder}, age=${lock.ageSeconds}s`);
        return null;
    } catch (err) {
        console.error('[WA Supervisor] Failed to inspect init lock:', err.message);
        return null;
    }
}

async function maybeRestartHighRss(account, runtime, config) {
    if (!runtime || !account.enabled) return;

    const threshold = config.capacity.maxChromeRssMbPerAccount;
    const consecutiveLimit = config.capacity.restartConsecutiveBreaches;
    const cooldownMs = config.capacity.restartCooldownSeconds * 1000;
    const accountName = account.id;
    const accountId = `wa-${accountName}`;

    if (runtime.rssMb < threshold) {
        breachCounts.delete(accountName);
        return;
    }

    const count = (breachCounts.get(accountName) || 0) + 1;
    breachCounts.set(accountName, count);

    if (count < consecutiveLimit) {
        console.warn(`[WA Supervisor] ${accountName} high RSS ${runtime.rssMb}MB (${count}/${consecutiveLimit})`);
        return;
    }

    const lastRestartAt = restartCooldowns.get(accountName) || 0;
    if (Date.now() - lastRestartAt < cooldownMs) {
        console.warn(`[WA Supervisor] ${accountName} high RSS but still in restart cooldown`);
        return;
    }

    const reason = `Chrome RSS ${runtime.rssMb}MB exceeded ${threshold}MB for ${count} checks`;
    console.warn(`[WA Supervisor] Restarting ${runtimeAdapter.workerName(accountName)}: ${reason}`);
    updateAccountRuntime(accountId, {
        health_status: 'restarting_high_rss',
        last_restart_reason: reason,
        chrome_rss_mb: Math.round(runtime.rssMb),
        chrome_process_count: runtime.processCount
    });
    recordRuntimeEvent({
        accountId,
        platform: 'whatsapp',
        source: 'supervisor',
        eventType: 'restart_high_rss',
        severity: 'warn',
        message: reason,
        data: { rssMb: runtime.rssMb, threshold, count }
    });

    await runtimeAdapter.restartCollector(accountName);
    restartCooldowns.set(accountName, Date.now());
    breachCounts.delete(accountName);
}

async function maybeRestartNoChrome(account, dbRow, runtime, config, initLock, cooldown) {
    if (!account.enabled) return;
    if (runtime && runtime.processCount > 0) {
        noChromeCounts.delete(account.id);
        return;
    }

    if (cooldown) {
        noChromeCounts.delete(account.id);
        console.log(`[WA Supervisor] ${account.id} is in init cooldown (${cooldown.remainingSeconds}s); skip no-Chrome restart`);
        return;
    }

    const status = dbRow ? dbRow.status : 'unknown';
    if (['qr', 'disconnected', 'timeout'].includes(status)) {
        noChromeCounts.delete(account.id);
        return;
    }

    if (initLock && initLock.ageSeconds < config.capacity.staleInitLockSeconds) {
        noChromeCounts.delete(account.id);
        if (initLock.holder !== account.id) {
            console.log(`[WA Supervisor] ${account.id} is waiting for init lock held by ${initLock.holder}; skip no-Chrome restart`);
        }
        return;
    }

    const consecutiveLimit = config.capacity.noChromeConsecutiveChecks;
    const cooldownMs = config.capacity.restartCooldownSeconds * 1000;
    const count = (noChromeCounts.get(account.id) || 0) + 1;
    noChromeCounts.set(account.id, count);

    if (count < consecutiveLimit) {
        console.warn(`[WA Supervisor] ${account.id} has no Chrome process (${count}/${consecutiveLimit}), status=${status}`);
        return;
    }

    const lastRestartAt = restartCooldowns.get(account.id) || 0;
    if (Date.now() - lastRestartAt < cooldownMs) {
        console.warn(`[WA Supervisor] ${account.id} has no Chrome but still in restart cooldown`);
        return;
    }

    const accountId = `wa-${account.id}`;
    const reason = `No Chrome process for ${count} supervisor checks, status=${status}`;

    console.warn(`[WA Supervisor] Restarting ${runtimeAdapter.workerName(account.id)}: ${reason}`);
    updateAccountRuntime(accountId, {
        health_status: 'restarting_no_chrome',
        last_restart_reason: reason,
        chrome_rss_mb: 0,
        chrome_process_count: 0
    });
    recordRuntimeEvent({
        accountId,
        platform: 'whatsapp',
        source: 'supervisor',
        eventType: 'restart_no_chrome',
        severity: 'warn',
        message: reason,
        data: { status, count }
    });

    await runtimeAdapter.restartCollector(account.id);
    restartCooldowns.set(account.id, Date.now());
    noChromeCounts.delete(account.id);
}

async function maybeRecoverRuntimeDown(account, runtimeStatus, config, dbRow) {
    if (!account.enabled) return;
    const status = dbRow ? dbRow.status : 'unknown';
    if (['timeout', 'qr', 'disconnected'].includes(status)) {
        runtimeDownCounts.delete(account.id);
        return;
    }
    if (runtimeStatus && runtimeStatus.status === 'online') {
        runtimeDownCounts.delete(account.id);
        return;
    }

    const consecutiveLimit = config.capacity.runtimeDownConsecutiveChecks || config.capacity.pm2DownConsecutiveChecks || 2;
    const cooldownMs = config.capacity.restartCooldownSeconds * 1000;
    const count = (runtimeDownCounts.get(account.id) || 0) + 1;
    runtimeDownCounts.set(account.id, count);

    if (count < consecutiveLimit) {
        console.warn(`[WA Supervisor] ${runtimeAdapter.workerName(account.id)} runtime is ${runtimeStatus ? runtimeStatus.status : 'missing'} (${count}/${consecutiveLimit})`);
        return;
    }

    const lastRestartAt = restartCooldowns.get(account.id) || 0;
    if (Date.now() - lastRestartAt < cooldownMs) {
        console.warn(`[WA Supervisor] ${runtimeAdapter.workerName(account.id)} runtime down but still in recovery cooldown`);
        return;
    }

    const accountId = `wa-${account.id}`;
    const reason = `${runtimeAdapter.name} status ${runtimeStatus ? runtimeStatus.status : 'missing'} for ${count} supervisor checks`;
    console.warn(`[WA Supervisor] Recovering ${runtimeAdapter.workerName(account.id)}: ${reason}`);

    updateAccountRuntime(accountId, {
        health_status: 'recovering_runtime',
        orchestrator_state: 'recovering_runtime',
        last_restart_reason: reason
    });
    recordRuntimeEvent({
        accountId,
        platform: 'whatsapp',
        source: 'orchestrator',
        eventType: 'recover_runtime',
        severity: 'warn',
        message: reason,
        data: { runtime: runtimeAdapter.name, runtimeStatus: runtimeStatus ? runtimeStatus.status : 'missing', count }
    });

    if (runtimeStatus) {
        await runtimeAdapter.restartCollector(account.id);
    } else {
        await runtimeAdapter.startCollector(account.id);
    }
    restartCooldowns.set(account.id, Date.now());
    runtimeDownCounts.delete(account.id);
}

async function maybeRecoverFailedInit(account, heartbeat, cooldown, config) {
    if (!account.enabled || !heartbeat) return;
    if (!RECOVERABLE_INIT_FAILURES.has(heartbeat.phase)) return;

    if (cooldown) {
        console.log(`[WA Supervisor] ${account.id} ${heartbeat.phase}, recovery waits cooldown ${cooldown.remainingSeconds}s`);
        return;
    }

    const cooldownMs = config.capacity.restartCooldownSeconds * 1000;
    const lastRestartAt = restartCooldowns.get(account.id) || 0;
    if (Date.now() - lastRestartAt < cooldownMs) {
        console.warn(`[WA Supervisor] ${account.id} ${heartbeat.phase} but still in restart cooldown`);
        return;
    }

    const accountId = `wa-${account.id}`;
    const reason = `Collector parked in ${heartbeat.phase}; restarting after cooldown`;
    console.warn(`[WA Supervisor] Recovering ${runtimeAdapter.workerName(account.id)}: ${reason}`);

    updateAccountRuntime(accountId, {
        health_status: 'recovering_init',
        orchestrator_state: 'recovering_init',
        last_restart_reason: reason
    });
    recordRuntimeEvent({
        accountId,
        platform: 'whatsapp',
        source: 'orchestrator',
        eventType: 'recover_init',
        severity: 'warn',
        runId: heartbeat.run_id,
        message: reason,
        data: {
            phase: heartbeat.phase,
            lastError: heartbeat.last_error,
            heartbeatUpdatedAt: heartbeat.updated_at
        }
    });

    await runtimeAdapter.restartCollector(account.id);
    restartCooldowns.set(account.id, Date.now());
}

async function tick() {
    let config = loadConfig();
    const chromeInfo = getPuppeteerChromeInfo(puppeteer);

    let stats;
    try {
        stats = await collectStats();
    } catch (err) {
        console.error('[WA Supervisor] Failed to collect Chrome stats:', err.message);
        return;
    }

    const [runtimeByName] = await Promise.all([collectRuntimeStatus()]);
    await cleanupDeletedRuntime(config, runtimeByName);
    config = mergeDiscoveredWaAccounts(config, runtimeByName);
    const enabledAccounts = config.accounts.filter(account => account.enabled !== false);
    const statsByName = new Map((stats.accounts || []).map(item => [item.accountName, item]));
    const dbRows = getCurrentAccountRows();
    const heartbeats = getCollectorHeartbeats();

    const initLock = cleanupStaleInitLock(config, statsByName);

    for (const account of config.accounts) {
        const accountId = `wa-${account.id}`;
        const row = dbRows.get(accountId);
        const runtimeStatus = runtimeByName.get(account.id);
        const cooldown = getInitCooldownInfo(account.id);
        const heartbeat = heartbeats.get(accountId);
        const localRuntime = statsByName.get(account.id);
        const heartbeatRuntime = heartbeat ? {
            rssMb: Number(heartbeat.chrome_rss_mb || 0),
            processCount: Number(heartbeat.chrome_process_count || 0),
            pids: heartbeat.process_pid ? [heartbeat.process_pid] : [],
            source: 'heartbeat'
        } : null;
        const runtime = localRuntime || heartbeatRuntime;
        const heartbeatAge = heartbeat ? secondsSince(heartbeat.updated_at) : null;
        const orchestration = getOrchestratorState(account, row, runtime, config, runtimeStatus, cooldown, initLock, heartbeat);
        const previousState = row ? (row.orchestrator_state || row.health_status) : null;

        recordStateChange(accountId, previousState, orchestration.state, orchestration.reason, orchestration.severity, {
            accountName: account.id,
            dbStatus: row ? row.status : null,
            collectorPhase: heartbeat ? heartbeat.phase : null,
            heartbeatAgeSeconds: heartbeatAge,
            chromeRssMb: runtime ? Math.round(runtime.rssMb) : 0,
            chromeProcessCount: runtime ? runtime.processCount : 0,
            runtime: runtimeAdapter.name,
            runtimeStatus: runtimeStatus ? runtimeStatus.status : 'missing',
            initLockHolder: initLock ? initLock.holder : null
        });

        updateAccountRuntime(accountId, {
            health_status: orchestration.state,
            orchestrator_state: orchestration.state,
            collector_phase: heartbeat ? heartbeat.phase : null,
            collector_run_id: heartbeat ? heartbeat.run_id : null,
            collector_heartbeat_age_seconds: heartbeatAge,
            last_runtime_event_at: shanghaiISOString(),
            chrome_rss_mb: runtime ? Math.round(runtime.rssMb) : 0,
            chrome_process_count: runtime ? runtime.processCount : 0,
            chrome_version: chromeInfo.chromeVersion || 'unknown',
            runtime_provider: runtimeAdapter.name,
            pm2_status: runtimeStatus ? runtimeStatus.status : 'missing',
            pm2_mode: runtimeStatus ? runtimeStatus.mode : 'missing',
            pm2_pid: runtimeStatus ? runtimeStatus.pid : 0,
            pm2_restart_count: runtimeStatus ? runtimeStatus.restartCount : 0,
            pm2_uptime_seconds: runtimeStatus ? runtimeStatus.uptimeSeconds : 0
        });

        await maybeRecoverRuntimeDown(account, runtimeStatus, config, row);
        if (runtimeStatus && runtimeStatus.status === 'online') {
            await maybeRecoverFailedInit(account, heartbeat, cooldown, config);
            await maybeRestartHighRss(account, runtime, config);
            await maybeRestartNoChrome(account, row, runtime, config, initLock, cooldown);
        }
    }

    if (stats.totalRssMb > config.capacity.maxChromeRssMbTotal) {
        console.warn(`[WA Supervisor] Total WA Chrome RSS ${stats.totalRssMb}MB exceeds ${config.capacity.maxChromeRssMbTotal}MB`);
    }

    console.log(`[WA Supervisor] checked ${enabledAccounts.length} accounts, rss=${stats.totalRssMb}MB, chrome_processes=${stats.totalProcessCount}`);
}

async function main() {
    const config = loadConfig();
    const interval = Math.max(15000, Number(config.capacity.supervisorIntervalMs) || DEFAULT_CONFIG.capacity.supervisorIntervalMs);

    console.log(`[WA Supervisor] started, interval=${interval}ms, config=${CONFIG_PATH}`);
    await tick();

    const timer = setInterval(() => {
        tick().catch(err => console.error('[WA Supervisor] tick failed:', err.message));
    }, interval);
}

process.on('SIGTERM', () => {
    console.log('[WA Supervisor] SIGTERM received, exiting');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[WA Supervisor] SIGINT received, exiting');
    process.exit(0);
});

main().catch(err => {
    console.error('[WA Supervisor] fatal:', err.message, err.stack);
    process.exit(1);
});
