const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('../db/database');
const { JWT_SECRET, authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

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
