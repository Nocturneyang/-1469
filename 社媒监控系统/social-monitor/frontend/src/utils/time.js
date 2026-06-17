export const SHANGHAI_TIME_ZONE = 'Asia/Shanghai'

function normalizeShanghaiInput(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return value
  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
  const naiveDateTime = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(trimmed)
  if (!hasTimezone && naiveDateTime) {
    const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')
    return normalized.includes('T') ? `${normalized}+08:00` : `${normalized}T00:00:00+08:00`
  }
  return value
}

function getShanghaiParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(normalizeShanghaiInput(value))
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: SHANGHAI_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  )
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === '24' ? '00' : parts.hour,
    minute: parts.minute,
    second: parts.second
  }
}

export function shanghaiDateString(value = new Date()) {
  const parts = getShanghaiParts(value)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function formatShanghaiDateTime(value, options = {}) {
  if (!value) return '--'
  return new Date(normalizeShanghaiInput(value)).toLocaleString('zh-CN', {
    timeZone: SHANGHAI_TIME_ZONE,
    hour12: false,
    ...options
  })
}
