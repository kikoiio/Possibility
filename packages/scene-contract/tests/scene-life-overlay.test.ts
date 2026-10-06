import { describe, expect, it } from 'vitest'
import type { SceneLifeOverlay } from '../src/index'

const overlay = {
  timelineId: 'timeline-main',
  simNow: '2026-10-06T00:00:00.000Z',
  weather: null,
  timeOfDay: 'day',
  persons: [{ personId: 'person-ada', locationName: '花房', activity: '整理花草', mood: '平静' }],
  locationStates: [{ locationName: '花房', visualState: '明亮' }],
} satisfies SceneLifeOverlay

describe('SceneLifeOverlay public DTO', () => {
  it('keeps timeline, nullable weather, person projection, and location projection on the wire', () => {
    expect(JSON.parse(JSON.stringify(overlay))).toEqual(overlay)
  })

  it.each(['day', 'dusk', 'night', 'dawn'] as const)('preserves the %s time-of-day discriminator', timeOfDay => {
    const value: SceneLifeOverlay = { ...overlay, timeOfDay }
    expect(value.timeOfDay).toBe(timeOfDay)
  })
})
