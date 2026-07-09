'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DEFAULT_CHROME_MAJOR = '146';
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
  '--disable-extensions',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-features=Translate,MediaRouter,OptimizationHints,CrashReporting',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--disable-crashpad',
  '--renderer-process-limit=4',
  '--process-per-site',
  '--disable-site-isolation-trials',
  '--no-zygote',
  '--password-store=basic',
  '--mute-audio',
  '--no-first-run',
];

function buildChromeLaunchConfig(sessionDir, options = {}) {
  const env = options.env || process.env;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const stateDirs = ensureChromeStateDirs(sessionDir, env);
  const executablePath = resolveChromeExecutablePath(env, {
    puppeteer: options.puppeteer,
    log,
  });
  const probeOutput = assertChromeExecutable(executablePath, { env, log });
  const chromeVersion = getChromeVersion({
    executablePath,
    probeOutput,
    puppeteer: options.puppeteer,
  });
  const userAgent = buildUserAgent(chromeVersion);

  const dumpio = envFlag(env.WORKBENCH_WA_PUPPETEER_DUMPIO, false);
  const chromeEnv = buildChromeEnv(env, stateDirs);
  const config = {
    headless: true,
    executablePath,
    dumpio,
    timeout: boundedNumber(env.WORKBENCH_WA_PUPPETEER_TIMEOUT_MS, 120000, 30000, 900000),
    protocolTimeout: boundedNumber(env.WORKBENCH_WA_PUPPETEER_PROTOCOL_TIMEOUT_MS, 600000, 30000, 900000),
    env: chromeEnv,
    args: [
      ...DEFAULT_ARGS,
      `--user-agent=${userAgent}`,
      ...extraArgs(env.WORKBENCH_WA_PUPPETEER_EXTRA_ARGS),
    ],
  };

  if (env.WORKBENCH_WA_PUPPETEER_PIPE !== undefined && env.WORKBENCH_WA_PUPPETEER_PIPE !== '') {
    config.pipe = envFlag(env.WORKBENCH_WA_PUPPETEER_PIPE, false);
  }
  log(`WA chrome runtime: ${chromeVersion || 'unknown'}; state=${stateDirs.root}; ua=${userAgent}`);
  return config;
}

function buildWaWebVersionOptions(sessionDir, options = {}) {
  const env = options.env || process.env;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const cacheDir = resolveWaWebCacheDir(sessionDir, env);
  fs.mkdirSync(cacheDir, { recursive: true });

  const pinnedVersion = String(env.WORKBENCH_WA_WEB_VERSION || env.WA_WEB_VERSION || '').trim();
  const latestCached = latestCachedWebVersion(cacheDir);
  const webVersion = pinnedVersion || latestCached?.version || undefined;

  if (pinnedVersion) {
    log(`WA WebVersion pinned: ${pinnedVersion}`);
  } else if (latestCached) {
    const ageHours = Math.round(((Date.now() - latestCached.mtimeMs) / 3600000) * 10) / 10;
    log(`WA WebVersion cached: ${latestCached.version} (${ageHours}h old)`);
  } else {
    log(`WA WebVersion cache empty, fallback enabled: ${cacheDir}`);
  }

  return {
    ...(webVersion ? { webVersion } : {}),
    webVersionCache: {
      type: 'local',
      path: cacheDir,
      strict: false,
    },
  };
}

function cleanupStaleChromeProfiles(sessionDir, clientId, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const profileDirs = getChromeProfileDirs(sessionDir, clientId);

  for (const profileDir of profileDirs) {
    const singletonLock = path.join(profileDir, 'SingletonLock');
    try {
      const target = fs.readlinkSync(singletonLock);
      const match = String(target).match(/-(\d+)$/);
      if (match) {
        try {
          process.kill(Number(match[1]), 'SIGKILL');
          log(`killed stale chrome PID from SingletonLock: ${match[1]} (${profileDir})`);
        } catch (_) {}
      }
    } catch (_) {}
  }

  const pids = findChromePidsByProfileDirs(profileDirs);
  if (pids.length > 0) {
    log(`found stale chrome processes for WA profile: ${pids.join(', ')}`);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (_) {}
    }
    spawnSync('sleep', ['1'], { timeout: 3000 });
  }

  for (const profileDir of profileDirs) {
    for (const fileName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try {
        fs.unlinkSync(path.join(profileDir, fileName));
        log(`removed stale chrome profile lock: ${fileName} (${profileDir})`);
      } catch (_) {}
    }
  }
}

function getChromeProfileDirs(sessionDir, clientId) {
  const baseDir = path.resolve(sessionDir || path.join(process.cwd(), '.local-data', 'sessions', 'wa'));
  const profileDirs = [baseDir];
  const normalizedClientId = String(clientId || '').trim();
  if (normalizedClientId) profileDirs.unshift(path.join(baseDir, `session-${normalizedClientId}`));
  return Array.from(new Set(profileDirs));
}

