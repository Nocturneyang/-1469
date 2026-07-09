const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildChromeLaunchConfig,
  enrichChromeLaunchError,
  resolveChromeExecutablePath,
} = require('../lib/chrome-launch');

function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-chrome-launch-'));
  try {
    const env = {
      PUPPETEER_EXECUTABLE_PATH: process.execPath,
      WORKBENCH_WA_PUPPETEER_PIPE: '1',
      WORKBENCH_WA_PUPPETEER_DUMPIO: '1',
      WORKBENCH_WA_PUPPETEER_EXTRA_ARGS: '--one --two=2',
    };
    const logs = [];
    const config = buildChromeLaunchConfig(tmpDir, {
      env,
      log: (message) => logs.push(message),
    });
    assert.strictEqual(resolveChromeExecutablePath(env), process.execPath);
    assert.strictEqual(config.executablePath, process.execPath);
    assert.strictEqual(config.pipe, true);
    assert.strictEqual(config.dumpio, true);
    assert.ok(config.args.includes('--no-sandbox'));
    assert.ok(config.args.includes('--one'));
    assert.ok(config.args.includes('--two=2'));
    assert.ok(config.env.XDG_CONFIG_HOME.startsWith(path.join(tmpDir, '.chromium')));
    assert.ok(config.env.XDG_CACHE_HOME.startsWith(path.join(tmpDir, '.chromium')));
    assert.ok(config.env.XDG_RUNTIME_DIR.startsWith(path.join(tmpDir, '.chromium')));
    assert.ok(logs.some((message) => message.includes('chromium ready:')));

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
