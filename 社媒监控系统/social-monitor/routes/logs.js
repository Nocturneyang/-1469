const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const router = express.Router();

function runPm2Jlist() {
    return new Promise((resolve, reject) => {
        execFile('pm2', ['jlist'], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
            if (err) return reject(err);
            try {
                resolve(JSON.parse(stdout || '[]'));
            } catch (parseErr) {
                reject(parseErr);
            }
        });
    });
}

function normalizeProcess(item) {
    const env = item.pm2_env || {};
    return {
        id: item.pm_id,
        name: item.name,
        status: env.status || '',
        uptime: env.pm_uptime || null,
        restartCount: env.restart_time || 0,
        memory: item.monit?.memory || 0,
        cpu: item.monit?.cpu || 0,
        outLog: env.pm_out_log_path || '',
        errorLog: env.pm_err_log_path || '',
    };
}

function tailFile(filePath, maxLines) {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    const maxBytes = 1024 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-maxLines);
    } finally {
        fs.closeSync(fd);
    }
}

router.get('/logs/processes', async (req, res) => {
    try {
        const list = await runPm2Jlist();
        const data = list.map(normalizeProcess).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/logs/:name', async (req, res) => {
    try {
        const type = req.query.type === 'error' ? 'error' : 'out';
        const lines = Math.min(1000, Math.max(20, parseInt(req.query.lines, 10) || 200));
        const keyword = String(req.query.keyword || '').trim().toLowerCase();
        const list = await runPm2Jlist();
        const processes = list.map(normalizeProcess);
        const proc = processes.find((p) => p.name === req.params.name || String(p.id) === req.params.name);
        if (!proc) return res.status(404).json({ success: false, error: '进程不存在' });
        const filePath = type === 'error' ? proc.errorLog : proc.outLog;
        const allowedPaths = new Set(processes.flatMap((p) => [p.outLog, p.errorLog]).filter(Boolean).map((p) => path.resolve(p)));
        const resolved = path.resolve(filePath || '');
        if (!allowedPaths.has(resolved)) return res.status(403).json({ success: false, error: '日志路径不允许访问' });
        let content = tailFile(resolved, lines);
        if (keyword) content = content.filter((line) => line.toLowerCase().includes(keyword));
        res.json({ success: true, data: { process: proc, type, lines: content, filePath: resolved } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
