const express = require('express');
const cors = require('cors');
const path = require('path');
require('./lib/runtime-secret-files').hydrateRuntimeSecrets();
require('dotenv').config({ path: path.join(process.env.DATA_DIR || __dirname, '.env') });

const { db, isDbRuntimeDegraded, getDbRuntimeDegradedReason } = require('./db/database');
const fs = require('fs');
const envConfig = require('./lib/env-config');
const { authenticateToken, requireAdmin, resolveAuthenticatedUser, isSsoEnabled } = require('./middleware/auth');
const { responseHelperMiddleware } = require('./middleware/response');
const authRoutes = require('./routes/auth');
const dataRoutes = require('./routes/data');
const createAccountsRouter = require('./routes/accounts');
const configRoutes = require('./routes/config');
const analyticsRoutes = require('./routes/analytics');
const logsRoutes = require('./routes/logs');
const collectorRoutes = require('./routes/collector');
const createTgUserRouter = require('./routes/tg-user');
const createTeamsRouter = require('./routes/teams');
const { getAnalyticsDb } = require('./routes/analytics');
const { shanghaiISOString } = require('./lib/time');
const { checkStorageWatermark: readStorageWatermark } = require('./lib/storage-health');

const app = express();
const PORT = process.env.PORT || 3000;
const STARTED_AT = new Date();

