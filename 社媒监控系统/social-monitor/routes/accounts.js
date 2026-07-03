const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const {
    db,
    getChannelAccountRegistry,
    listChannelAccountRegistry,
    upsertChannelAccountRegistry
} = require('../db/database');
const {
    getPuppeteerChromeInfo,
    getWaChromeStats,
    getWaWebVersionCacheInfo
} = require('../lib/wa-chrome-runtime');
const { readEnvFile, writeEnvKeys } = require('../lib/env-config');
const { parseShanghaiDate } = require('../lib/time');
const {
    CloudCollectorOrchestrator,
    isCloudCollectorEnabled
} = require('../lib/cloud-collector-orchestrator');
const { getSessionStatus: getTgUserSessionStatus } = require('../lib/tg-session-store');
const teamsTokenStore = require('../lib/teams-token-store');
const puppeteer = require('puppeteer');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const WA_ACCOUNTS_CONFIG_PATH = path.join(DATA_DIR, 'config', 'wa-accounts.json');
const LOCAL_WA_RUNTIME_ENABLED = process.env.LOCAL_WA_RUNTIME_ENABLED !== 'false';
const ACCOUNT_PM2_COMMAND_TIMEOUT_MS = positiveEnvNumber('ACCOUNT_PM2_COMMAND_TIMEOUT_MS', 60000);
const ACCOUNT_RESTART_DELAY_MS = positiveEnvNumber('ACCOUNT_RESTART_DELAY_MS', 500);

function positiveEnvNumber(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function execManagedCommand(command, options = {}) {
    const execOptions = {
        timeout: ACCOUNT_PM2_COMMAND_TIMEOUT_MS,
        ...options
    };
    return new Promise((resolve, reject) => {
        exec(command, execOptions, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                return reject(error);
            }
            resolve({ stdout, stderr });
        });
    });
}

function execErrorDetail(error) {
    return [error?.message, error?.stderr, error?.stdout]
        .filter(Boolean)
        .join('\n')
        .slice(0, 1200);
}

function getConfiguredEnvValue(key) {
    return process.env[key] || readEnvFile()[key] || '';
}

function applyCollectorEnv(env, collectorId) {
    const collectorApiUrl = getConfiguredEnvValue('COLLECTOR_API_URL');
    if (!collectorApiUrl) return env;

    env.COLLECTOR_API_URL = collectorApiUrl;
    env.COLLECTOR_TOKEN = getConfiguredEnvValue('COLLECTOR_TOKEN');
    env.COLLECTOR_ID = collectorId;
    return env;
}

function collectWaChromeStats() {
    return new Promise((resolve) => {
        getWaChromeStats((err, stats) => {
            if (err) {
                console.error('[WA Runtime] Failed to collect Chrome stats:', err.message);
                const fallbackAccounts = db.prepare(`
                    SELECT id, chrome_rss_mb, chrome_process_count
                    FROM accounts
                    WHERE id LIKE 'wa-%'
                      AND chrome_process_count > 0
                      AND last_supervisor_check_at >= datetime('now', '-5 minutes')
                `).all().map(row => ({
                    accountName: row.id.replace(/^wa-/, ''),
                    accountId: row.id,
                    processCount: row.chrome_process_count || 0,
                    rssMb: row.chrome_rss_mb || 0,
                    pids: []
                }));
                const totalRssMb = fallbackAccounts.reduce((sum, item) => sum + item.rssMb, 0);
                const totalProcessCount = fallbackAccounts.reduce((sum, item) => sum + item.processCount, 0);
                return resolve({
                    totalRssMb,
                    totalProcessCount,
                    accountCount: fallbackAccounts.length,
                    summary: { totalRssMb, totalProcessCount, accountCount: fallbackAccounts.length },
                    accounts: fallbackAccounts,
                    source: 'database-fallback'
                });
            }
            const data = stats || { accounts: [] };
            const totalRssMb = data.totalRssMb || 0;
            const totalProcessCount = data.totalProcessCount || 0;
            const accountCount = (data.accounts || []).length;
            resolve({
                ...data,
                accountCount,
                summary: { totalRssMb, totalProcessCount, accountCount },
                source: 'process-scan'
            });
        });
    });
}

function secondsSince(value) {
    if (!value) return null;
    const ts = parseShanghaiDate(value).getTime();
    if (Number.isNaN(ts)) return null;
    return Math.max(0, Math.round((Date.now() - ts) / 1000));
}

function readWaAccountsConfig() {
    if (!fs.existsSync(WA_ACCOUNTS_CONFIG_PATH)) {
        return {
            maxOnlineAccounts: 5,
            maxStartingAccounts: 1,
            maxChromeRssMbPerAccount: 3200,
            maxChromeRssMbTotal: 12000,
            restartConsecutiveBreaches: 3,
            noChromeConsecutiveChecks: 3,
            pm2DownConsecutiveChecks: 2,
            supervisorIntervalMs: 60000,
            staleInitLockSeconds: 720,
            restartCooldownSeconds: 900,
            deletedAccounts: [],
            accounts: []
        };
    }

    const config = JSON.parse(fs.readFileSync(WA_ACCOUNTS_CONFIG_PATH, 'utf8'));
    config.accounts = Array.isArray(config.accounts) ? config.accounts : [];
    config.deletedAccounts = Array.isArray(config.deletedAccounts) ? config.deletedAccounts : [];
    return config;
}

