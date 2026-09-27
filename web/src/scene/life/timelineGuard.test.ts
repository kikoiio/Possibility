import { describe, expect, it } from 'vitest'
import { SceneTimelineGuard } from './timelineGuard'

describe('scene timeline event guard', () => {
  it('accepts only events from the current timeline', () => {
    const guard = new SceneTimelineGuard()
    guard.setTimeline('main')
    expect(guard.accepts('main')).toBe(true)
    expect(guard.accepts('fork')).toBe(false)
    guard.setTimeline('fork')
    expect(guard.accepts('main')).toBe(false)
    expect(guard.accepts('fork')).toBe(true)
  })
})
