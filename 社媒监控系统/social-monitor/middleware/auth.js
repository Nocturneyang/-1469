const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'social-monitor-fallback-secret';

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ success: false, error: 'Unauthorized (Token missing)' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, error: 'Forbidden (Token invalid or expired)' });
        req.user = user;
        next();
    });
}

function requireAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ success: false, error: 'Forbidden (Admin access required)' });
    }
}

module.exports = {
    JWT_SECRET,
    authenticateToken,
    requireAdmin
};
