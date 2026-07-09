const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildUserAgent,
  buildChromeLaunchConfig,
  buildWaWebVersionOptions,
  cleanupStaleChromeProfiles,
  enrichChromeLaunchError,
  getChromeProfileDirs,
  resolveChromeExecutablePath,
} = require('../lib/chrome-launch');

function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-chrome-launch-'));
  try {
    const env = {
      PUPPETEER_EXECUTABLE_PATH: process.execPath,
      WORKBENCH_WA_PUPPETEER_DUMPIO: '1',
      WORKBENCH_WA_PUPPETEER_EXTRA_ARGS: '--one --two=2',
      DBUS_SESSION_BUS_ADDRESS: 'disabled:',
      DBUS_SYSTEM_BUS_ADDRESS: 'disabled:',
    };
    const logs = [];
    const config = buildChromeLaunchConfig(tmpDir, {
      env,
      log: (message) => logs.push(message),
    });
    assert.strictEqual(resolveChromeExecutablePath(env), process.execPath);
    assert.strictEqual(config.executablePath, process.execPath);
    assert.strictEqual(config.pipe, undefined);
    assert.strictEqual(config.dumpio, true);
    assert.ok(config.args.includes('--no-sandbox'));
    assert.ok(config.args.includes(`--user-agent=${buildUserAgent(null)}`));
    assert.ok(config.args.includes('--one'));
    assert.ok(config.args.includes('--two=2'));
    assert.ok(config.env.XDG_CONFIG_HOME.startsWith(path.join(tmpDir, '.chromium')));
    assert.ok(config.env.XDG_CACHE_HOME.startsWith(path.join(tmpDir, '.chromium')));
    assert.ok(config.env.XDG_RUNTIME_DIR.startsWith(path.join(tmpDir, '.chromium')));
    assert.strictEqual(config.env.NO_AT_BRIDGE, '1');
    assert.strictEqual(config.env.DBUS_SESSION_BUS_ADDRESS, undefined);
    assert.strictEqual(config.env.DBUS_SYSTEM_BUS_ADDRESS, undefined);
    assert.ok(logs.some((message) => message.includes('chromium ready:')));
    assert.ok(logs.some((message) => message.includes('WA chrome runtime:')));

    const pipeConfig = buildChromeLaunchConfig(tmpDir, {
      env: {
        PUPPETEER_EXECUTABLE_PATH: process.execPath,
        WORKBENCH_WA_PUPPETEER_PIPE: '1',
      },
    });
    assert.strictEqual(pipeConfig.pipe, true);

    const cacheDir = path.join(tmpDir, 'wa-web-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, '2.3000.1.html'), '<html></html>');
    const webOptions = buildWaWebVersionOptions(tmpDir, {
      env: { WORKBENCH_WA_WEB_CACHE_DIR: cacheDir },
    });
    assert.strictEqual(webOptions.webVersion, '2.3000.1');
    assert.deepStrictEqual(webOptions.webVersionCache, {
      type: 'local',
      path: cacheDir,
      strict: false,
    });

    const profileDirs = getChromeProfileDirs(tmpDir, 'wa_test');
    fs.mkdirSync(profileDirs[0], { recursive: true });
    fs.writeFileSync(path.join(profileDirs[0], 'SingletonLock'), 'stale');
    fs.writeFileSync(path.join(profileDirs[0], 'SingletonCookie'), 'stale');
    cleanupStaleChromeProfiles(tmpDir, 'wa_test');
    assert.strictEqual(fs.existsSync(path.join(profileDirs[0], 'SingletonLock')), false);
    assert.strictEqual(fs.existsSync(path.join(profileDirs[0], 'SingletonCookie')), false);

    const original = new Error('Protocol error (Target.setDiscoverTargets): Target closed');
    const enriched = enrichChromeLaunchError(original, config);
    assert.notStrictEqual(enriched, original);
    assert.ok(enriched.message.includes('Chrome='));
    assert.ok(enriched.message.includes('WORKBENCH_WA_PUPPETEER_DUMPIO=1'));

    const unrelated = new Error('ordinary failure');
    assert.strictEqual(enrichChromeLaunchError(unrelated, config), unrelated);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
