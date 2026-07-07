const express = require('express');
const { isSsoEnabled, signToken } = require('../middleware/auth');
const { verifyLocalUser } = require('../db/auth-db');

function createAuthRouter({ authDb, authenticateToken } = {}) {
  if (!authDb) throw new Error('authDb is required');
  const router = express.Router();

  router.post('/login', (req, res) => {
    if (process.env.NODE_ENV === 'production' && isSsoEnabled()) {
      return res.status(410).json({ success: false, error: '生产环境统一使用 SSO 登录' });
    }

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) {
      return res.status(400).json({ success: false, error: '请输入用户名和密码' });
    }

    const user = verifyLocalUser(authDb, username, password);
    auditLogin(authDb, req, username, 'local', Boolean(user), user ? '' : 'invalid_credentials');
    if (!user) {
      return res.status(401).json({ success: false, error: '用户名或密码不正确' });
    }

    const token = signToken(user);
    res.json({ success: true, token, user });
  });

  router.get('/me', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user, source: req.authSource });
  });

  return router;
}

function auditLogin(db, req, username, source, ok, reason) {
  try {
    db.prepare(`
      INSERT INTO login_audit (username, auth_source, ok, reason, ip)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, source, ok ? 1 : 0, reason || '', req.ip || req.socket?.remoteAddress || '');
  } catch (_) { }
}

module.exports = createAuthRouter;
