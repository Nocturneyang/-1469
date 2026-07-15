const DISPLAY_TIME_ZONE = 'Asia/Shanghai';

export function formatTime(value) {
  const date = toDate(value);
  if (!date) return '';
  const now = new Date();
  const messageDay = formatShanghaiDayKey(date);
  if (messageDay === formatShanghaiDayKey(now)) return formatShanghaiClock(date);
  if (messageDay === formatShanghaiDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000))) return '昨天';
  return formatShanghaiDate(date);
}

export function formatMessageTime(value) {
  const date = toDate(value);
  if (!date) return '';
  return formatShanghaiClock(date);
}

export function messageDayKey(value) {
  const date = toDate(value);
  return date ? formatShanghaiDayKey(date) : '';
}

export function formatMessageDateLabel(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return '';
  const dayKey = formatShanghaiDayKey(date);
  if (dayKey === formatShanghaiDayKey(now)) return '今天';
  if (dayKey === formatShanghaiDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000))) return '昨天';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function toDate(value) {
  if (!value) return null;
  if (typeof value === 'number') return new Date(value > 1000000000000 ? value : value * 1000);
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric > 1000000000000 ? numeric : numeric * 1000);
  const text = String(value).trim();
  const parsed = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? Date.parse(`${text.replace(' ', 'T')}Z`)
    : Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function formatShanghaiClock(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: DISPLAY_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).format(date);
}

function formatShanghaiDate(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: DISPLAY_TIME_ZONE,
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatShanghaiDayKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function platformName(platform) {
  if (platform === 'wa') return 'WA';
  if (platform === 'tg') return 'TG';
  return platform || '';
}

export function platformClass(platform) {
  if (platform === 'wa') return 'platform-wa';
  if (platform === 'tg') return 'platform-tg';
  return 'platform-default';
}

export function statusText(status) {
  const map = {
    pending: 'pending',
    sending: 'sending',
    sent: 'sent',
    delivered: 'delivered',
    failed: 'failed',
    dead: 'dead',
    paused: 'paused',
    canceled: 'canceled',
    received: '',
  };
  return map[status] || status || '';
}
