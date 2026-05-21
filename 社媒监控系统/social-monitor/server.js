const express = require('express');
const cors = require('cors');
const path = require('path');
const { db } = require('./db/database');
const fs = require('fs');
const { authenticateToken, requireAdmin } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const dataRoutes = require('./routes/data');
const createAccountsRouter = require('./routes/accounts');
const configRoutes = require('./routes/config');
const analyticsRoutes = require('./routes/analytics');
const createTgUserRouter = require('./routes/tg-user');
const createTeamsRouter = require('./routes/teams');
const { getAnalyticsDb } = require('./routes/analytics');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── 登录接口 (Auth Routes) ──────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use('/api/auth', authRoutes);

// ─── 统一 API 鉴权 ────────────────────────────────────────────────
// 所有 /api 请求（除 /api/auth 已在上面处理）都需要 JWT 认证
app.use('/api', authenticateToken);

// ─── 路由挂载（按权限分层）─────────────────────────────────────────
// 普通用户可访问的只读接口
app.use('/api', dataRoutes);

// Serve static UI files
const publicDir = path.join(__dirname, 'frontend/dist');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}
app.use(express.static(publicDir));

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
// 普通用户可访问的分析接口
app.use('/api', analyticsRoutes);

// 以下接口需要 admin 权限
app.use('/api/accounts', requireAdmin, createAccountsRouter({ safeWriteEcosystem }));
app.use('/api', requireAdmin, configRoutes);
app.use('/api/tg-user', requireAdmin, createTgUserRouter({ safeWriteEcosystem }));
app.use('/api/accounts/create-tg-user', requireAdmin, (req, res, next) => {
    req.url = '/create';
    createTgUserRouter({ safeWriteEcosystem })(req, res, next);
});
app.use('/api/teams', requireAdmin, createTeamsRouter({ safeWriteEcosystem }));
app.use('/api/accounts/create-teams', requireAdmin, (req, res, next) => {
    req.url = '/create';
    createTeamsRouter({ safeWriteEcosystem })(req, res, next);
});

app.listen(PORT, () => {
    console.log(`🌐 Social Monitor UI Server listening on http://localhost:${PORT}`);
});

// ─── 全局错误处理 ──────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[server] Unhandled route error:', err.message, err.stack);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException:', err.message, err.stack);
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

