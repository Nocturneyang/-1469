const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { db } = require('../db/database');
const {
    getPuppeteerChromeInfo,
    getWaChromeStats,
    getWaWebVersionCacheInfo
} = require('../lib/wa-chrome-runtime');
const { writeEnvKeys } = require('../lib/env-config');
const puppeteer = require('puppeteer');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const WA_ACCOUNTS_CONFIG_PATH = path.join(DATA_DIR, 'config', 'wa-accounts.json');

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
    const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T') + 'Z';
    const ts = new Date(normalized).getTime();
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

function killWaChromeProcesses(accountName, callback = () => {}) {
    const patterns = [
        `whatsapp-session-${accountName}`,
        `.wwebjs_auth/session-${accountName}`
    ];
    const cmd = patterns
        .map(pattern => `pgrep -f "${pattern}" 2>/dev/null`)
        .join(' ; ');
    exec(`(${cmd}) | sort -u | xargs kill -9 2>/dev/null || true`, { shell: '/bin/bash' }, callback);
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
    return {
        name: `worker-wa-${accountName}`,
        script: './workers/worker-wa.js',
        max_memory_restart: '4G',
        cron_restart: '0 4 * * *',
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        watch: false,
        kill_timeout: 15000,
        restart_delay: 30000,
        max_restarts: 5,
        min_uptime: '2m',
        env: {
            NODE_ENV: 'production',
            ACCOUNT_NAME: accountName,
            WA_ORCHESTRATOR_MANAGED_INIT: 'true',
            WA_INIT_COOLDOWN_MS: '30000',
            WA_INIT_QUARANTINE_AFTER: '10',
            WA_INIT_QUARANTINE_MS: '60000',
            WA_INIT_HARD_TIMEOUT_MS: '360000',
            WA_AUTH_TIMEOUT_MS: '300000',
            WA_PROTOCOL_TIMEOUT_MS: '600000',
            WA_QR_IDLE_TIMEOUT_MS: '180000',
            PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            PUPPETEER_SKIP_DOWNLOAD: 'true'
        }
    };
}

