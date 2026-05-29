const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_CHROME_MAJOR = '146';

function getChromeVersionFromExecutablePath(puppeteerInstance) {
    try {
        const executablePath = puppeteerInstance.executablePath();
        const match = executablePath.match(/(\d+\.\d+\.\d+\.\d+)/);
        return match ? match[1] : null;
    } catch (_) {
        return null;
    }
}

function getPuppeteerChromeInfo(puppeteerInstance) {
    let executablePath = null;
    try {
        executablePath = puppeteerInstance.executablePath();
    } catch (_) {}

    const chromeVersion = executablePath ? getChromeVersionFromExecutablePath(puppeteerInstance) : null;

    return {
        executablePath,
        chromeVersion,
        userAgent: buildUserAgent(chromeVersion)
    };
}

function buildUserAgent(chromeVersion) {
    const version = chromeVersion || `${DEFAULT_CHROME_MAJOR}.0.0.0`;
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

function getWaChromeLaunchConfig(puppeteerInstance) {
    const info = getPuppeteerChromeInfo(puppeteerInstance);

    return {
        executablePath: info.executablePath,
        chromeVersion: info.chromeVersion,
        userAgent: info.userAgent,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-sync',
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-features=Translate,MediaRouter,OptimizationHints',
            '--renderer-process-limit=4',
            '--process-per-site',
            '--disable-site-isolation-trials',
            '--mute-audio',
            '--no-first-run',
            `--user-agent=${info.userAgent}`
        ]
    };
}

function getWaWebVersionCacheInfo(dataDir) {
    const baseDir = dataDir || process.env.DATA_DIR || path.join(__dirname, '..');
    const cacheDir = path.join(baseDir, '.wwebjs_cache');

    if (!fs.existsSync(cacheDir)) {
        return {
            cacheDir,
            exists: false,
            latest: null,
            files: []
        };
    }

    const files = fs.readdirSync(cacheDir)
        .filter(file => file.endsWith('.html'))
        .map(file => {
            const fullPath = path.join(cacheDir, file);
            const stat = fs.statSync(fullPath);
            const version = file === 'wa-version.html' ? null : file.replace(/\.html$/, '');
            return {
                file,
                version,
                path: fullPath,
                sizeKb: Math.round(stat.size / 102.4) / 10,
                mtimeMs: stat.mtimeMs,
                ageHours: Math.round(((Date.now() - stat.mtimeMs) / 3600000) * 10) / 10
            };
        })
        .sort((a, b) => {
            if (a.version && b.version) return b.version.localeCompare(a.version);
            if (a.version) return -1;
            if (b.version) return 1;
            return b.mtimeMs - a.mtimeMs;
        });

    return {
        cacheDir,
        exists: true,
        latest: files.find(file => file.version) || files[0] || null,
        files
    };
}

function extractAccountFromCommand(command) {
    const marker = 'whatsapp-session-';
    const start = command.indexOf(marker);
    if (start === -1) return null;

    const rest = command.slice(start + marker.length);
    const match = rest.match(/^([a-zA-Z0-9_-]+)\/session\b/);
    return match ? match[1] : null;
}

function getWaChromeStats(callback) {
    let child;
    try {
        child = execFile('ps', ['-axo', 'pid,ppid,rss,command'], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return callback(err);

        const accounts = {};
        for (const line of stdout.split('\n')) {
            if (!line.includes('whatsapp-session-')) continue;
            const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
            if (!match) continue;

            const accountName = extractAccountFromCommand(match[4]);
            if (!accountName) continue;

            if (!accounts[accountName]) {
                accounts[accountName] = {
                    accountName,
                    accountId: `wa-${accountName}`,
                    processCount: 0,
                    rssMb: 0,
                    pids: []
                };
            }

            accounts[accountName].processCount += 1;
            accounts[accountName].rssMb += Number(match[3]) / 1024;
            accounts[accountName].pids.push(Number(match[1]));
        }

        const data = Object.values(accounts)
            .map(item => ({ ...item, rssMb: Math.round(item.rssMb * 10) / 10 }))
            .sort((a, b) => b.rssMb - a.rssMb);

        callback(null, {
            totalRssMb: Math.round(data.reduce((sum, item) => sum + item.rssMb, 0) * 10) / 10,
            totalProcessCount: data.reduce((sum, item) => sum + item.processCount, 0),
            accounts: data
        });
        });
    } catch (err) {
        return callback(err);
    }
    return child;
}

module.exports = {
    buildUserAgent,
    getChromeVersionFromExecutablePath,
    getPuppeteerChromeInfo,
    getWaChromeLaunchConfig,
    getWaWebVersionCacheInfo,
    getWaChromeStats
};
