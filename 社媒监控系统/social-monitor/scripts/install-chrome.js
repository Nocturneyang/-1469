const { spawnSync } = require('child_process');

const skip = process.env.SKIP_CHROME_INSTALL === 'true' || process.env.PUPPETEER_SKIP_DOWNLOAD === 'true';

if (skip) {
    console.log('[postinstall] Chrome install skipped');
    process.exit(0);
}

const result = spawnSync('npx', ['puppeteer', 'browsers', 'install', 'chrome'], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
});

process.exit(result.status || 0);
