const alertDedupe = new Map();

function logEvent(level, processName, event, message, context = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level: String(level || 'info'),
    process: String(processName || 'workbench'),
    event: String(event || 'log'),
    message: String(message || ''),
    ...sanitizeContext(context),
  };
  const line = JSON.stringify(entry);
  if (entry.level === 'error' || entry.level === 'fatal') console.error(line);
  else if (entry.level === 'warn') console.warn(line);
  else console.log(line);
  return entry;
}

function recordRuntimeFailure(runtimeDb, processName, kind, error, context = {}) {
  const err = normalizeError(error);
  try {
    runtimeDb?.prepare(`
      INSERT INTO runtime_events (account_id, platform, source, event_type, severity, message, data_json)
      VALUES (@accountId, @platform, @source, @eventType, 'error', @message, @dataJson)
    `).run({
      accountId: context.account ? `${context.platform || 'unknown'}-${context.account}` : null,
      platform: context.platform || null,
      source: processName,
      eventType: kind,
      message: err.message.slice(0, 1000),
      dataJson: JSON.stringify({ stack: err.stack, ...sanitizeContext(context) }),
    });
  } catch (_) { }
  logEvent('fatal', processName, kind, err.message, { ...context, stack: err.stack });
  sendOperationalAlert({
    severity: 'error',
    title: `${processName}: ${kind}`,
    message: err.message,
    ...context,
  }).catch(() => {});
}

function installProcessGuards({ processName, runtimeDb, shutdown, context = {} } = {}) {
  let fatalInProgress = false;
  const handleFatal = async (kind, error) => {
    if (fatalInProgress) return;
    fatalInProgress = true;
    recordRuntimeFailure(runtimeDb, processName, kind, error, context);
    const forceExit = setTimeout(() => process.exit(1), 10000);
    forceExit.unref?.();
    try {
      if (typeof shutdown === 'function') await shutdown(kind, { exitCode: 1 });
    } catch (shutdownError) {
      logEvent('error', processName, 'fatal_shutdown_failed', normalizeError(shutdownError).message);
    }
    process.exit(1);
  };
  process.on('uncaughtException', (error) => { handleFatal('uncaught_exception', error); });
  process.on('unhandledRejection', (error) => { handleFatal('unhandled_rejection', error); });
  return handleFatal;
}

async function sendOperationalAlert({ severity = 'warn', title, message, platform, account } = {}) {
  const webhook = String(process.env.WORKBENCH_ALERT_WEBHOOK || '').trim();
  if (!webhook || typeof fetch !== 'function') return false;
  const key = `${severity}:${platform || ''}:${account || ''}:${title || ''}`;
  const now = Date.now();
  const previous = alertDedupe.get(key) || 0;
  if (now - previous < 10 * 60 * 1000) return false;
  alertDedupe.set(key, now);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        severity,
        title: String(title || 'Workbench runtime event'),
        message: String(message || '').slice(0, 1000),
        platform: platform || null,
        account: account || null,
        ts: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
    return response.ok;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeError(error) {
  if (error instanceof Error) return error;
  const wrapped = new Error(String(error || 'unknown error'));
  return wrapped;
}

function sanitizeContext(context = {}) {
  const allowed = ['platform', 'account', 'worker', 'pid', 'code', 'signal', 'restart_count', 'delay_ms', 'stack'];
  return Object.fromEntries(allowed.filter((key) => context[key] !== undefined).map((key) => [key, context[key]]));
}

module.exports = {
  installProcessGuards,
  logEvent,
  recordRuntimeFailure,
  sendOperationalAlert,
};
