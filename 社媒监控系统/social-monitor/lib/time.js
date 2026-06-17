const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SHANGHAI_TIME_ZONE,
  weekday: 'short'
});

const WEEKDAY_INDEX = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7
};

function normalizeShanghaiInput(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const naiveDateTime = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(trimmed);
  if (!hasTimezone && naiveDateTime) {
    const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
    return normalized.includes('T') ? `${normalized}+08:00` : `${normalized}T00:00:00+08:00`;
  }
  return value;
}

function toDate(value = new Date()) {
  return value instanceof Date ? value : new Date(normalizeShanghaiInput(value));
}

function getShanghaiParts(value = new Date()) {
  const date = toDate(value);
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === '24' ? '00' : parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function shanghaiDateString(value = new Date()) {
  const parts = getShanghaiParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shanghaiDateTimeString(value = new Date()) {
  const parts = getShanghaiParts(value);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function shanghaiISOString(value = new Date()) {
  const date = toDate(value);
  const parts = getShanghaiParts(date);
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${ms}+08:00`;
}

function shanghaiFilenameTimestamp(value = new Date()) {
  return shanghaiDateTimeString(value).replace(' ', 'T').replace(/:/g, '-');
}

function shanghaiMonthKey(value = new Date()) {
  const parts = getShanghaiParts(value);
  return `${parts.year}${parts.month}`;
}

function shanghaiWeekday(value = new Date()) {
  return WEEKDAY_INDEX[weekdayFormatter.format(toDate(value))] || 1;
}

function shanghaiDateStartMs(dateString = shanghaiDateString()) {
  return Date.parse(`${dateString}T00:00:00+08:00`);
}

function formatShanghai(value = new Date(), options = {}, locale = 'zh-CN') {
  return toDate(value).toLocaleString(locale, { timeZone: SHANGHAI_TIME_ZONE, ...options });
}

function parseShanghaiDate(value = new Date()) {
  return toDate(value);
}

module.exports = {
  SHANGHAI_TIME_ZONE,
  SHANGHAI_OFFSET_MS,
  formatShanghai,
  getShanghaiParts,
  parseShanghaiDate,
  shanghaiDateString,
  shanghaiDateStartMs,
  shanghaiDateTimeString,
  shanghaiFilenameTimestamp,
  shanghaiISOString,
  shanghaiMonthKey,
  shanghaiWeekday
};
