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
            accounts: []
        };
    }

    return JSON.parse(fs.readFileSync(WA_ACCOUNTS_CONFIG_PATH, 'utf8'));
}

function writeWaAccountsConfig(config) {
    fs.mkdirSync(path.dirname(WA_ACCOUNTS_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(WA_ACCOUNTS_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function ensureWaAccountManaged(accountName) {
    const config = readWaAccountsConfig();
    config.accounts = Array.isArray(config.accounts) ? config.accounts : [];

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
                if (acc.runtime_status === 'stale_online') {
                    acc.health_assessment = acc.chrome_process_count > 0 ? '心跳过期，待恢复' : '假在线：无 Chrome 进程';
                    acc.health_color = '#DD6B20';
                } else if (['queued', 'cooling_down', 'starting'].includes(acc.runtime_status)) {
                    acc.health_assessment = acc.runtime_status === 'queued' ? '排队等待启动' : (acc.runtime_status === 'cooling_down' ? '初始化冷却中' : '启动初始化中');
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
                    acc.health_assessment = m[acc.runtime_status] || '运行异常';
                    acc.health_color = '#DD6B20';
                } else if (['auth_failure', 'init_timeout', 'init_failed', 'no_browser_timeout'].includes(acc.runtime_status)) {
                    acc.health_assessment = '初始化失败，等待保护恢复';
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
                exec(`pgrep -f "whatsapp-session-${accName}" 2>/dev/null | xargs kill -9 2>/dev/null || true`,
                    { shell: '/bin/bash' }, () => {});

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

            // ── WA 账号额外清理：杀 Chrome、释放锁、清 Session Auth ────────
            if (id.startsWith('wa-')) {
                // 1. 杀掉该账号所有 Chrome 进程
                exec(`pgrep -f "whatsapp-session-${accName}" 2>/dev/null | xargs kill -9 2>/dev/null || true`,
                    { shell: '/bin/bash' }, () => {});

                // 2. 人工重新登录必须绕过自动保护冷却，否则会一直等旧 cooldown，不出二维码。
                clearWaInitGuards(accName, 'relogin');

                // 3. 清除 Session 认证数据（让 Chrome 生成全新 QR）
                const sessionBase = path.join(
                    process.env.DATA_DIR || path.join(__dirname, '..'),
                    `whatsapp-session-${accName}`, 'session', 'Default'
                );
                const authDirs = ['IndexedDB', 'Local Storage', 'Session Storage'];
                const authFiles = ['Cookies', 'Cookies-journal'];
                authDirs.forEach(d => {
                    const p = path.join(sessionBase, d);
                    if (fs.existsSync(p)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
                });
                authFiles.forEach(f => {
                    const p = path.join(sessionBase, f);
                    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) {} }
                });
                console.log(`[RELOGIN] ${accName} Session 认证数据已清除`);
            }

            // 等 500ms 让 Chrome 进程完全退出再重启 worker
            setTimeout(() => {
                exec(`pm2 restart ${workerName}`, (error) => {
                    if (error) console.log(`Notice: Could not restart PM2 ${workerName}.`, error.message);
                });
            }, 500);
            
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

            if (id.startsWith('wa-')) {
                const sessionPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), `whatsapp-session-${accName}`);
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
                removeWaAccountManaged(accName);
            }

            const ecoPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'ecosystem.config.js');
            if (fs.existsSync(ecoPath)) {
                let eco = fs.readFileSync(ecoPath, 'utf8');
                // 匹配整个配置块（包括可能的逗号），使用更精确的正则
                const regex = new RegExp(`\\s*\\{\\s*name:\\s*["']${workerName}["'][\\s\\S]*?\\}(\\s*,)?\\s*`, 'g');
                console.log(`[DELETE ACCOUNT] Before replace, eco length: ${eco.length}`);
                eco = eco.replace(regex, '');
                console.log(`[DELETE ACCOUNT] After replace, eco length: ${eco.length}`);
                safeWriteEcosystem(eco);
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
            if (fs.existsSync(ecoPath)) {
                let eco = fs.readFileSync(ecoPath, 'utf8');
                let insertStr = '';
                if (platform === 'whatsapp') {
                    insertStr = `    {
      name: "${workerName}",
      script: "${scriptPath}",
      max_memory_restart: '1G',
      cron_restart: '0 4 * * *',
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      kill_timeout: 15000,
      restart_delay: 30000,
      max_restarts: 5,
      min_uptime: "2m",
      env: { NODE_ENV: "production", ACCOUNT_NAME: "${trimmedId}" }
    },\n    // --- Web UI Server ---`;
                } else {
                    insertStr = `    {
      name: "${workerName}",
      script: "${scriptPath}",
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production", TG_ACCOUNT_NAME: "${trimmedId}", TG_BOT_TOKEN: "${token}" }
    },\n    // --- Web UI Server ---`;
                }
                if (eco.includes('// --- Web UI Server ---') && !eco.includes(workerName)) {
                    eco = eco.replace('// --- Web UI Server ---', insertStr);
                    safeWriteEcosystem(eco);
                }
            }

            const cmd = platform === 'whatsapp'
                ? `pm2 start ${scriptPath} --name "${workerName}" --max-memory-restart 1G --cron-restart "0 4 * * *" --restart-delay 30000 --max-restarts 5 --min-uptime 2m`
                : `pm2 start ${scriptPath} --name "${workerName}"`;
            
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
                    console.error(`[ACCOUNTS] Failed to start PM2 process ${workerName}:`, error.message);
                } else {
                    console.log(`[ACCOUNTS] Successfully started PM2 process ${workerName}`);
                    exec('pm2 save');
                }
            });

            res.json({ success: true, message: 'Account creation started' });
        } catch (err) {
            console.error('Create Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
}

module.exports = createAccountsRouter;