function resolveChromeExecutablePath(env = process.env, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const configuredPath = env.PUPPETEER_EXECUTABLE_PATH;
  if (configuredPath) {
    if (fs.existsSync(configuredPath)) return configuredPath;
    log(`ignoring missing PUPPETEER_EXECUTABLE_PATH: ${configuredPath}`);
  }

  const puppeteerPath = resolvePuppeteerExecutablePath(options.puppeteer);
  if (puppeteerPath && fs.existsSync(puppeteerPath)) return puppeteerPath;

  return DEFAULT_CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || '';
}

function ensureChromeStateDirs(sessionDir, env = process.env) {
  const root = resolveChromeStateRoot(sessionDir, env);
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

function resolveChromeStateRoot(sessionDir, env = process.env) {
  const configured = env.WORKBENCH_WA_CHROME_STATE_DIR || env.WORKBENCH_CHROME_STATE_DIR;
  if (configured) return path.resolve(configured, shortHash(sessionDir || process.cwd()));

  const resolvedSessionDir = path.resolve(sessionDir || path.join(process.cwd(), '.local-data', 'sessions', 'wa'));
  if (path.resolve(env.DATA_DIR || '') === '/data') {
    return path.join('/tmp', 'workbench-chrome', shortHash(resolvedSessionDir));
  }
  return path.join(resolvedSessionDir, '.chromium');
}

function buildChromeEnv(env, stateDirs) {
  const chromeEnv = {
    ...env,
    NO_AT_BRIDGE: '1',
    XDG_CONFIG_HOME: stateDirs.configDir,
    XDG_CACHE_HOME: stateDirs.cacheDir,
    XDG_RUNTIME_DIR: stateDirs.runtimeDir,
  };
  delete chromeEnv.DBUS_SESSION_BUS_ADDRESS;
  delete chromeEnv.DBUS_SYSTEM_BUS_ADDRESS;
  return chromeEnv;
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
  return version;
}

function enrichChromeLaunchError(err, launchConfig = {}) {
  const message = String(err?.message || err || 'unknown error');
  if (!isLikelyChromeLaunchError(message)) return err;
  const hints = [
    `Chrome=${launchConfig.executablePath || '未解析'}`,
    '请检查生产镜像 chromium 是否可运行、账号 session 目录是否可写、是否存在残留 Chrome profile 锁、容器内存是否触发重启。',
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

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function buildUserAgent(chromeVersion) {
  const version = chromeVersion || `${DEFAULT_CHROME_MAJOR}.0.0.0`;
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

function getChromeVersion({ executablePath, probeOutput, puppeteer } = {}) {
  return extractChromeVersion(executablePath) ||
    extractChromeVersion(probeOutput) ||
    extractChromeVersion(resolvePuppeteerExecutablePath(puppeteer)) ||
    null;
}

function extractChromeVersion(value) {
  const match = String(value || '').match(/(\d+\.\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function resolvePuppeteerExecutablePath(puppeteer) {
  try {
    return typeof puppeteer?.executablePath === 'function' ? puppeteer.executablePath() : '';
  } catch (_) {
    return '';
  }
}

function resolveWaWebCacheDir(sessionDir, env = process.env) {
  const configured = env.WORKBENCH_WA_WEB_CACHE_DIR || env.WORKBENCH_WWEBJS_CACHE_DIR;
  if (configured) return path.resolve(configured);
  if (env.DATA_DIR) return path.resolve(env.DATA_DIR, '.wwebjs_cache');
  const baseDir = path.resolve(sessionDir || path.join(process.cwd(), '.local-data', 'sessions', 'wa'));
  return path.join(path.dirname(baseDir), '.wwebjs_cache');
}

function latestCachedWebVersion(cacheDir) {
  try {
    return fs.readdirSync(cacheDir)
      .filter((file) => /^\d+\.\d+\.\d+.*\.html$/.test(file))
      .map((file) => {
        const fullPath = path.join(cacheDir, file);
        return {
          file,
          version: file.replace(/\.html$/, ''),
          mtimeMs: fs.statSync(fullPath).mtimeMs,
        };
      })
      .sort((a, b) => b.version.localeCompare(a.version) || b.mtimeMs - a.mtimeMs)[0] || null;
  } catch (_) {
    return null;
  }
}

function findChromePidsByProfileDirs(profileDirs) {
  const result = spawnSync('ps', ['-axo', 'pid,command'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return [];

  const pids = [];
  for (const line of String(result.stdout || '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    if (profileDirs.some((profileDir) => match[2].includes(profileDir))) pids.push(pid);
  }
  return pids;
}

module.exports = {
  buildUserAgent,
  buildChromeLaunchConfig,
  buildWaWebVersionOptions,
  cleanupStaleChromeProfiles,
  enrichChromeLaunchError,
  getChromeProfileDirs,
  resolveChromeExecutablePath,
};