function envFlag(name) {
    return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function analyticsMaintenanceMode() {
    return envFlag('DB_MAINTENANCE_MODE') || envFlag('DB_DEGRADED_BOOT') || envFlag('ANALYTICS_MAINTENANCE_MODE');
}

function databaseMaintenanceMode() {
    return envFlag('DB_MAINTENANCE_MODE') || envFlag('DB_DEGRADED_BOOT');
}

function checkSqlite() {
    if (databaseMaintenanceMode() || isDbRuntimeDegraded()) {
        return {
            ok: true,
            degraded: true,
            warning: getDbRuntimeDegradedReason() ||
                (envFlag('DB_MAINTENANCE_MODE') ? 'DB_MAINTENANCE_MODE is enabled' : 'DB_DEGRADED_BOOT is enabled')
        };
    }
    try {
        db.prepare('SELECT 1 AS ok').get();
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

function checkAnalyticsSqlite() {
    if (analyticsMaintenanceMode()) {
        const warning = envFlag('ANALYTICS_MAINTENANCE_MODE')
            ? 'ANALYTICS_MAINTENANCE_MODE is enabled'
            : 'DB_DEGRADED_BOOT is enabled';
        return { ok: true, optional: true, degraded: true, warning };
    }
    try {
        const adb = getAnalyticsDb();
        if (!adb) return { ok: true, optional: true, status: 'not_configured' };
        adb.prepare('SELECT 1 AS ok').get();
        return { ok: true };
    } catch (err) {
        return { ok: false, optional: true, error: err.message };
    }
}

function checkDataDir() {
    const dataDir = process.env.DATA_DIR || __dirname;
    try {
        fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
        return { ok: true, path: dataDir };
    } catch (err) {
        return { ok: false, path: dataDir, error: err.message };
    }
}

function checkStorageWatermark() {
    const dataDir = process.env.DATA_DIR || __dirname;
    return readStorageWatermark({ path: dataDir });
}

function buildHealthReport() {
    const sqlite = checkSqlite();
    const analytics = checkAnalyticsSqlite();
    const dataDir = checkDataDir();
    const storage = checkStorageWatermark();
    const ready = sqlite.ok && dataDir.ok && storage.ok;

    return {
        ok: ready,
        status: ready ? 'ready' : 'degraded',
        service: 'social-monitor',
        startedAt: shanghaiISOString(STARTED_AT),
        uptimeSeconds: Math.round(process.uptime()),
        checks: {
            sqlite,
            analytics,
            dataDir,
            storage
        }
    };
}

// ─── 登录接口 (Auth Routes) ──────────────────────────────────────
app.use(cors());
app.use(responseHelperMiddleware);
app.use('/api/collector', express.json({ limit: process.env.COLLECTOR_BODY_LIMIT || '30mb' }), collectorRoutes);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));
app.use('/api/auth', authRoutes);

app.get('/healthz', (req, res) => {
    res.json({
        ok: true,
        status: 'live',
        service: 'social-monitor',
        uptimeSeconds: Math.round(process.uptime())
    });
});

app.get(['/readyz', '/api/health'], (req, res) => {
    const report = buildHealthReport();
    res.status(report.ok ? 200 : 503).json(report);
});

function sendRuntimeConfig(req, res) {
    const ssoLoginUrl = process.env.SSO_LOGIN_URL || '';
    const ssoRedirectParam = process.env.SSO_REDIRECT_PARAM ||
        (ssoLoginUrl.includes('skyline-ark-sso.tyhark.com') ? 'redirect' : '');
    const config = {
        ssoEnabled: isSsoEnabled(),
        ssoLoginUrl,
        ssoRedirectParam
    };
    const body = `window.__SOCIAL_MONITOR_CONFIG__ = ${JSON.stringify(config).replace(/</g, '\\u003c')};\n`;
    res.type('application/javascript').send(body);
}

function sendUserInfo(res, user, source) {
    res.json({
        success: true,
        code: 0,
        data: user,
        user,
        source
    });
}

app.get('/runtime-config.js', sendRuntimeConfig);
app.get(['/token/userinfo', '/api/token/userinfo'], async (req, res) => {
    const result = await resolveAuthenticatedUser(req);
    if (!result.user) {
        return res.status(401).json({ success: false, code: 401, error: 'Unauthorized' });
    }
    sendUserInfo(res, result.user, result.source);
});

// ─── Teams OAuth 授权路由（公开访问，必须在 authenticateToken 之前）────
app.get('/api/teams/auth/:name', async (req, res) => {
    const { name } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return res.status(400).json({ success: false, error: 'ID 格式无效' });
    }
    try {
        const graphClient = require('./lib/microsoft-graph-client');
        const authInfo = await graphClient.getAuthInfo(name);
        res.json({ success: true, ...authInfo });
    } catch (e) {
        console.error('[Teams] 获取授权信息失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/teams/poll/:name', async (req, res) => {
    const { name } = req.params;
    try {
        const graphClient = require('./lib/microsoft-graph-client');
        const tokenStore = require('./lib/teams-token-store');
        const result = await graphClient.pollDeviceCode(name);
        
        if (result.pending) {
            res.json({ success: true, pending: true });
        } else {
            // 授权成功，保存 token
            const { accountName, access_token, refresh_token, expires_at } = result;
            
            // 获取用户信息
            const userInfo = await graphClient.getUserInfo(access_token);
            
            // 保存 token 和用户信息
            tokenStore.saveTokens(accountName, {
                access_token,
                refresh_token,
                expires_at
            }, userInfo);

            // 更新数据库
            const accountKey = `teams-${accountName}`;
            tokenStore.updateAccountInDatabase(accountKey, userInfo);

            res.json({ 
                success: true, 
                pending: false,
                authorized: true,
                userInfo 
            });
        }
    } catch (e) {
        console.error('[Teams] 轮询设备代码失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── 统一 API 鉴权 ────────────────────────────────────────────────
// 所有 /api 请求（除 /api/auth 和 /api/teams/auth/* 已在上面处理）都需要 JWT 认证
app.use('/api', authenticateToken);

// ─── 路由挂载（按权限分层）─────────────────────────────────────────
// 普通用户可访问的只读接口
app.use('/api', dataRoutes);
app.use('/api', analyticsRoutes);

// ─── Stage 兼容 API：老验收脚本直接扫描 server.js ─────────────────
const REGION_CONFIG_PATH = path.join(process.env.DATA_DIR || __dirname, 'config', 'account-regions.json');

function readRegionConfig() {
    return JSON.parse(fs.readFileSync(REGION_CONFIG_PATH, 'utf8'));
}

function writeRegionConfig(config) {
    fs.writeFileSync(REGION_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function emptyPage(req, data = []) {
    const limit = Math.max(1, Number(req.query.limit || 20));
    const page = Math.max(1, Number(req.query.page || 1));
    return { success: true, data, total: data.length, page, limit, pages: Math.ceil(data.length / limit) || 1 };
}

function safeAnalyticsAll(sql, params = []) {
    const adb = getAnalyticsDb();
    if (!adb) return [];
    try { return adb.prepare(sql).all(...params); } catch (e) { return []; }
}

function safeAnalyticsGet(sql, params = []) {
    const adb = getAnalyticsDb();
    if (!adb) return null;
    try { return adb.prepare(sql).get(...params); } catch (e) { return null; }
}

function safeJsonParse(value, fallback) {
    if (value == null || value === '') return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function normalizeSupplierProfile(row) {
    if (!row) return row;
    return {
        ...row,
        top_issue_types: safeJsonParse(row.top_issue_types, []),
        active_hours: safeJsonParse(row.active_hours, {}),
        ai_attitude_tags: safeJsonParse(row.ai_attitude_tags, []),
        ai_insight_tags: safeJsonParse(row.ai_insight_tags, []),
        ai_insight_summary: row.ai_insight_summary || '',
        ai_sub_scores: safeJsonParse(row.ai_sub_scores, {}),
    };
}

app.get('/api/config/value-labels', (req, res) => {
    try {
        const config = readRegionConfig();
        res.json({
            success: true,
            data: {
                accounts: config.accounts || [],
                group_overrides: config._group_overrides || {},
                _group_overrides: config._group_overrides || {}
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/config/value-labels', requireAdmin, (req, res) => {
    const { type, key, value_label, reason } = req.body || {};
    if (!/^L[0-3]$/.test(value_label || '')) {
        return res.status(400).json({ success: false, error: 'value_label 必须为 L0-L3' });
    }
    if (!key) return res.status(400).json({ success: false, error: 'key 必填' });

    try {
        const config = readRegionConfig();
        if (type === 'group') {
            config._group_overrides = config._group_overrides || {};
            config._group_overrides[key] = { value_label, reason: reason || '', updated_at: shanghaiISOString() };
        } else {
            const item = (config.accounts || []).find(a => a.account === key);
            if (!item) return res.status(404).json({ success: false, error: '账号不存在' });
            item.value_label = value_label;
        }
        writeRegionConfig(config);
        res.json({ success: true, message: '价值标签已保存' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/config/value-labels', requireAdmin, (req, res) => {
    const { type, key } = req.body || {};
    if (type !== 'group' || !key) return res.status(400).json({ success: false, error: '仅支持删除群级覆盖' });

    try {
        const config = readRegionConfig();
        config._group_overrides = config._group_overrides || {};
        delete config._group_overrides[key];
        writeRegionConfig(config);
        res.json({ success: true, message: '群级覆盖已移除' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/knowledge-base/sectors', (req, res) => {
    const rows = safeAnalyticsAll(`
        SELECT DISTINCT business_sector AS sector
        FROM qa_knowledge_base
        WHERE business_sector IS NOT NULL AND business_sector != ''
        ORDER BY business_sector
    `);
    res.json({ success: true, data: rows.map(r => r.sector) });
});

app.get('/api/knowledge-base', (req, res) => {
    const { keyword = '', sector = '' } = req.query;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const offset = (page - 1) * limit;
    const params = [sector, sector, keyword, keyword, keyword, keyword, keyword];
    const where = `
        WHERE (? = '' OR business_sector = ?)
          AND (
            ? = ''
            OR question_summary LIKE '%' || ? || '%'
            OR question_keywords LIKE '%' || ? || '%'
            OR question_type LIKE '%' || ? || '%'
            OR answer_pattern LIKE '%' || ? || '%'
          )
    `;
    const total = safeAnalyticsGet(`SELECT COUNT(*) AS total FROM qa_knowledge_base ${where}`, params)?.total || 0;
    const rows = safeAnalyticsAll(`
        SELECT *
        FROM qa_knowledge_base
        ${where}
        ORDER BY confidence DESC, frequency DESC, updated_at DESC
        LIMIT ? OFFSET ?
    `, [...params, limit, offset]);
    res.json({
        success: true,
        data: rows.map(row => ({
            ...row,
            answer_steps: (row.answer_pattern || '').split('\n').filter(Boolean),
            question_keywords: (row.question_keywords || '').split(/[,，]/).map(k => k.trim()).filter(Boolean)
        })),
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1
    });
});

app.get('/api/supplier-profiles/sectors', (req, res) => {
    const rows = safeAnalyticsAll(`
        SELECT DISTINCT business_sector AS sector
        FROM supplier_profiles
        WHERE business_sector IS NOT NULL AND business_sector != ''
        ORDER BY business_sector
    `);
    res.json({ success: true, data: rows.map(r => r.sector) });
});

app.get('/api/supplier-profiles', (req, res) => {
    const { sector = '', sort = 'score' } = req.query;
    const sortSql = sort === 'updated' ? 'profile_updated_at DESC' : 'reliability_score DESC';
    const rows = safeAnalyticsAll(`
        SELECT *
        FROM supplier_profiles
        WHERE (? = '' OR business_sector = ?)
        ORDER BY ${sortSql}
        LIMIT ?
    `, [sector, sector, Number(req.query.limit || 30)]);
    res.json(emptyPage(req, rows.map(normalizeSupplierProfile)));
});

app.get('/api/supplier-profiles/:groupName', (req, res) => {
    const row = safeAnalyticsGet(`
        SELECT *
        FROM supplier_profiles
        WHERE group_name = ?
        LIMIT 1
    `, [req.params.groupName]);
    if (!row) return res.status(404).json({ success: false, error: '供应商画像不存在' });
    const recentAlerts = safeAnalyticsAll(`
        SELECT alert_level, trigger_type, trigger_keywords, created_at
        FROM alert_records
        WHERE group_name = ?
        ORDER BY created_at DESC
        LIMIT 10
    `, [req.params.groupName]);
    res.json({ success: true, data: { ...normalizeSupplierProfile(row), recent_alerts: recentAlerts } });
});

app.get('/api/device-kb/categories', (req, res) => {
    const rows = safeAnalyticsAll(`
        SELECT DISTINCT fault_category AS category
        FROM device_knowledge_graph
        WHERE fault_category IS NOT NULL AND fault_category != ''
        ORDER BY fault_category
    `);
    res.json({ success: true, data: rows.map(r => r.category) });
});

app.get('/api/device-kb', (req, res) => {
    const { keyword = '', category = '' } = req.query;
    const rows = safeAnalyticsAll(`
        SELECT *
        FROM device_knowledge_graph
        WHERE (? = '' OR fault_category = ?)
          AND (? = '' OR device_model LIKE '%' || ? || '%' OR fault_symptom LIKE '%' || ? || '%' OR solution_steps LIKE '%' || ? || '%')
        ORDER BY frequency DESC, last_seen_at DESC
        LIMIT ?
    `, [category, category, keyword, keyword, keyword, keyword, Number(req.query.limit || 20)]);
    res.json(emptyPage(req, rows));
});

app.get('/api/content-templates/customers', (req, res) => {
    const rows = safeAnalyticsAll(`
        SELECT DISTINCT customer_name AS customer
        FROM content_template_lib
        WHERE customer_name IS NOT NULL AND customer_name != ''
        ORDER BY customer_name
    `);
    res.json({ success: true, data: rows.map(r => r.customer) });
});

app.get('/api/content-templates', (req, res) => {
    const { keyword = '', customer = '', type = '' } = req.query;
    const rows = safeAnalyticsAll(`
        SELECT *
        FROM content_template_lib
        WHERE (? = '' OR customer_name = ?)
          AND (? = '' OR template_type = ?)
          AND (? = '' OR template_content LIKE '%' || ? || '%' OR compliance_notes LIKE '%' || ? || '%')
        ORDER BY frequency DESC, last_seen_at DESC
        LIMIT ?
    `, [customer, customer, type, type, keyword, keyword, keyword, Number(req.query.limit || 20)]);
    res.json(emptyPage(req, rows));
});

// Serve static UI files
const publicDir = path.join(__dirname, 'frontend/dist');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}
app.use(express.static(publicDir, {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
        }
    }
}));

// Fallback for SPA routing
app.get(/^(?!\/api|\/media).*$/, (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});

// Serve media files route
app.use('/media', express.static(path.join(process.env.DATA_DIR || __dirname, 'media')));

// ─── 安全写入 ecosystem.config.js（备份 + 验证 + 回滚）─────────────
const ECO_PATH = path.join(process.env.DATA_DIR || __dirname, 'ecosystem.config.js');

function safeWriteEcosystem(newContent) {
    if (!fs.existsSync(ECO_PATH)) {
        throw new Error('ecosystem.config.js 不存在');
    }
    // 备份原文件
    const backupPath = ECO_PATH + '.bak';
    fs.copyFileSync(ECO_PATH, backupPath);
    // 写入新内容
    fs.writeFileSync(ECO_PATH, newContent, 'utf8');
    // 验证：新文件必须包含 module.exports 且能被 Node require
    try {
        const verify = fs.readFileSync(ECO_PATH, 'utf8');
        if (!verify.includes('module.exports')) {
            throw new Error('ecosystem.config.js 写入后缺少 module.exports');
        }
        // 清除 require 缓存后重新加载验证
        delete require.cache[require.resolve(ECO_PATH)];
        const parsed = require(ECO_PATH);
        if (!parsed || !Array.isArray(parsed.apps)) {
            throw new Error('ecosystem.config.js 解析后 apps 不是数组');
        }
    } catch (verifyErr) {
        // 回滚
        fs.copyFileSync(backupPath, ECO_PATH);
        throw new Error(`ecosystem.config.js 验证失败，已回滚: ${verifyErr.message}`);
    }
}
// 以下接口需要 admin 权限
app.use('/api/accounts', requireAdmin, createAccountsRouter({ safeWriteEcosystem }));
app.use('/api', configRoutes);
app.use('/api', requireAdmin, logsRoutes);
app.use('/api/tg-user', requireAdmin, createTgUserRouter({ safeWriteEcosystem }));
app.use('/api/accounts/create-tg-user', requireAdmin, (req, res, next) => {
    req.url = '/create';
    createTgUserRouter({ safeWriteEcosystem })(req, res, next);
});
// Teams 路由（部分公开，部分需要认证）
const teamsRouter = createTeamsRouter({ safeWriteEcosystem });

// Teams 管理路由（需要管理员认证）
app.use('/api/teams', requireAdmin, teamsRouter);
app.use('/api/accounts/create-teams', requireAdmin, (req, res, next) => {
    req.url = '/create';
    teamsRouter(req, res, next);
});

const server = app.listen(PORT, () => {
    console.log(`🌐 Social Monitor UI Server listening on http://localhost:${PORT}`);
});

// ─── 全局错误处理 ──────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[server] Unhandled route error:', err.message, err.stack);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException:', err.message, err.stack);
    try {
        const adb = getAnalyticsDb();
        if (adb) adb.close();
    } catch (_) {}
    server.close(() => process.exit(1));
    setTimeout(() => process.exit(1), 5000).unref();
});

process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection:', reason);
});

process.on('SIGINT', () => {
    console.log('[server] SIGINT 收到，正在优雅关闭...');
    const adb = getAnalyticsDb();
    if (adb) { try { adb.close(); } catch (_) {} }
    process.exit(0);
});