function buildTgBotAppConfig(accountName, token) {
    return {
        name: `worker-tg-${accountName}`,
        script: './workers/worker-tg.js',
        instances: 1,
        autorestart: true,
        watch: false,
        env: {
            NODE_ENV: 'production',
            TG_ACCOUNT_NAME: accountName,
            TG_BOT_TOKEN: token
        }
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

function createAccountsRouter({ safeWriteEcosystem }) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        try {
            const accounts = db.prepare(`SELECT * FROM accounts ORDER BY updated_at DESC`).all();
            const waChromeStats = await collectWaChromeStats();
            const waChromeById = new Map((waChromeStats.accounts || []).map(item => [item.accountId, item]));
            const heartbeats = db.prepare(`
                SELECT *
                FROM collector_heartbeats
                ORDER BY datetime(updated_at) DESC
            `).all();
            const heartbeatByAccount = new Map();
            for (const row of heartbeats) {
                if (!heartbeatByAccount.has(row.account_id)) heartbeatByAccount.set(row.account_id, row);
            }
            
            // Add running status assessment for each account
            accounts.forEach(acc => {
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
                        const now = new Date();
                        const formattedStr = acc.latest_msg_time.replace(' ', 'T') + 'Z';
                        const lastMsgDate = new Date(formattedStr);
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

    router.post('/logout', (req, res) => {
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, error: 'Missing account id' });
        if (!/^(wa|tg|tgu)-[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ success: false, error: 'Invalid account id format' });
        
        try {
            if (id.startsWith('wa-')) {
                const accName = id.replace('wa-', '');
                db.prepare(`UPDATE accounts SET status = 'disconnected', qr_code = NULL WHERE id = ?`).run(id);
                const sessionPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `whatsapp-session-${accName}`);
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
                
                exec(`pm2 restart worker-wa-${accName}`, (error) => {
                    if(error) console.log('Notice: Could not restart PM2 via API.', error.message);
                });
            }
            res.json({ success: true, message: 'Logged out. Account is resetting.' });
        } catch (err) {
            console.error('Logout Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/restart', (req, res) => {
        const { id } = req.body;
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

            db.prepare(`UPDATE accounts SET status = 'initializing', qr_code = NULL WHERE id = ?`).run(id);

            if (id.startsWith('wa-')) {
                const LOCK_FILE = '/tmp/wa_chrome_init.lock';
                killWaChromeProcesses(accName);

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

            setTimeout(() => {
                exec(`pm2 restart ${workerName}`, (error) => {
                    if (error) console.log(`Notice: Could not restart PM2 ${workerName}.`, error.message);
                });
            }, 500);

            res.json({ success: true, message: 'Restart command sent. Login session was preserved.' });
        } catch (err) {
            console.error('Restart Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/relogin', (req, res) => {
        const { id } = req.body;
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
                accName = id.replace('teams-', '')
                workerName = `worker-teams-${accName}`;
            } else {
                return res.status(400).json({ success: false, error: 'Invalid account id prefix' });
            }

            db.prepare(`UPDATE accounts SET status = 'initializing', qr_code = NULL WHERE id = ?`).run(id);

            const restartWorker = () => {
                setTimeout(() => {
                    exec(`pm2 restart ${workerName}`, (error) => {
                        if (error) console.log(`Notice: Could not restart PM2 ${workerName}.`, error.message);
                    });
                }, 500);
            };

            // ── WA 账号额外清理：杀 Chrome、释放锁、清 Session Auth ────────
            if (id.startsWith('wa-')) {
                // 1. 杀掉该账号所有 Chrome 进程，杀完后再删除 session，避免残留文件句柄污染新 profile。
                killWaChromeProcesses(accName, () => {
                        // 2. 人工重新登录必须绕过自动保护冷却，否则会一直等旧 cooldown，不出二维码。
                        clearWaInitGuards(accName, 'relogin');

                        // 3. 完整清除 LocalAuth profile，确保下次启动生成全新 QR。
                        clearWaSession(accName);
                        console.log(`[RELOGIN] ${accName} Session 已完整清除，准备重启`);
                        restartWorker();
                    });
            } else {
                restartWorker();
            }
            
            res.json({ success: true, message: 'Restart command sent. QR code will appear shortly.' });
        } catch (err) {
            console.error('Relogin Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.delete('/:id', (req, res) => {
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

            exec(`npx pm2 delete ${workerName}`, (error) => {
                if (error) console.log(`Notice: Could not delete PM2 process ${workerName} (may already be stopped).`);
                exec('npx pm2 save', (err) => {
                    if (err) console.error('[DELETE ACCOUNT] PM2 save failed:', err);
                    else console.log('[DELETE ACCOUNT] PM2 save succeeded');
                });
            });

            res.json({ success: true, message: 'Account permanently deleted.' });
        } catch (err) {
            console.error('[DELETE ACCOUNT] Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/create', (req, res) => {
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

        try {
            let workerName, scriptPath;
            if (platform === 'whatsapp') {
                workerName = `worker-wa-${trimmedId}`;
                scriptPath = './workers/worker-wa.js';
                db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status) VALUES (?, 'whatsapp', 'initializing')`).run('wa-' + trimmedId);
                ensureWaAccountManaged(trimmedId);
            } else {
                workerName = `worker-tg-${trimmedId}`;
                scriptPath = './workers/worker-tg.js';
                db.prepare(`INSERT OR REPLACE INTO accounts (id, platform, status) VALUES (?, 'telegram', 'initializing')`).run('tg-' + trimmedId);
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

            exec(cmd, { 
                cwd: path.join(__dirname, '..'),
                env: { ...process.env, ...spawnEnv }
            }, (error) => {
                if (error) {
                    const detail = [error.message, error.stderr, error.stdout].filter(Boolean).join('\n').slice(0, 1200);
                    console.error(`[ACCOUNTS] Failed to start PM2 process ${workerName}:`, detail);
                    db.prepare(`UPDATE accounts SET status = 'error', health_status = 'runtime_start_failed', updated_at = datetime('now') WHERE id = ?`)
                        .run(platform === 'whatsapp' ? 'wa-' + trimmedId : 'tg-' + trimmedId);
                    return res.status(500).json({ success: false, error: `PM2 启动失败: ${detail}` });
                }
                console.log(`[ACCOUNTS] Successfully started PM2 process ${workerName}`);
                exec('npx pm2 save');
                res.json({ success: true, message: 'Account creation started' });
            });
        } catch (err) {
            console.error('Create Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
}

module.exports = createAccountsRouter;
