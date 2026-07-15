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
const DEFAULT_MIN_CHROME_AVAILABLE_MB = 384;
const DEFAULT_WA_WEB_CACHE_MAX_AGE_HOURS = 72;
const BYTES_PER_MB = 1024 * 1024;

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
  '--disable-features=Translate,MediaRouter,OptimizationHints',
  '--renderer-process-limit=4',
  '--password-store=basic',
  '--mute-audio',
  '--no-first-run',
];

function buildChromeLaunchConfig(sessionDir, options = {}) {
  const env = options.env || process.env;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const stateDirs = ensureChromeStateDirs(sessionDir, env);
  assertChromeMemoryAvailable({ env, log });
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
  if (envFlag(env.WORKBENCH_WA_CHROME_PREFLIGHT, true)) {
    assertChromeHeadlessLaunch(config, stateDirs, { env, log });
  }
  log(`WA chrome runtime: ${chromeVersion || 'unknown'}; state=${stateDirs.root}; ua=${userAgent}`);
  return config;
}

function buildWaWebVersionOptions(sessionDir, options = {}) {
  const env = options.env || process.env;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const cacheDir = resolveWaWebCacheDir(sessionDir, env);
  fs.mkdirSync(cacheDir, { recursive: true });

  const pinnedVersion = String(env.WORKBENCH_WA_WEB_VERSION || env.WA_WEB_VERSION || '').trim();
  const forceLatest = envFlag(env.WORKBENCH_WA_WEB_CACHE_FORCE_LATEST, false);
  const maxAgeHours = boundedNumber(
    env.WORKBENCH_WA_WEB_CACHE_MAX_AGE_HOURS,
    DEFAULT_WA_WEB_CACHE_MAX_AGE_HOURS,
    1,
    24 * 30,
  );
  const latestCached = latestCachedWebVersion(cacheDir);
  const ageHours = latestCached ? Math.max(0, (now - latestCached.mtimeMs) / 3600000) : null;
  const cacheFresh = latestCached && ageHours <= maxAgeHours;
  const webVersion = pinnedVersion || (!forceLatest && cacheFresh ? latestCached.version : undefined);

  if (pinnedVersion) {
    log(`WA WebVersion pinned: ${pinnedVersion}`);
  } else if (forceLatest) {
    log(`WA WebVersion forced latest on startup; retained cache=${cacheDir}`);
  } else if (cacheFresh) {
    log(`WA WebVersion cached: ${latestCached.version} (${roundHours(ageHours)}h old, max ${maxAgeHours}h)`);
  } else if (latestCached) {
    log(`WA WebVersion cache stale: ${latestCached.version} (${roundHours(ageHours)}h old, max ${maxAgeHours}h); refreshing on startup`);
  } else {
    log(`WA WebVersion cache empty; fetching current version on startup: ${cacheDir}`);
  }

  return {
    // `whatsapp-web.js` merges in its packaged default when this key is omitted.
    // Explicit null deliberately misses the local cache and activates strict=false live fallback.
    webVersion: webVersion || null,
    webVersionCache: {
      type: 'local',
      path: cacheDir,
      strict: false,
    },
  };
}

function prepareWaChromeProfile(sessionDir, clientId, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  cleanupStaleChromeProfiles(sessionDir, clientId, { log });
  const profileDirs = getChromeProfileDirs(sessionDir, clientId);
  for (const profileDir of profileDirs) {
    fs.mkdirSync(profileDir, { recursive: true });
    assertWritableDir(profileDir, 'WA Chrome profile dir');
    assertWritableProbe(profileDir, 'WA Chrome profile dir');
  }
  return profileDirs;
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
        const pid = Number(match[1]);
        const command = processCommand(pid);
        if (command && command.includes(profileDir)) {
          killProcess(pid, log, `SingletonLock ${profileDir}`);
        } else if (command) {
          log(`ignored SingletonLock PID not using WA profile: pid=${pid} cmd=${command.slice(0, 180)}`);
        }
      }
    } catch (_) {}
  }

  const pids = findChromePidsByProfileDirs(profileDirs);
  if (pids.length > 0) {
    log(`found stale chrome processes for WA profile: ${pids.join(', ')}`);
    for (const pid of pids) {
      killProcess(pid, log, 'matched WA profile dir');
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
  for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'DBUS_SYSTEM_BUS_ADDRESS']) {
    const value = String(chromeEnv[key] || '').trim();
    if (!value || value === 'autolaunch:' || value === 'autolaunch' || !/^(unix|tcp):/.test(value)) {
      delete chromeEnv[key];
    }
  }
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

