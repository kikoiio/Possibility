import { describe, expect, it, vi } from 'vitest'
import { browserTimeZone, effectiveTimeZone, formatWorldTime } from './world-time'

describe('world time formatting', () => {
  it('formats the same instant in an explicit zone across date boundaries and DST', () => {
    expect(formatWorldTime('2026-01-01T00:30:00.000Z', 'America/Los_Angeles'))
      .toBe('2025-12-31 16:30 (America/Los_Angeles)')
    expect(formatWorldTime('2026-03-08T10:30:00.000Z', 'America/Los_Angeles'))
      .toBe('2026-03-08 03:30 (America/Los_Angeles)')
  })

  it('submits the browser zone and falls back to UTC when browser zone discovery fails', () => {
    const expected = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(browserTimeZone()).toBe(expected)
    const stub = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new Error('unsupported') })
    try { expect(browserTimeZone()).toBe('UTC') } finally { stub.mockRestore() }
  })

  it('uses UTC for missing or invalid zones and safely labels invalid instants', () => {
    expect(effectiveTimeZone(null)).toBe('UTC')
    expect(effectiveTimeZone('Not/AZone')).toBe('UTC')
    expect(effectiveTimeZone('+08:00')).toBe('UTC')
    expect(formatWorldTime('2026-01-01T00:00:00.000Z', null)).toBe('2026-01-01 00:00 (UTC)')
    expect(formatWorldTime('invalid', 'Asia/Tokyo')).toBe('未知时间 (Asia/Tokyo)')
  })
})
