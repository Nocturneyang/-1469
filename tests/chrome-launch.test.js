const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  assertChromeMemoryAvailable,
  buildUserAgent,
  buildChromeLaunchConfig,
  buildWaWebVersionOptions,
  enrichChromeLaunchError,
  getChromeProfileDirs,
  prepareWaChromeProfile,
  resolveChromeExecutablePath,
} = require('../lib/chrome-launch');

function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-chrome-launch-'));
  try {
    const env = {
      PUPPETEER_EXECUTABLE_PATH: process.execPath,
      WORKBENCH_WA_PUPPETEER_DUMPIO: '1',
      WORKBENCH_WA_PUPPETEER_EXTRA_ARGS: '--one --two=2',
      WORKBENCH_WA_CHROME_PREFLIGHT: '0',
      WORKBENCH_WA_CHROME_MIN_AVAILABLE_MB: '0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/workbench-session-bus',
      DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/tmp/workbench-system-bus',
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
    assert.strictEqual(config.args.includes('--no-zygote'), false);
    assert.strictEqual(config.args.includes('--disable-crashpad'), false);
    assert.strictEqual(config.args.includes('--process-per-site'), false);
    assert.ok(config.args.includes(`--user-agent=${buildUserAgent(null)}`));
    assert.ok(config.args.includes('--one'));
    assert.ok(config.args.includes('--two=2'));
    assert.ok(config.env.XDG_CONFIG_HOME.startsWith(path.join(tmpDir, '.chromium')));
    assert.ok(config.env.XDG_CACHE_HOME.startsWith(path.join(tmpDir, '.chromium')));
    assert.ok(config.env.XDG_RUNTIME_DIR.startsWith(path.join(tmpDir, '.chromium')));
    assert.strictEqual(config.env.NO_AT_BRIDGE, '1');
    assert.strictEqual(config.env.DBUS_SESSION_BUS_ADDRESS, env.DBUS_SESSION_BUS_ADDRESS);
    assert.strictEqual(config.env.DBUS_SYSTEM_BUS_ADDRESS, env.DBUS_SYSTEM_BUS_ADDRESS);

    const cleanedDbusConfig = buildChromeLaunchConfig(tmpDir, {
      env: {
        PUPPETEER_EXECUTABLE_PATH: process.execPath,
        DBUS_SESSION_BUS_ADDRESS: 'autolaunch:',
        DBUS_SYSTEM_BUS_ADDRESS: '',
        WORKBENCH_WA_CHROME_PREFLIGHT: '0',
        WORKBENCH_WA_CHROME_MIN_AVAILABLE_MB: '0',
      },
    });
    assert.strictEqual(cleanedDbusConfig.env.DBUS_SESSION_BUS_ADDRESS, undefined);
    assert.strictEqual(cleanedDbusConfig.env.DBUS_SYSTEM_BUS_ADDRESS, undefined);
    assert.ok(logs.some((message) => message.includes('chromium ready:')));
    assert.ok(logs.some((message) => message.includes('WA chrome runtime:')));

    const prodConfig = buildChromeLaunchConfig(tmpDir, {
      env: {
        PUPPETEER_EXECUTABLE_PATH: process.execPath,
        DATA_DIR: '/data',
        WORKBENCH_WA_CHROME_PREFLIGHT: '0',
        WORKBENCH_WA_CHROME_MIN_AVAILABLE_MB: '0',
      },
    });
    assert.ok(prodConfig.env.XDG_CONFIG_HOME.startsWith('/tmp/workbench-chrome/'));
    assert.ok(prodConfig.env.XDG_CACHE_HOME.startsWith('/tmp/workbench-chrome/'));
    assert.ok(prodConfig.env.XDG_RUNTIME_DIR.startsWith('/tmp/workbench-chrome/'));

    const pipeConfig = buildChromeLaunchConfig(tmpDir, {
      env: {
        PUPPETEER_EXECUTABLE_PATH: process.execPath,
        WORKBENCH_WA_PUPPETEER_PIPE: '1',
        WORKBENCH_WA_CHROME_PREFLIGHT: '0',
        WORKBENCH_WA_CHROME_MIN_AVAILABLE_MB: '0',
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
    prepareWaChromeProfile(tmpDir, 'wa_test');
    assert.strictEqual(fs.existsSync(path.join(profileDirs[0], 'SingletonLock')), false);
    assert.strictEqual(fs.existsSync(path.join(profileDirs[0], 'SingletonCookie')), false);
    assert.ok(fs.existsSync(profileDirs[0]));
    assert.ok(fs.existsSync(profileDirs[1]));

    assert.throws(() => assertChromeMemoryAvailable({
      env: { WORKBENCH_WA_CHROME_MIN_AVAILABLE_MB: '512' },
      snapshot: {
        availableBytes: 128 * 1024 * 1024,
        source: 'test',
      },
    }), /Chromium 可用内存不足/);

    const fakeChrome = path.join(tmpDir, 'fake-chromium');
    fs.writeFileSync(fakeChrome, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "Chromium 146.0.0.0"; exit 0; fi',
      'echo "headless boom" >&2',
      'exit 42',
      '',
    ].join('\n'));
    fs.chmodSync(fakeChrome, 0o755);
    assert.throws(() => buildChromeLaunchConfig(tmpDir, {
      env: {
        PUPPETEER_EXECUTABLE_PATH: fakeChrome,
        WORKBENCH_WA_CHROME_MIN_AVAILABLE_MB: '0',
      },
    }), /Chromium headless 预检失败/);

    const dbusSigtrapChrome = path.join(tmpDir, 'dbus-sigtrap-chromium');
    fs.writeFileSync(dbusSigtrapChrome, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "Chromium 150.0.0.0"; exit 0; fi',
      'echo "[1:2:0101/010101.000000:ERROR:dbus/bus.cc:405] Failed to connect to the bus" >&2',
      'kill -TRAP $$',
      '',
    ].join('\n'));
    fs.chmodSync(dbusSigtrapChrome, 0o755);
    const dbusSigtrapConfig = buildChromeLaunchConfig(tmpDir, {
      env: {
        PUPPETEER_EXECUTABLE_PATH: dbusSigtrapChrome,
        WORKBENCH_WA_CHROME_MIN_AVAILABLE_MB: '0',
      },
      log: (message) => logs.push(message),
    });
    assert.strictEqual(dbusSigtrapConfig.executablePath, dbusSigtrapChrome);
    assert.ok(logs.some((message) => message.includes('D-Bus-only stderr')));

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
