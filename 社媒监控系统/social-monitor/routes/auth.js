const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('../db/database');
const { JWT_SECRET, authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function normalizeSsoAdminInput(body = {}) {
    const identity = String(body.identity || '').trim();
    const displayName = String(body.display_name || body.displayName || identity).trim();
    const note = String(body.note || '').trim();
    return { identity, displayName, note };
}

router.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: '请输入用户名和密码' });
    }

    try {
        const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
        if (!user) {
            return res.status(401).json({ success: false, error: '用户名或密码不正确' });
        }

        const validPassword = bcrypt.compareSync(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ success: false, error: '用户名或密码不正确' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

        res.json({
            success: true,
            token,
            user: { id: user.id, username: user.username, role: user.role }
        });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ success: false, error: '服务器内部错误' });
    }
});

router.post('/view-login', (req, res) => {
    try {
        const user = db.prepare("SELECT * FROM users WHERE username = ?").get('view');
        if (!user) {
            return res.status(404).json({ success: false, error: '游客用户不存在' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

        res.json({
            success: true,
            token,
            user: { id: user.id, username: user.username, role: user.role }
        });
    } catch (err) {
        console.error('View Login Error:', err);
        res.status(500).json({ success: false, error: '服务器内部错误' });
    }
});

router.get('/me', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

router.get('/users', authenticateToken, requireAdmin, (req, res) => {
    try {
        const users = db.prepare("SELECT id, username, role, created_at, last_login FROM users").all();
        res.json({ success: true, data: users });
    } catch (err) {
        console.error('Get Users Error:', err);
        res.status(500).json({ success: false, error: '服务器内部错误' });
    }
});

router.get('/sso-admins', authenticateToken, requireAdmin, (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT id, identity, display_name, note, created_by, created_at, updated_at
            FROM sso_admins
            ORDER BY updated_at DESC, id DESC
        `).all();
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('Get SSO Admins Error:', err);
        res.status(500).json({ success: false, error: '服务器内部错误' });
    }
});

router.post('/sso-admins', authenticateToken, requireAdmin, (req, res) => {
    const { identity, displayName, note } = normalizeSsoAdminInput(req.body);
    if (!identity) {
        return res.status(400).json({ success: false, error: '请输入钉钉身份标识' });
    }

    try {
        db.prepare(`
            INSERT INTO sso_admins (identity, display_name, note, created_by)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(identity) DO UPDATE SET
                display_name = excluded.display_name,
                note = excluded.note,
                updated_at = datetime('now')
        `).run(identity, displayName || identity, note, req.user?.username || 'admin');
        res.json({ success: true, message: '钉钉管理员已保存' });
    } catch (err) {
        console.error('Save SSO Admin Error:', err);
        res.status(500).json({ success: false, error: '服务器内部错误' });
    }
});

router.delete('/sso-admins/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
        const result = db.prepare('DELETE FROM sso_admins WHERE id = ?').run(req.params.id);
        if (!result.changes) {
            return res.status(404).json({ success: false, error: '记录不存在' });
        }
        res.json({ success: true, message: '钉钉管理员已删除' });
    } catch (err) {
        console.error('Delete SSO Admin Error:', err);
        res.status(500).json({ success: false, error: '服务器内部错误' });
    }
});

router.post('/users', authenticateToken, requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password || !role) {
        return res.status(400).json({ success: false, error: '请输入用户名、密码和角色' });
    }

    try {
        const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
        if (existing) {
            return res.status(400).json({ success: false, error: '用户名已存在' });
        }

        const salt = bcrypt.genSaltSync(10);
        const hash = bcrypt.hashSync(password, salt);

        const result = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run(username, hash, role);

        res.json({ success: true, message: '用户创建成功', userId: result.lastInsertRowid });
    } catch (err) {
        console.error('Create User Error:', err);
        res.status(500).json({ success: false, error: '服务器内部错误' });
    }
});

router.put('/users/:id/password', authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    if (!password) {
        return res.status(400).json({ success: false, error: '请输入新密码' });
    }

    try {
        const salt = bcrypt.genSaltSync(10);
        const hash = bcrypt.hashSync(password, salt);

        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);

        res.json({ success: true, message: '密码修改成功' });
    } catch (err) {
        console.error('Update Password Error:', err);
        res.status(500).json({ success: false, error: '服务器内部错误' });
    }
});

router.put('/users/:id/role', authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    if (!role) {
        return res.status(400).json({ success: false, error: '请输入角色' });
    }

    try {
        db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);

        res.json({ success: true, message: '角色修改成功' });
    } catch (err) {
        console.error('Update Role Error:', err);
        res.status(500).json({ success: false, error: '服务器内部错误' });
    }
});

router.delete('/users/:id', authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;

    try {
        const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
        if (!user) {
            return res.status(404).json({ success: false, error: '用户不存在' });
        }

        if (user.username === 'admin' || user.username === 'view') {
            return res.status(400).json({ success: false, error: '不能删除系统默认用户' });
        }

        db.prepare("DELETE FROM users WHERE id = ?").run(id);

        res.json({ success: true, message: '用户删除成功' });
    } catch (err) {
        console.error('Delete User Error:', err);
        res.status(500).json({ success: false, error: '服务器内部错误' });
    }
});

module.exports = router;
