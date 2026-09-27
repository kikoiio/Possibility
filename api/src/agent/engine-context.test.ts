import { describe, expect, it } from 'vitest'
import { currentScheduleItem, isAwake, type ScheduleItem } from './engine-context'

const nightShift: ScheduleItem[] = [
  { start: '23:00', end: '07:00', location: 'Home', activity: 'Sleeping', kind: 'sleep' },
]

describe('schedule clock timezone', () => {
  it('interprets timeline instants in UTC, including offsets across midnight', () => {
    // 04:30 at +05:00 is 23:30 UTC on the prior date.
    expect(currentScheduleItem(nightShift, '2030-01-02T04:30:00+05:00')).toMatchObject({ kind: 'sleep' })
    expect(isAwake(nightShift, '2030-01-02T04:30:00+05:00')).toBe(false)
  })

  it('uses the same UTC clock for equivalent instants written with different offsets', () => {
    const utc = '2030-01-01T23:30:00Z'
    const offset = '2030-01-02T04:30:00+05:00'
    expect(currentScheduleItem(nightShift, utc)).toEqual(currentScheduleItem(nightShift, offset))
  })

  it('does not match a schedule for an invalid simulation timestamp', () => {
    expect(currentScheduleItem(nightShift, 'not-a-timestamp')).toBeNull()
    expect(isAwake(nightShift, 'not-a-timestamp')).toBe(true)
  })
})
