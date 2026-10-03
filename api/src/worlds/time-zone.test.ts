import { describe, expect, it } from 'vitest'
import { effectiveTimeZone, formatWorldTime, isValidTimeZone } from './time-zone'

describe('world time zone', () => {
  it('validates IANA zones and resolves legacy null to UTC', () => {
    expect(isValidTimeZone('Asia/Tokyo')).toBe(true)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
    expect(isValidTimeZone('+08:00')).toBe(false)
    expect(effectiveTimeZone(null)).toBe('UTC')
  })

  it('formats absolute instants in the requested zone across date boundaries and DST', () => {
    expect(formatWorldTime('2026-01-01T00:30:00.000Z', 'America/Los_Angeles'))
      .toBe('2025-12-31 16:30 (America/Los_Angeles)')
    expect(formatWorldTime('2026-07-01T00:30:00.000Z', 'Asia/Tokyo'))
      .toBe('2026-07-01 09:30 (Asia/Tokyo)')
    expect(formatWorldTime('2026-03-08T10:30:00.000Z', 'America/Los_Angeles'))
      .toBe('2026-03-08 03:30 (America/Los_Angeles)')
  })

  it('keeps invalid instants safe and formats legacy worlds as UTC', () => {
    expect(formatWorldTime('invalid', null)).toBe('未知时间 (UTC)')
    expect(formatWorldTime('2026-01-01T00:00:00.000Z', null)).toBe('2026-01-01 00:00 (UTC)')
  })
})
