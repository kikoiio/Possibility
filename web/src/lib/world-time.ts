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

/** Format elapsed simulated time without consulting the browser clock. */
export function formatRelativeWorldTime(eventSimTime: string | null | undefined, simNow: string | null | undefined, timeZone?: string | null): string {
  const zone = effectiveTimeZone(timeZone)
  const event = eventSimTime ? Date.parse(eventSimTime) : NaN
  const now = simNow ? Date.parse(simNow) : NaN
  if (!Number.isFinite(event) || !Number.isFinite(now)) return `未知时间 (${zone})`
  const delta = now - event
  if (delta < 0) {
    const minutes = Math.max(1, Math.floor(-delta / 60000))
    return minutes < 60 ? `${minutes} 分钟后` : `${Math.floor(minutes / 60)} 小时后`
  }
  if (delta < 60000) return '刚刚'
  if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`
  if (delta < 86400000) return `${Math.floor(delta / 3600000)} 小时前`
  return `${Math.floor(delta / 86400000)} 天前`
}

export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return effectiveTimeZone(zone)
  } catch {
    return UTC
  }
}
