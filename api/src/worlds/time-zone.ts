const UTC = 'UTC'

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || /^[+-]/.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}

export function effectiveTimeZone(value: string | null | undefined): string {
  return isValidTimeZone(value) ? value : UTC
}

export function formatWorldTime(instant: string, timeZone: string | null | undefined): string {
  const timestamp = Date.parse(instant)
  if (!Number.isFinite(timestamp)) return `未知时间 (${effectiveTimeZone(timeZone)})`
  const zone = effectiveTimeZone(timeZone)
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestamp)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} (${zone})`
}
