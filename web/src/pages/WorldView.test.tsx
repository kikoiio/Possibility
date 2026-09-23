import { describe, expect, it } from 'vitest'
import { timelineHref, withTimelineParam } from '../lib/timelineUrl'
import { isTimelineUpdateCurrent } from '../lib/timelineGuard'

describe('world timeline URL', () => {
  it('keeps the selected timeline in the query while preserving other parameters', () => {
    const next = withTimelineParam(new URLSearchParams('view=observe&timeline=old'), 'child-line')
    expect(next.get('view')).toBe('observe')
    expect(next.get('timeline')).toBe('child-line')
  })

  it('removes the selected timeline when returning to the default timeline', () => {
    const next = withTimelineParam(new URLSearchParams('timeline=child-line&view=observe'), null)
    expect(next.get('timeline')).toBeNull()
    expect(next.get('view')).toBe('observe')
  })

  it('builds chat and world links with the same timeline', () => {
    expect(timelineHref('/people/resident-1', 'child line'))
      .toBe('/people/resident-1?timeline=child+line')
    expect(timelineHref('/worlds/world-1', 'child line'))
      .toBe('/worlds/world-1?timeline=child+line')
  })
})

describe('world timeline async result guard', () => {
  it('rejects an active response after the selected timeline changes', () => {
    expect(isTimelineUpdateCurrent(true, 'main', 'child', 'main')).toBe(false)
  })

  it('rejects callbacks from a cleaned-up subscription and mismatched snapshots', () => {
    expect(isTimelineUpdateCurrent(false, 'main', 'main', 'main')).toBe(false)
    expect(isTimelineUpdateCurrent(true, 'main', 'main', 'child')).toBe(false)
  })

  it('accepts results for the selected timeline and the default timeline request', () => {
    expect(isTimelineUpdateCurrent(true, 'child', 'child', 'child')).toBe(true)
    expect(isTimelineUpdateCurrent(true, null, null, 'main')).toBe(true)
  })
})
