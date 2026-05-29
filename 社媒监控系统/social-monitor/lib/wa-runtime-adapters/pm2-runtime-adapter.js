const { execFile } = require('child_process');

class Pm2RuntimeAdapter {
    constructor({ dataDir, logger = console } = {}) {
        this.name = 'pm2';
        this.dataDir = dataDir || process.cwd();
        this.logger = logger;
    }

    workerName(accountName) {
        return `worker-wa-${accountName}`;
    }

    listCollectors() {
        return new Promise((resolve) => {
            execFile('npx', ['pm2', 'jlist'], {
                cwd: this.dataDir,
                timeout: 10000,
                maxBuffer: 8 * 1024 * 1024
            }, (err, stdout) => {
                if (err) {
                    this.logger.error('[WA RuntimeAdapter:pm2] Failed to collect PM2 status:', err.message);
                    return resolve(new Map());
                }

                try {
                    const list = JSON.parse(stdout);
                    const map = new Map();
                    for (const item of list) {
                        if (!item.name || !item.name.startsWith('worker-wa-')) continue;
                        const accountName = item.name.replace('worker-wa-', '');
                        const pm2 = item.pm2_env || {};
                        const uptimeMs = pm2.pm_uptime ? Date.now() - pm2.pm_uptime : 0;
                        map.set(accountName, {
                            runtime: this.name,
                            name: item.name,
                            status: pm2.status || 'unknown',
                            mode: pm2.exec_mode || 'unknown',
                            pid: item.pid || 0,
                            restartCount: pm2.restart_time || 0,
                            uptimeSeconds: Math.max(0, Math.round(uptimeMs / 1000))
                        });
                    }
                    resolve(map);
                } catch (parseErr) {
                    this.logger.error('[WA RuntimeAdapter:pm2] Failed to parse PM2 status:', parseErr.message);
                    resolve(new Map());
                }
            });
        });
    }

    restartCollector(accountName) {
        const workerName = this.workerName(accountName);
        return this.runPm2(['restart', workerName, '--update-env']);
    }

    startCollector(accountName) {
        const workerName = this.workerName(accountName);
        return this.runPm2(['start', 'ecosystem.config.js', '--only', workerName, '--env', 'production']);
    }

    runPm2(args) {
        return new Promise((resolve, reject) => {
            execFile('npx', ['pm2', ...args], {
                cwd: this.dataDir,
                timeout: 30000,
                maxBuffer: 2 * 1024 * 1024
            }, (err, stdout, stderr) => {
                if (err) {
                    err.stdout = stdout;
                    err.stderr = stderr;
                    return reject(err);
                }
                resolve(stdout);
            });
        });
    }
}

module.exports = {
    Pm2RuntimeAdapter
};
