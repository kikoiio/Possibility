const UTC = 'UTC'

export function effectiveTimeZone(value: string | null | undefined): string {
  if (!value || !value.trim() || /^[+-]/.test(value)) return UTC
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return value
  } catch {
    return UTC
  }
}

export function formatWorldTime(instant: string | null | undefined, timeZone?: string | null): string {
  const zone = effectiveTimeZone(timeZone)
  if (!instant || !Number.isFinite(Date.parse(instant))) return `未知时间 (${zone})`
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(Date.parse(instant))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} (${zone})`
}

export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return effectiveTimeZone(zone)
  } catch {
    return UTC
  }
}
