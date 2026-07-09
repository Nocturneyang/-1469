'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_CHROME_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
];

const DEFAULT_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-accelerated-2d-canvas',
  '--disable-extensions',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-crash-reporter',
  '--disable-breakpad',
  '--disable-features=Translate,MediaRouter,OptimizationHints,AudioServiceOutOfProcess,VizDisplayCompositor',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--disable-hang-monitor',
  '--renderer-process-limit=4',
  '--process-per-site',
  '--no-zygote',
  '--disable-site-isolation-trials',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
  '--use-mock-keychain',
  '--window-size=1280,960',
];

function buildChromeLaunchConfig(sessionDir, options = {}) {
  const env = options.env || process.env;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const stateDirs = ensureChromeStateDirs(sessionDir);
  const executablePath = resolveChromeExecutablePath(env);
  assertChromeExecutable(executablePath, { env, log });

  const pipe = envFlag(env.WORKBENCH_WA_PUPPETEER_PIPE, false);
  const dumpio = envFlag(env.WORKBENCH_WA_PUPPETEER_DUMPIO, false);

  return {
    headless: true,
    executablePath,
    pipe,
    dumpio,
    timeout: boundedNumber(env.WORKBENCH_WA_PUPPETEER_TIMEOUT_MS, 120000, 30000, 900000),
    protocolTimeout: boundedNumber(env.WORKBENCH_WA_PUPPETEER_PROTOCOL_TIMEOUT_MS, 120000, 30000, 900000),
    env: {
      ...env,
      XDG_CONFIG_HOME: stateDirs.configDir,
      XDG_CACHE_HOME: stateDirs.cacheDir,
      XDG_RUNTIME_DIR: stateDirs.runtimeDir,
    },
    args: [...DEFAULT_ARGS, ...extraArgs(env.WORKBENCH_WA_PUPPETEER_EXTRA_ARGS)],
  };
}

function resolveChromeExecutablePath(env = process.env) {
  const candidates = [
    env.PUPPETEER_EXECUTABLE_PATH,
    ...DEFAULT_CHROME_CANDIDATES,
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function ensureChromeStateDirs(sessionDir) {
  const root = path.resolve(sessionDir || path.join(process.cwd(), '.local-data', 'sessions', 'wa'), '.chromium');
  const configDir = path.join(root, 'config');
  const cacheDir = path.join(root, 'cache');
  const runtimeDir = path.join(root, 'runtime');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(runtimeDir, 0o700);
  } catch (_) {
    // Some RWX volumes do not support chmod; Chromium can still use the path if it is writable.
  }
  assertWritableDir(root, 'Chrome state root');
  assertWritableDir(configDir, 'Chrome config dir');
  assertWritableDir(cacheDir, 'Chrome cache dir');
  assertWritableDir(runtimeDir, 'Chrome runtime dir');
  return { root, configDir, cacheDir, runtimeDir };
}

function assertChromeExecutable(executablePath, { env = process.env, log = () => {} } = {}) {
  if (!executablePath) {
    throw new Error(
      `未找到可执行 Chromium/Chrome。PUPPETEER_EXECUTABLE_PATH=${env.PUPPETEER_EXECUTABLE_PATH || '-'}；` +
      `请确认生产镜像安装 chromium，或把 PUPPETEER_EXECUTABLE_PATH 指向可执行文件。`
    );
  }
  const result = spawnSync(executablePath, ['--version'], {
    encoding: 'utf8',
    timeout: boundedNumber(env.WORKBENCH_WA_CHROME_PROBE_TIMEOUT_MS, 10000, 1000, 60000),
  });
  if (result.error) {
    throw new Error(`Chromium 自检失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join(' ').trim();
    throw new Error(`Chromium 自检失败，退出码 ${result.status}${detail ? `：${detail}` : ''}`);
  }
  const version = String(result.stdout || result.stderr || '').trim();
  if (version) log(`chromium ready: ${version}`);
}

function enrichChromeLaunchError(err, launchConfig = {}) {
  const message = String(err?.message || err || 'unknown error');
  if (!isLikelyChromeLaunchError(message)) return err;
  const hints = [
    `Chrome=${launchConfig.executablePath || '未解析'}`,
    '请检查生产镜像 chromium 是否可运行、/data/accounts 或 /data/sessions 是否可写、容器内存是否触发重启。',
    '如需浏览器 stderr，可临时设置 WORKBENCH_WA_PUPPETEER_DUMPIO=1。',
  ];
  const wrapped = new Error(`${message}；${hints.join(' ')}`);
  if (err?.stack) wrapped.stack = err.stack;
  return wrapped;
}

function isLikelyChromeLaunchError(message) {
  return /Target\..*closed|Target closed|Browser closed|Failed to launch|spawn .*ENOENT|Protocol error/i.test(message);
}

function assertWritableDir(dirPath, label) {
  try {
    fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch (err) {
    throw new Error(`${label} 不可写：${dirPath} (${err.message})`);
  }
}

function boundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function envFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function extraArgs(value) {
  return String(value || '')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

module.exports = {
  buildChromeLaunchConfig,
  enrichChromeLaunchError,
  resolveChromeExecutablePath,
};