function writeWaAccountsConfig(config) {
    fs.mkdirSync(path.dirname(WA_ACCOUNTS_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(WA_ACCOUNTS_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function ensureWaAccountManaged(accountName) {
    const config = readWaAccountsConfig();
    config.accounts = Array.isArray(config.accounts) ? config.accounts : [];
    config.deletedAccounts = (config.deletedAccounts || []).filter(item => {
        const deletedName = typeof item === 'string' ? item : item.id;
        return deletedName !== accountName;
    });

    const existing = config.accounts.find(item => (item.id || item.name) === accountName);
    if (existing) {
        existing.id = accountName;
        delete existing.name;
        if (existing.enabled === false) existing.enabled = true;
    } else {
        config.accounts.push({ id: accountName, enabled: true, priority: 50 });
    }

    writeWaAccountsConfig(config);
}

function removeWaAccountManaged(accountName) {
    if (!fs.existsSync(WA_ACCOUNTS_CONFIG_PATH)) return;
    const config = readWaAccountsConfig();
    config.accounts = (config.accounts || []).filter(item => (item.id || item.name) !== accountName);
    const deletedNames = new Set((config.deletedAccounts || []).map(item => typeof item === 'string' ? item : item.id).filter(Boolean));
    deletedNames.add(accountName);
    config.deletedAccounts = Array.from(deletedNames).sort();
    writeWaAccountsConfig(config);
}

function clearWaInitGuards(accountName, reason = 'manual') {
    const files = [
        '/tmp/wa_chrome_init.lock',
        path.join('/tmp', `wa_chrome_init_cooldown_${accountName}.json`),
        path.join('/tmp', `wa_chrome_init_strikes_${accountName}.json`)
    ];

    for (const file of files) {
        try {
            if (!fs.existsSync(file)) continue;
            if (file.endsWith('wa_chrome_init.lock')) {
                const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (lock.holder !== accountName) continue;
            }
            fs.unlinkSync(file);
            console.log(`[WA INIT] Cleared ${path.basename(file)} for ${accountName} (${reason})`);
        } catch (err) {
            console.warn(`[WA INIT] Failed to clear ${file} for ${accountName}: ${err.message}`);
        }
    }
}

function clearWaSession(accountName) {
    const sessionRoots = [
        path.join(DATA_DIR, `whatsapp-session-${accountName}`),
        path.join(DATA_DIR, '.wwebjs_auth', `session-${accountName}`)
    ];
    for (const sessionRoot of sessionRoots) {
        try {
            if (fs.existsSync(sessionRoot)) {
                fs.rmSync(sessionRoot, { recursive: true, force: true });
                console.log(`[WA SESSION] Cleared session root for ${accountName}: ${sessionRoot}`);
            }
        } catch (err) {
            console.warn(`[WA SESSION] Failed to clear ${sessionRoot}: ${err.message}`);
        }
    }
}

function killWaChromeProcesses(accountName, callback) {
    const patterns = [
        `whatsapp-session-${accountName}`,
        `.wwebjs_auth/session-${accountName}`
    ];
    const cmd = patterns
        .map(pattern => `pgrep -f "${pattern}" 2>/dev/null`)
        .join(' ; ');
    const promise = execManagedCommand(`(${cmd}) | sort -u | xargs kill -9 2>/dev/null || true`, { shell: '/bin/bash' });
    if (typeof callback === 'function') {
        promise.then(() => callback()).catch(callback);
    }
    return promise;
}

async function restartPm2Worker(workerName) {
    await wait(ACCOUNT_RESTART_DELAY_MS);
    return execManagedCommand(`pm2 restart ${workerName}`);
}

function serializeEcosystemConfig(config) {
    const content = `module.exports = ${JSON.stringify(config, null, 2)};\n`;
    return content.replace(
        /\n    \{\n      "name": "ui-server"/,
        '\n    // --- Web UI Server ---\n    {\n      "name": "ui-server"'
    );
}

function loadEcosystemConfig(ecoPath) {
    const resolved = require.resolve(ecoPath);
    delete require.cache[resolved];
    return require(resolved);
}

function ensureRuntimeEcosystemConfig(ecoPath) {
    if (fs.existsSync(ecoPath)) return;

    const appRoot = path.join(__dirname, '..');
    const candidates = [
        path.join(appRoot, 'ecosystem.cloud.config.js'),
        path.join(appRoot, 'ecosystem.config.js')
    ];
    const source = candidates.find(item => fs.existsSync(item));
    if (!source) {
        throw new Error('找不到可用于初始化的 ecosystem 配置');
    }

    fs.mkdirSync(path.dirname(ecoPath), { recursive: true });
    fs.copyFileSync(source, ecoPath);
    console.log(`[ECOSYSTEM] Initialized runtime ecosystem config from ${source}`);
}

function removeAppFromEcosystem(ecoPath, workerName) {
    const config = loadEcosystemConfig(ecoPath);
    if (!config || !Array.isArray(config.apps)) {
        throw new Error('ecosystem.config.js 解析后 apps 不是数组');
    }

    const before = config.apps.length;
    config.apps = config.apps.filter(app => app && app.name !== workerName);
    return {
        removed: before !== config.apps.length,
        content: serializeEcosystemConfig(config)
    };
}

function buildWaAppConfig(accountName) {
    const explicitChromePath = getConfiguredEnvValue('PUPPETEER_EXECUTABLE_PATH');
    const env = applyCollectorEnv({
        NODE_ENV: 'production',
        DATA_DIR,
        ACCOUNT_NAME: accountName,
        WA_ORCHESTRATOR_MANAGED_INIT: 'true',
        WA_INIT_COOLDOWN_MS: '30000',
        WA_INIT_QUARANTINE_AFTER: '10',
        WA_INIT_QUARANTINE_MS: '60000',
        WA_INIT_HARD_TIMEOUT_MS: '360000',
        WA_AUTH_TIMEOUT_MS: '300000',
        WA_PROTOCOL_TIMEOUT_MS: '600000',
        WA_QR_IDLE_TIMEOUT_MS: '180000',
        PUPPETEER_SKIP_DOWNLOAD: 'true'
    }, `pm2:${accountName}`);

    if (explicitChromePath) {
        env.PUPPETEER_EXECUTABLE_PATH = explicitChromePath;
    }

    return {
        name: `worker-wa-${accountName}`,
        script: './workers/worker-wa.js',
        max_memory_restart: '4G',
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        watch: false,
        kill_timeout: 15000,
        restart_delay: 30000,
        max_restarts: 5,
        min_uptime: '2m',
        env
    };
}

function buildTgBotAppConfig(accountName, token) {
    const env = applyCollectorEnv({
        NODE_ENV: 'production',
        DATA_DIR,
        TG_ACCOUNT_NAME: accountName,
        TG_BOT_TOKEN: token
    }, `pm2:tg:${accountName}`);

    return {
        name: `worker-tg-${accountName}`,
        script: './workers/worker-tg.js',
        instances: 1,
        autorestart: true,
        watch: false,
        env
    };
}

function upsertAppInEcosystem(ecoPath, appConfig) {
    const config = loadEcosystemConfig(ecoPath);
    if (!config || !Array.isArray(config.apps)) {
        throw new Error('ecosystem.config.js 解析后 apps 不是数组');
    }

    const existingIndex = config.apps.findIndex(app => app && app.name === appConfig.name);
    if (existingIndex >= 0) {
        config.apps[existingIndex] = appConfig;
    } else {
        const uiIndex = config.apps.findIndex(app => app && app.name === 'ui-server');
        if (uiIndex >= 0) config.apps.splice(uiIndex, 0, appConfig);
        else config.apps.push(appConfig);
    }

    return serializeEcosystemConfig(config);
}

function clearTgUserRuntimeConfig(accountName) {
    const name = accountName.toUpperCase();
    writeEnvKeys({
        [`TG_USER_SESSION_${name}`]: '',
        [`TG_API_ID_${name}`]: '',
        [`TG_API_HASH_${name}`]: '',
        [`TG_WHITELIST_${name}`]: '',
        [`TG_WARMUP_SECONDS_${name}`]: '',
        [`TG_DAILY_LIMIT_${name}`]: '',
        [`TG_BATCH_SIZE_${name}`]: '',
        [`TG_SLEEP_MIN_MS_${name}`]: '',
        [`TG_SLEEP_MAX_MS_${name}`]: '',
        [`TG_BACKFILL_DAYS_${name}`]: '',
        [`TG_ENABLE_BACKFILL_${name}`]: ''
    });
}

function accountEnvKey(accountName) {
    return String(accountName || '').toUpperCase().replace(/-/g, '_');
}

function normalizeAccountRole(role) {
    const value = String(role || '').trim().toLowerCase();
    if (['collector', 'service', 'both', 'disabled'].includes(value)) return value;
    return 'collector';
}

function roleDefaults(role) {
    const normalized = normalizeAccountRole(role);
    const service = normalized === 'service' || normalized === 'both';
    const collect = normalized === 'collector' || normalized === 'service' || normalized === 'both';
    return {
        account_role: normalized,
        workbench_visible: service ? 1 : 0,
        collect_enabled: collect ? 1 : 0,
        send_enabled: service ? 1 : 0,
        sync_groups_enabled: service ? 1 : 0,
    };
}

function registryPlatformFromAccountId(id, platform) {
    const value = String(platform || '').trim().toLowerCase();
    if (value === 'whatsapp' || value === 'wa') return 'wa';
    if (value === 'telegram' || value === 'tg') return 'tg';
    if (value === 'teams') return 'teams';
    if (String(id || '').startsWith('wa-')) return 'wa';
    if (String(id || '').startsWith('tg-') || String(id || '').startsWith('tgu-')) return 'tg';
    if (String(id || '').startsWith('teams-')) return 'teams';
    return value || 'unknown';
}

function accountLoginType(platform) {
    const normalized = registryPlatformFromAccountId('', platform);
    if (normalized === 'wa') return 'wa_personal_qr';
    if (normalized === 'tg') return 'telegram_bot_api';
    if (normalized === 'teams') return 'teams_oauth';
    return 'unknown';
}

function normalizeRolePatch(body = {}) {
    const defaults = roleDefaults(body.account_role || body.role);
    return {
        ...defaults,
        workbench_visible: body.workbench_visible == null ? defaults.workbench_visible : Number(Boolean(body.workbench_visible)),
        collect_enabled: body.collect_enabled == null ? defaults.collect_enabled : Number(Boolean(body.collect_enabled)),
        send_enabled: body.send_enabled == null ? defaults.send_enabled : Number(Boolean(body.send_enabled)),
        sync_groups_enabled: body.sync_groups_enabled == null ? defaults.sync_groups_enabled : Number(Boolean(body.sync_groups_enabled)),
        display_name: body.display_name || null,
        owner_team: body.owner_team || null,
        risk_level: body.risk_level || null,
    };
}

function getRuntimeSpec(accountId) {
    try {
        return db.prepare('SELECT * FROM collector_runtime_specs WHERE account_id = ?').get(accountId) || null;
    } catch (_) {
        return null;
    }
}

function shouldUseCloudRuntime(accountId) {
    if (isCloudCollectorEnabled()) return true;
    const spec = getRuntimeSpec(accountId);
    return spec?.runtime_provider === 'k8s';
}

function createCloudOrchestrator() {
    return new CloudCollectorOrchestrator({ logger: console });
}

function inferSessionStatus(acc) {
    try {
        if (acc.id.startsWith('tgu-')) return getTgUserSessionStatus(acc.id.replace('tgu-', ''));
        if (acc.id.startsWith('teams-')) return teamsTokenStore.hasTokens(acc.id.replace('teams-', '')) ? 'configured' : 'not_configured';
        if (acc.id.startsWith('wa-')) {
            const name = acc.id.replace('wa-', '');
            const cloudSession = path.join(DATA_DIR, 'collector-sessions', 'wa', `session-${name}`);
            const localSession = path.join(DATA_DIR, '.wwebjs_auth', `session-${name}`);
            return fs.existsSync(cloudSession) || fs.existsSync(localSession) ? 'configured' : 'not_configured';
        }
    } catch (_) {}
    return acc.session_status || null;
}

let mutationChain = Promise.resolve();

function serializeMutation(taskFn) {
    const run = mutationChain.then(() => taskFn());
    mutationChain = run.catch(() => {});
    return run;
}

function runSerializedMutation(label, req, res, taskFn) {
    return serializeMutation(() => Promise.resolve().then(taskFn)).catch(err => {
        console.error(`${label} Error:`, err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: err.message });
        }
    });
}

function createAccountsRouter({ safeWriteEcosystem }) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        try {
            const accounts = db.prepare(`SELECT * FROM accounts ORDER BY updated_at DESC`).all();
            const registryByAccount = new Map(listChannelAccountRegistry().map(row => [row.account, row]));
            const waChromeStats = await collectWaChromeStats();
            const waChromeById = new Map((waChromeStats.accounts || []).map(item => [item.accountId, item]));
            const heartbeats = db.prepare(`
                SELECT *
                FROM collector_heartbeats
                ORDER BY datetime(updated_at) DESC
            `).all();
            const runtimeSpecs = db.prepare(`
                SELECT *
                FROM collector_runtime_specs
                ORDER BY datetime(updated_at) DESC
            `).all();
            const runtimeSpecByAccount = new Map(runtimeSpecs.map(item => [item.account_id, item]));
            const heartbeatByAccount = new Map();
            for (const row of heartbeats) {
                if (!heartbeatByAccount.has(row.account_id)) heartbeatByAccount.set(row.account_id, row);
            }
            
            // Add running status assessment for each account
            accounts.forEach(acc => {
                const registry = registryByAccount.get(acc.id) || null;
                acc.channel_registry = registry;
                acc.account_role = registry?.account_role || 'collector';
                acc.workbench_visible = registry ? Boolean(registry.workbench_visible) : false;
                acc.collect_enabled = registry ? Boolean(registry.collect_enabled) : true;
                acc.send_enabled = registry ? Boolean(registry.send_enabled) : false;
                acc.sync_groups_enabled = registry ? Boolean(registry.sync_groups_enabled) : false;
                acc.risk_level = registry?.risk_level || 'low';
                acc.owner_team = registry?.owner_team || null;
                acc.workbench_display_name = registry?.display_name || acc.display_name || acc.pushname || acc.id;
                const runtimeSpec = runtimeSpecByAccount.get(acc.id);
                if (runtimeSpec) {
                    acc.runtime_provider = runtimeSpec.runtime_provider || acc.runtime_provider || 'k8s';
                    acc.runtime_desired_state = runtimeSpec.desired_state;
                    acc.deployment_name = runtimeSpec.deployment_name;
                    acc.runtime_spec = {
                        desired_state: runtimeSpec.desired_state,
                        deployment_name: runtimeSpec.deployment_name,
                        namespace: runtimeSpec.namespace,
                        session_dir: runtimeSpec.session_dir,
                        last_applied_at: runtimeSpec.last_applied_at,
                        last_error: runtimeSpec.last_error
                    };
                }
                acc.session_status = inferSessionStatus(acc);
                const chromeStats = waChromeById.get(acc.id);
                const heartbeat = heartbeatByAccount.get(acc.id);
                const heartbeatAge = heartbeat ? secondsSince(heartbeat.updated_at) : null;
                acc.collector = heartbeat ? {
                    collector_id: heartbeat.collector_id,
                    run_id: heartbeat.run_id,
                    pid: heartbeat.process_pid,
                    status: heartbeat.status,
                    phase: heartbeat.phase,
                    health_status: heartbeat.health_status,
                    last_error: heartbeat.last_error,
                    last_ready_at: heartbeat.last_ready_at,
                    last_message_at: heartbeat.last_message_at,
                    updated_at: heartbeat.updated_at,
                    heartbeat_age_seconds: heartbeatAge,
                    fresh: heartbeatAge !== null && heartbeatAge <= 45
                } : null;
                acc.collector_phase = acc.collector?.phase || acc.collector_phase || null;
                acc.collector_heartbeat_age_seconds = heartbeatAge;

                if (chromeStats) {
                    acc.chrome_rss_mb = chromeStats.rssMb;
                    acc.chrome_process_count = chromeStats.processCount;
                } else if (acc.platform === 'whatsapp' && heartbeat) {
                    acc.chrome_rss_mb = heartbeat.chrome_rss_mb || 0;
                    acc.chrome_process_count = heartbeat.chrome_process_count || 0;
                } else if (acc.platform === 'whatsapp') {
                    acc.chrome_rss_mb = 0;
                    acc.chrome_process_count = 0;
                }

                if (acc.platform === 'whatsapp') {
                    acc.runtime_status = acc.orchestrator_state || acc.health_status || acc.status;

                    if (!acc.orchestrator_state && ['authenticated', 'monitoring', 'warmup'].includes(acc.status)) {
                        const hasChrome = Number(acc.chrome_process_count || 0) > 0;
                        const freshHeartbeat = acc.collector?.fresh === true;
                        if (!hasChrome || !freshHeartbeat) {
                            acc.runtime_status = 'stale_online';
                            acc.health_status = !hasChrome ? 'no_chrome' : 'stale_heartbeat';
                        }
                    }
                }

                // Find the latest message for this account
                const latestMsg = db.prepare(`
                    SELECT created_at FROM messages
                    WHERE receiver_account = ?
                    ORDER BY created_at DESC LIMIT 1
                `).get(acc.id);
                
                acc.latest_msg_time = latestMsg ? latestMsg.created_at : null;
                
                // Perform status assessment
                const recentInitError = acc.collector?.last_error || '';
                const recentRestart = acc.last_restart_reason || '';

                if (acc.runtime_status === 'stale_online') {
                    acc.health_assessment = acc.chrome_process_count > 0 ? '心跳过期，待恢复' : '假在线：无 Chrome 进程';
                    acc.health_color = '#DD6B20';
                } else if (['queued', 'cooling_down', 'starting'].includes(acc.runtime_status)) {
                    if (acc.runtime_status === 'queued') {
                        acc.health_assessment = '排队等待启动';
                    } else if (acc.runtime_status === 'cooling_down') {
                        acc.health_assessment = recentInitError ? `初始化冷却：${recentInitError}` : '初始化冷却中';
                    } else {
                        acc.health_assessment = recentInitError ? `启动中：${recentInitError}` : '启动初始化中';
                    }
                    acc.health_color = '#DD6B20';
                } else if (['pm2_down', 'runtime_down', 'recovering_pm2', 'recovering_runtime', 'recovering_init', 'no_chrome', 'stale_heartbeat', 'degraded_high_rss'].includes(acc.runtime_status)) {
                    const m = {
                        pm2_down: 'PM2 异常，调度恢复中',
                        runtime_down: '运行时异常，调度恢复中',
                        recovering_pm2: '正在恢复 PM2 进程',
                        recovering_runtime: '正在恢复采集运行时',
                        recovering_init: '正在恢复初始化失败',
                        no_chrome: '无 Chrome 进程',
                        stale_heartbeat: '采集心跳过期',
                        degraded_high_rss: 'Chrome 内存偏高'
                    };
                    acc.health_assessment = recentRestart || recentInitError || m[acc.runtime_status] || '运行异常';
                    acc.health_color = '#DD6B20';
                } else if (acc.runtime_status === 'qr_timeout') {
                    acc.health_assessment = '扫码超时，进程已停止';
                    acc.health_color = '#E53E3E';
                } else if (['auth_failure', 'init_timeout', 'init_failed', 'no_browser_timeout'].includes(acc.runtime_status)) {
                    acc.health_assessment = recentInitError || '初始化失败，等待保护恢复';
                    acc.health_color = '#E53E3E';
                } else if (['authenticated', 'monitoring', 'warmup'].includes(acc.status)) {
                    if (!acc.latest_msg_time) {
                        acc.health_assessment = '就绪 (待命)';
                        acc.health_color = '#25D366'; // WhatsApp Green
                    } else {
                        // Calculate time difference
                        const now = Date.now();
                        const lastMsgDate = parseShanghaiDate(acc.latest_msg_time);
                        const diffHrs = (now - lastMsgDate) / (1000 * 60 * 60);
                        
                        if (diffHrs < 2) {
                            acc.health_assessment = '极佳 (活跃中)';
                            acc.health_color = '#25D366'; // WhatsApp Green
                        } else if (diffHrs < 8) {
                            acc.health_assessment = '健康 (空闲中)';
                            acc.health_color = '#3182CE'; // Blue
                        } else if (diffHrs < 24) {
                            acc.health_assessment = '正常 (超过2小时无新消息)';
                            acc.health_color = '#4A5568'; // Gray
                        } else {
                            acc.health_assessment = '警告 (超24h无消息，检查连接/群动态)';
                            acc.health_color = '#DD6B20'; // Orange
                        }
                    }
                } else if (acc.status === 'qr') {
                    acc.health_assessment = acc.platform === 'teams' ? '等待网页授权' : '等待扫码';
                    acc.health_color = '#E53E3E'; // Red
                } else if (acc.status === 'initializing') {
                    acc.health_assessment = '正在初始化...';
                    acc.health_color = '#DD6B20'; // Orange
                } else {
                    acc.health_assessment = '已停止/未连接';
                    acc.health_color = '#718096'; // Muted Gray
                }
            });

            res.json({ success: true, data: accounts });
        } catch (err) {
            console.error('Accounts DB Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/wa-runtime', (req, res) => {
        getWaChromeStats((err, stats) => {
            if (err) {
                console.error('[WA Runtime] Failed to collect Chrome stats:', err.message);
                return res.status(500).json({ success: false, error: err.message });
            }

            res.json({ success: true, data: stats });
        });
    });

    router.get('/wa-supervisor', async (req, res) => {
        try {
            const runtime = await collectWaChromeStats();
            const config = fs.existsSync(WA_ACCOUNTS_CONFIG_PATH)
                ? JSON.parse(fs.readFileSync(WA_ACCOUNTS_CONFIG_PATH, 'utf8'))
                : null;
            const chrome = getPuppeteerChromeInfo(puppeteer);
            const webVersionCache = getWaWebVersionCacheInfo(DATA_DIR);
            const heartbeats = db.prepare(`
                SELECT *
                FROM collector_heartbeats
                WHERE platform = 'whatsapp'
                ORDER BY updated_at DESC
            `).all();
            const recentEvents = db.prepare(`
                SELECT *
                FROM wa_runtime_events
                ORDER BY id DESC
                LIMIT 50
            `).all();

            res.json({
                success: true,
                data: {
                    configPath: WA_ACCOUNTS_CONFIG_PATH,
                    config,
                    chrome,
                    webVersionCache,
                    runtime,
                    heartbeats,
                    recentEvents
                }
            });
        } catch (err) {
            console.error('[WA Supervisor API] Failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/wa-events', (req, res) => {
        try {
            const accountId = req.query.account_id;
            const limit = Math.min(Number(req.query.limit || 100), 300);
            const rows = accountId
                ? db.prepare(`
                    SELECT *
                    FROM wa_runtime_events
                    WHERE account_id = ?
                    ORDER BY id DESC
                    LIMIT ?
                `).all(accountId, limit)
                : db.prepare(`
                    SELECT *
                    FROM wa_runtime_events
                    ORDER BY id DESC
                    LIMIT ?
                `).all(limit);
            res.json({ success: true, data: rows });
        } catch (err) {
            console.error('[WA Events API] Failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/logout', (req, res) => runSerializedMutation('Logout', req, res, async () => {
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, error: 'Missing account id' });
        if (!/^(wa|tg|tgu)-[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'Invalid account id format' });
        
        try {
            if (shouldUseCloudRuntime(id)) {
                const orchestrator = createCloudOrchestrator();
                if (!getRuntimeSpec(id)) await orchestrator.ensureRuntime(id, { migrationSource: 'api-logout' });
                if (id.startsWith('wa-')) orchestrator.clearSession(id);
                await orchestrator.restart(id);
                db.prepare(`UPDATE accounts SET status = 'disconnected', qr_code = NULL, runtime_provider = 'k8s', updated_at = datetime('now', '+8 hours') WHERE id = ?`).run(id);
                return res.json({ success: true, message: 'Cloud collector session cleared and restarted.' });
            }

            if (id.startsWith('wa-')) {
                if (!LOCAL_WA_RUNTIME_ENABLED) {
                    return res.status(409).json({ success: false, error: '生产端已禁用本地 WA 运行时，请在本地 collector 机器执行重登/重启。' });
                }
                const accName = id.replace('wa-', '');
                db.prepare(`UPDATE accounts SET status = 'disconnected', qr_code = NULL WHERE id = ?`).run(id);
                const sessionPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `whatsapp-session-${accName}`);
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }

                await restartPm2Worker(`worker-wa-${accName}`);
            }
            res.json({ success: true, message: 'Logged out. Account is resetting.' });
        } catch (err) {
            console.error('Logout Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    }));

    router.post('/restart', (req, res) => runSerializedMutation('Restart', req, res, async () => {
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, error: 'Missing account id' });
        if (!/^(wa|tg|tgu|teams)-[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'Invalid account id format' });

        try {
            let workerName = '';
            let accName = '';
            if (shouldUseCloudRuntime(id)) {
                const orchestrator = createCloudOrchestrator();
                if (!getRuntimeSpec(id)) await orchestrator.ensureRuntime(id, { migrationSource: 'api-restart' });
                await orchestrator.restart(id);
                db.prepare(`UPDATE accounts SET runtime_provider = 'k8s', runtime_desired_state = 'running', orchestrator_state = 'restarting', updated_at = datetime('now', '+8 hours') WHERE id = ?`).run(id);
                return res.json({ success: true, message: 'Cloud collector restart command sent.' });
            }

            if (id.startsWith('wa-')) {
                if (!LOCAL_WA_RUNTIME_ENABLED) {
                    return res.status(409).json({ success: false, error: '生产端已禁用本地 WA 运行时，请在本地 collector 机器重启对应 PM2 进程。' });
                }
                accName = id.replace('wa-', '');
                workerName = `worker-wa-${accName}`;
            } else if (id.startsWith('tg-')) {
                accName = id.replace('tg-', '');
                workerName = `worker-tg-${accName}`;
            } else if (id.startsWith('tgu-')) {
                accName = id.replace('tgu-', '');
                workerName = `worker-tgu-${accName}`;
            } else if (id.startsWith('teams-')) {
                accName = id.replace('teams-', '');
                workerName = `worker-teams-${accName}`;
            } else {
                return res.status(400).json({ success: false, error: 'Invalid account id prefix' });
            }

            db.prepare(`UPDATE accounts SET status = 'initializing', qr_code = NULL WHERE id = ?`).run(id);

            if (id.startsWith('wa-')) {
                const LOCK_FILE = '/tmp/wa_chrome_init.lock';
                await killWaChromeProcesses(accName);

                try {
                    if (fs.existsSync(LOCK_FILE)) {
                        const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
                        const age = Date.now() - lock.ts;
                        if (lock.holder === accName || age > 6 * 60 * 1000) {
                            fs.unlinkSync(LOCK_FILE);
                            console.log(`[RESTART] 已释放初始化锁（原持有者: ${lock.holder}）`);
                        }
                    }
                } catch (_) {}
            }

            await restartPm2Worker(workerName);

            res.json({ success: true, message: 'Restart command sent. Login session was preserved.' });
        } catch (err) {
            console.error('Restart Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    }));

    router.post('/relogin', (req, res) => runSerializedMutation('Relogin', req, res, async () => {
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, error: 'Missing account id' });
        if (!/^(wa|tg|tgu|teams)-[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'Invalid account id format' });
        
        try {
            let workerName = '';
            let accName = '';
            if (shouldUseCloudRuntime(id)) {
                const orchestrator = createCloudOrchestrator();
                if (!getRuntimeSpec(id)) await orchestrator.ensureRuntime(id, { migrationSource: 'api-relogin' });
                if (id.startsWith('wa-')) orchestrator.clearSession(id);
                db.prepare(`UPDATE accounts SET status = 'initializing', qr_code = NULL, runtime_provider = 'k8s', runtime_desired_state = 'running', updated_at = datetime('now', '+8 hours') WHERE id = ?`).run(id);
                await orchestrator.restart(id);
                return res.json({ success: true, message: 'Cloud collector relogin command sent.' });
            }

            if (id.startsWith('wa-')) {
                if (!LOCAL_WA_RUNTIME_ENABLED) {
                    return res.status(409).json({ success: false, error: '生产端已禁用本地 WA 运行时，请在本地 collector 机器清理 session 并重启。' });
                }
                accName = id.replace('wa-', '');
                workerName = `worker-wa-${accName}`;
            } else if (id.startsWith('tg-')) {
                accName = id.replace('tg-', '');
                workerName = `worker-tg-${accName}`;
            } else if (id.startsWith('tgu-')) {
                accName = id.replace('tgu-', '');
                workerName = `worker-tgu-${accName}`;
            } else if (id.startsWith('teams-')) {
                accName = id.replace('teams-', '')
                workerName = `worker-teams-${accName}`;
            } else {
                return res.status(400).json({ success: false, error: 'Invalid account id prefix' });
            }

            db.prepare(`UPDATE accounts SET status = 'initializing', qr_code = NULL WHERE id = ?`).run(id);

            // ── WA 账号额外清理：杀 Chrome、释放锁、清 Session Auth ────────
            if (id.startsWith('wa-')) {
                // 1. 杀掉该账号所有 Chrome 进程，杀完后再删除 session，避免残留文件句柄污染新 profile。
                await killWaChromeProcesses(accName);

                // 2. 人工重新登录必须绕过自动保护冷却，否则会一直等旧 cooldown，不出二维码。
                clearWaInitGuards(accName, 'relogin');

                // 3. 完整清除 LocalAuth profile，确保下次启动生成全新 QR。
                clearWaSession(accName);
                console.log(`[RELOGIN] ${accName} Session 已完整清除，准备重启`);
            }

            await restartPm2Worker(workerName);
            
            res.json({ success: true, message: 'Restart command sent. QR code will appear shortly.' });
        } catch (err) {
            console.error('Relogin Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    }));

    router.get('/:id/runtime', async (req, res) => {
        const { id } = req.params;
        if (!/^(wa|tg|tgu|teams)-[a-zA-Z0-9_-]+$/.test(id)) {
            return res.status(400).json({ success: false, error: 'Invalid account id format' });
        }
        try {
            const orchestrator = createCloudOrchestrator();
            const data = await orchestrator.runtimeStatus(id);
            if (!data) return res.status(404).json({ success: false, error: 'Runtime spec not found' });
            res.json({ success: true, data });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/:id/runtime/:action', (req, res) => runSerializedMutation('Runtime Action', req, res, async () => {
        const { id, action } = req.params;
        if (!/^(wa|tg|tgu|teams)-[a-zA-Z0-9_-]+$/.test(id)) {
            return res.status(400).json({ success: false, error: 'Invalid account id format' });
        }
        if (!['start', 'stop', 'restart', 'relogin'].includes(action)) {
            return res.status(400).json({ success: false, error: 'Invalid runtime action' });
        }

        const orchestrator = createCloudOrchestrator();
        if (action === 'start') {
            if (!getRuntimeSpec(id)) await orchestrator.ensureRuntime(id, { migrationSource: 'api-runtime-start' });
            await orchestrator.start(id);
        } else if (action === 'stop') {
            await orchestrator.stop(id);
        } else if (action === 'restart') {
            await orchestrator.restart(id);
        } else if (action === 'relogin') {
            if (id.startsWith('wa-')) orchestrator.clearSession(id);
            await orchestrator.restart(id);
            db.prepare(`UPDATE accounts SET status = 'initializing', qr_code = NULL, updated_at = datetime('now', '+8 hours') WHERE id = ?`).run(id);
        }

        res.json({ success: true, message: `Runtime ${action} command sent.` });
    }));

    router.delete('/:id', (req, res) => runSerializedMutation('Delete Account', req, res, async () => {
        const { id } = req.params;
        console.log('[DELETE ACCOUNT] Request to delete:', id);
        if (!id) return res.status(400).json({ success: false, error: 'Missing account id' });
        if (!/^(wa|tg|tgu|teams)-[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'Invalid account id format' });

        try {
            let workerName = '';
            let accName = '';
            if (id.startsWith('wa-')) {
                accName = id.replace('wa-', '');
                workerName = `worker-wa-${accName}`;
            } else if (id.startsWith('tg-')) {
                accName = id.replace('tg-', '');
                workerName = `worker-tg-${accName}`;
            } else if (id.startsWith('tgu-')) {
                accName = id.replace('tgu-', '');
                workerName = `worker-tgu-${accName}`;
            } else if (id.startsWith('teams-')) {
                accName = id.replace('teams-', '');
                workerName = `worker-teams-${accName}`;
            } else {
                return res.status(400).json({ success: false, error: 'Invalid account id prefix' });
            }

            if (shouldUseCloudRuntime(id) || getRuntimeSpec(id)) {
                try {
                    await createCloudOrchestrator().delete(id);
                } catch (err) {
                    console.warn(`[DELETE ACCOUNT] Failed to delete cloud runtime for ${id}: ${err.message}`);
                }
            }

            db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
            db.prepare('DELETE FROM collector_heartbeats WHERE account_id = ?').run(id);
            db.prepare('DELETE FROM wa_runtime_events WHERE account_id = ?').run(id);

            if (id.startsWith('wa-')) {
                clearWaInitGuards(accName, 'delete');
                clearWaSession(accName);
                removeWaAccountManaged(accName);
            } else if (id.startsWith('tgu-')) {
                clearTgUserRuntimeConfig(accName);
            }

            const ecoPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'ecosystem.config.js');
            if (fs.existsSync(ecoPath)) {
                const result = removeAppFromEcosystem(ecoPath, workerName);
                console.log(`[DELETE ACCOUNT] ecosystem app ${workerName}: ${result.removed ? 'removed' : 'not found'}`);
                if (result.removed) safeWriteEcosystem(result.content);
            }

            try {
                await execManagedCommand(`npx pm2 delete ${workerName}`);
            } catch (error) {
                console.log(`Notice: Could not delete PM2 process ${workerName} (may already be stopped).`, error.message);
            }

            try {
                await execManagedCommand('npx pm2 save');
                console.log('[DELETE ACCOUNT] PM2 save succeeded');
            } catch (err) {
                console.error('[DELETE ACCOUNT] PM2 save failed:', err);
            }

            res.json({ success: true, message: 'Account permanently deleted.' });
        } catch (err) {
            console.error('[DELETE ACCOUNT] Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    }));

    router.patch('/:id/workbench-role', (req, res) => runSerializedMutation('Workbench Role', req, res, async () => {
        const { id } = req.params;
        if (!/^(wa|tg|tgu|teams)-[a-zA-Z0-9_-]+$/.test(id)) {
            return res.status(400).json({ success: false, error: 'Invalid account id format' });
        }
        const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
        if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
        const patch = normalizeRolePatch(req.body || {});
        const registry = upsertChannelAccountRegistry({
            account: id,
            platform: registryPlatformFromAccountId(id, account.platform),
            login_type: accountLoginType(account.platform),
            display_name: patch.display_name || account.display_name || account.pushname || id,
            status: account.status,
            ...patch,
        });
        res.json({ success: true, data: registry });
    }));

    router.post('/create', (req, res) => runSerializedMutation('Create', req, res, async () => {
        const { platform, id, token } = req.body;
        console.log('[CREATE ACCOUNT] Request:', { platform, id, token });
        if (!platform || !id) return res.status(400).json({ success: false, error: 'Missing platform or id' });
        const trimmedId = id.trim();
        console.log('[CREATE ACCOUNT] Trimmed ID:', trimmedId, 'Regex test:', /^[a-zA-Z0-9_-]+$/.test(trimmedId));
        if (platform === 'telegram' && !token) return res.status(400).json({ success: false, error: 'Missing Bot Token for Telegram' });
        if (!/^[a-zA-Z0-9_-]+$/.test(trimmedId)) return res.status(400).json({ success: false, error: 'ID 只能包含字母、数字、下划线和横线' });
        if (platform === 'whatsapp' && trimmedId.startsWith('wa-')) {
            return res.status(400).json({ success: false, error: 'WhatsApp ID 不需要 wa- 前缀，请直接填写账号名' });
        }
        if (platform === 'telegram' && trimmedId.startsWith('tg-')) {
            return res.status(400).json({ success: false, error: 'Telegram ID 不需要 tg- 前缀，请直接填写账号名' });
        }
        if (token && !/^[a-zA-Z0-9_:.-]+$/.test(token)) return res.status(400).json({ success: false, error: 'Invalid token format' });

        const accountRolePatch = normalizeRolePatch(req.body || {});
        const accountId = platform === 'whatsapp' ? `wa-${trimmedId}` : `tg-${trimmedId}`;

        try {
            if (isCloudCollectorEnabled()) {
                const orchestrator = createCloudOrchestrator();
                if (platform === 'whatsapp') {
                    db.prepare(`
                        INSERT INTO accounts (id, platform, status, health_status, runtime_provider, runtime_desired_state, updated_at)
                        VALUES (?, 'whatsapp', 'initializing', 'starting', 'k8s', 'running', datetime('now', '+8 hours'))
                        ON CONFLICT(id) DO UPDATE SET
                            status = 'initializing',
                            health_status = 'starting',
                            runtime_provider = 'k8s',
                            runtime_desired_state = 'running',
                            updated_at = datetime('now', '+8 hours')
                    `).run(accountId);
                    upsertChannelAccountRegistry({
                        account: accountId,
                        platform: 'wa',
                        login_type: 'wa_personal_qr',
                        display_name: accountRolePatch.display_name || accountId,
                        status: 'initializing',
                        ...accountRolePatch,
                    });
                    await orchestrator.ensureRuntime(accountId, { migrationSource: 'web-create' });
                    return res.json({ success: true, message: 'WhatsApp 云端采集 Pod 已创建，请稍后在列表中扫描二维码。' });
                }

                if (platform === 'telegram') {
                    writeEnvKeys({ [`TG_BOT_TOKEN_${accountEnvKey(trimmedId)}`]: token });
                    db.prepare(`
                        INSERT INTO accounts (id, platform, status, health_status, runtime_provider, runtime_desired_state, updated_at)
                        VALUES (?, 'telegram', 'initializing', 'starting', 'k8s', 'running', datetime('now', '+8 hours'))
                        ON CONFLICT(id) DO UPDATE SET
                            status = 'initializing',
                            health_status = 'starting',
                            runtime_provider = 'k8s',
                            runtime_desired_state = 'running',
                            updated_at = datetime('now', '+8 hours')
                    `).run(accountId);
                    upsertChannelAccountRegistry({
                        account: accountId,
                        platform: 'tg',
                        login_type: 'telegram_bot_api',
                        display_name: accountRolePatch.display_name || accountId,
                        status: 'initializing',
                        ...accountRolePatch,
                    });
                    await orchestrator.ensureRuntime(accountId, { migrationSource: 'web-create' });
                    return res.json({ success: true, message: 'TG Bot 云端采集 Pod 已创建。' });
                }
            }

            let workerName, scriptPath;
            if (platform === 'whatsapp') {
                workerName = `worker-wa-${trimmedId}`;
                scriptPath = './workers/worker-wa.js';
                if (!LOCAL_WA_RUNTIME_ENABLED) {
                    db.prepare(`
                        INSERT INTO accounts (id, platform, status, health_status, runtime_provider, updated_at)
                        VALUES (?, 'whatsapp', 'remote_pending', 'remote_collector_required', 'remote-collector', datetime('now', '+8 hours'))
                        ON CONFLICT(id) DO UPDATE SET
                            status = excluded.status,
                            health_status = excluded.health_status,
                            runtime_provider = excluded.runtime_provider,
                            updated_at = datetime('now', '+8 hours')
                    `).run('wa-' + trimmedId);
                    upsertChannelAccountRegistry({
                        account: 'wa-' + trimmedId,
                        platform: 'wa',
                        login_type: 'wa_personal_qr',
                        display_name: accountRolePatch.display_name || 'wa-' + trimmedId,
                        status: 'remote_pending',
                        ...accountRolePatch,
                    });
                    return res.json({
                        success: true,
                        message: 'WhatsApp 账号已在生产端登记；请在本地 collector PM2 配置中启动同名账号并配置 COLLECTOR_API_URL/COLLECTOR_TOKEN。'
                    });
                }
                db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status) VALUES (?, 'whatsapp', 'initializing')`).run('wa-' + trimmedId);
                upsertChannelAccountRegistry({
                    account: 'wa-' + trimmedId,
                    platform: 'wa',
                    login_type: 'wa_personal_qr',
                    display_name: accountRolePatch.display_name || 'wa-' + trimmedId,
                    status: 'initializing',
                    ...accountRolePatch,
                });
                ensureWaAccountManaged(trimmedId);
            } else {
                workerName = `worker-tg-${trimmedId}`;
                scriptPath = './workers/worker-tg.js';
                db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status) VALUES (?, 'telegram', 'initializing')`).run('tg-' + trimmedId);
                upsertChannelAccountRegistry({
                    account: 'tg-' + trimmedId,
                    platform: 'tg',
                    login_type: 'telegram_bot_api',
                    display_name: accountRolePatch.display_name || 'tg-' + trimmedId,
                    status: 'initializing',
                    ...accountRolePatch,
                });
            }

            const ecoPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'ecosystem.config.js');
            ensureRuntimeEcosystemConfig(ecoPath);
            const appConfig = platform === 'whatsapp'
                ? buildWaAppConfig(trimmedId)
                : buildTgBotAppConfig(trimmedId, token);
            safeWriteEcosystem(upsertAppInEcosystem(ecoPath, appConfig));

            const cmd = `npx pm2 start "${ecoPath}" --only "${workerName}" --env production`;
            
            const spawnEnv = { 
                NODE_ENV: 'production', 
                DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..')
            };

            if (platform === 'whatsapp') {
                spawnEnv.ACCOUNT_NAME = trimmedId;
            } else {
                spawnEnv.TG_ACCOUNT_NAME = trimmedId;
                spawnEnv.TG_BOT_TOKEN = token;
            }

            try {
                await execManagedCommand(cmd, {
                    cwd: path.join(__dirname, '..'),
                    env: { ...process.env, ...spawnEnv }
                });
            } catch (error) {
                const detail = execErrorDetail(error);
                console.error(`[ACCOUNTS] Failed to start PM2 process ${workerName}:`, detail);
                db.prepare(`UPDATE accounts SET status = 'error', health_status = 'runtime_start_failed', updated_at = datetime('now', '+8 hours') WHERE id = ?`)
                    .run(platform === 'whatsapp' ? 'wa-' + trimmedId : 'tg-' + trimmedId);
                return res.status(500).json({ success: false, error: `PM2 启动失败: ${detail}` });
            }

            console.log(`[ACCOUNTS] Successfully started PM2 process ${workerName}`);
            try {
                await execManagedCommand('npx pm2 save');
                console.log('[ACCOUNTS] PM2 save succeeded');
            } catch (saveErr) {
                console.error('[ACCOUNTS] PM2 save failed:', saveErr);
            }
            res.json({ success: true, message: 'Account creation started' });
        } catch (err) {
            console.error('Create Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    }));

    return router;
}

module.exports = createAccountsRouter;