function assertChromeHeadlessLaunch(launchConfig, stateDirs, { env = process.env, log = () => {} } = {}) {
  const baseArgs = launchConfig.args.filter((arg) => !String(arg).startsWith('--user-data-dir='));
  const failures = [];
  for (const headlessFlag of ['--headless=new', '--headless']) {
    const preflightDir = path.join(stateDirs.root, `preflight-${process.pid}-${Date.now()}`);
    fs.mkdirSync(preflightDir, { recursive: true });
    const args = [
      ...baseArgs,
      headlessFlag,
      `--user-data-dir=${preflightDir}`,
      '--dump-dom',
      'about:blank',
    ];
    const result = spawnSync(launchConfig.executablePath, args, {
      env: launchConfig.env,
      encoding: 'utf8',
      timeout: boundedNumber(env.WORKBENCH_WA_CHROME_PREFLIGHT_TIMEOUT_MS, 15000, 3000, 60000),
      maxBuffer: 4 * 1024 * 1024,
    });
    try {
      fs.rmSync(preflightDir, { recursive: true, force: true });
    } catch (_) {}
    if (!result.error && result.status === 0 && !result.signal) {
      log(`chromium headless preflight ok (${headlessFlag})`);
      return;
    }
    failures.push({ headlessFlag, result });
    log(`chromium headless preflight attempt failed (${headlessFlag}): ${formatProcessFailure(result)}`);
  }

  if (failures.length > 0 && failures.every(({ result }) => isDbusOnlySigtrap(result))) {
    log('chromium headless preflight warning: both probes ended with SIGTRAP and D-Bus-only stderr; continuing to Puppeteer');
    return;
  }

  const last = failures[failures.length - 1].result;
  if (last.error) {
    throw new Error(`Chromium headless 预检失败：${last.error.message}`);
  }
  throw new Error(
    `Chromium headless 预检失败，退出码 ${last.status ?? 'null'}，signal ${last.signal || '-'}${compactProcessOutput(last) ? `：${compactProcessOutput(last)}` : ''}`
  );
}

function assertChromeMemoryAvailable({ env = process.env, log = () => {}, snapshot = null } = {}) {
  const minimumMb = boundedNumber(
    env.WORKBENCH_WA_CHROME_MIN_AVAILABLE_MB,
    DEFAULT_MIN_CHROME_AVAILABLE_MB,
    0,
    16384
  );
  if (minimumMb <= 0) return null;
  const minimumBytes = minimumMb * BYTES_PER_MB;
  const current = snapshot || readMemorySnapshot();
  if (!current || !Number.isFinite(current.availableBytes)) {
    log('chrome memory preflight skipped: cgroup/proc memory snapshot unavailable');
    return current;
  }
  if (current.availableBytes < minimumBytes) {
    throw new Error(
      `Chromium 可用内存不足：${formatBytes(current.availableBytes)} < ${formatBytes(minimumBytes)} ` +
      `(${current.source || 'unknown'})。请降低 WORKBENCH_ACCOUNT_WORKER_MAX_WORKERS、增加容器内存，` +
      `或临时调小 WORKBENCH_WA_CHROME_MIN_AVAILABLE_MB 后再启动 WA。`
    );
  }
  log(`chrome memory preflight ok: available=${formatBytes(current.availableBytes)}, required=${formatBytes(minimumBytes)}, source=${current.source || 'unknown'}`);
  return current;
}

function readMemorySnapshot() {
  const v2Max = readMemoryValue('/sys/fs/cgroup/memory.max');
  const v2Current = readMemoryValue('/sys/fs/cgroup/memory.current');
  if (Number.isFinite(v2Max) && Number.isFinite(v2Current) && v2Max > 0) {
    return {
      availableBytes: Math.max(0, v2Max - v2Current),
      limitBytes: v2Max,
      currentBytes: v2Current,
      source: 'cgroup-v2',
    };
  }

  const v1Max = readMemoryValue('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const v1Current = readMemoryValue('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (Number.isFinite(v1Max) && Number.isFinite(v1Current) && v1Max > 0 && v1Max < Number.MAX_SAFE_INTEGER) {
    return {
      availableBytes: Math.max(0, v1Max - v1Current),
      limitBytes: v1Max,
      currentBytes: v1Current,
      source: 'cgroup-v1',
    };
  }

  const memAvailable = readProcMemAvailable();
  if (Number.isFinite(memAvailable)) {
    return {
      availableBytes: memAvailable,
      limitBytes: null,
      currentBytes: null,
      source: 'proc-meminfo',
    };
  }
  return null;
}

function enrichChromeLaunchError(err, launchConfig = {}) {
  const message = String(err?.message || err || 'unknown error');
  if (!isLikelyChromeLaunchError(message)) return err;
  const hints = [
    `Chrome=${launchConfig.executablePath || '未解析'}`,
    'Code=null 通常表示 Chromium 被外部信号终止，优先检查容器 OOM、并发 WA worker 和 cgroup 内存余量。',
    'stderr 中的 D-Bus 连接失败通常不是致命根因；真正要看的是退出码、signal、profile 锁和内存。',
    '请检查生产镜像 chromium 是否可真实 headless 启动、账号 session/profile 目录是否可写、是否存在残留 Chrome profile 锁。',
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

function assertWritableProbe(dirPath, label) {
  const probePath = path.join(dirPath, `.workbench-write-test-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probePath, 'ok');
    fs.readFileSync(probePath, 'utf8');
  } catch (err) {
    throw new Error(`${label} 写入探针失败：${dirPath} (${err.message})`);
  } finally {
    try {
      fs.unlinkSync(probePath);
    } catch (_) {}
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
  const baseDir = path.resolve(sessionDir || path.join(process.cwd(), '.local-data', 'sessions', 'wa'));
  return path.join(path.dirname(baseDir), '.wwebjs_cache');
}

function roundHours(value) {
  return Math.round(Number(value) * 10) / 10;
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

function readMemoryValue(filePath) {
  try {
    const raw = String(fs.readFileSync(filePath, 'utf8')).trim();
    if (!raw || raw === 'max') return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    if (value >= 9_000_000_000_000_000) return null;
    return value;
  } catch (_) {
    return null;
  }
}

function readProcMemAvailable() {
  try {
    const content = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = content.match(/^MemAvailable:\s+(\d+)\s+kB/im);
    return match ? Number(match[1]) * 1024 : null;
  } catch (_) {
    return null;
  }
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes >= 1024 * BYTES_PER_MB) return `${Math.round((bytes / (1024 * BYTES_PER_MB)) * 10) / 10} GiB`;
  return `${Math.round((bytes / BYTES_PER_MB) * 10) / 10} MiB`;
}

function compactProcessOutput(result) {
  const output = [result.stderr, result.stdout]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const meaningful = output
    .split(/(?=\[\d+[:\d]*\/)/)
    .filter((line) => !/ERROR:dbus\/bus\.cc.*Failed to connect to the bus/i.test(line))
    .join(' ')
    .trim();
  return (meaningful || output).slice(0, 2000);
}

function formatProcessFailure(result) {
  if (result?.error) return result.error.message;
  const detail = compactProcessOutput(result);
  return `exit=${result?.status ?? 'null'} signal=${result?.signal || '-'}${detail ? `: ${detail}` : ''}`;
}

function isDbusOnlySigtrap(result) {
  if (result?.signal !== 'SIGTRAP') return false;
  const output = [result.stderr, result.stdout].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return Boolean(output) && /dbus|d-bus|bus\.cc|unknown address type/i.test(output) &&
    !/fatal:|check failed|crashpad|sandbox|segmentation|out of memory|oom/i.test(output);
}

function processCommand(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0 || numericPid === process.pid) return '';
  const result = spawnSync('ps', ['-p', String(numericPid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

function killProcess(pid, log, reason) {
  try {
    process.kill(pid, 'SIGKILL');
    log(`killed stale chrome PID ${pid}: ${reason}`);
  } catch (_) {}
}

module.exports = {
  assertChromeMemoryAvailable,
  buildUserAgent,
  buildChromeLaunchConfig,
  buildWaWebVersionOptions,
  cleanupStaleChromeProfiles,
  enrichChromeLaunchError,
  getChromeProfileDirs,
  prepareWaChromeProfile,
  readMemorySnapshot,
  resolveChromeExecutablePath,
};
