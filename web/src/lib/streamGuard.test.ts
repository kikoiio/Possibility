import { describe, expect, it } from 'vitest'
import type { WorldStreamEvent } from '../api/types'
import { createWorldStreamGuard } from './streamGuard'

const frame = (overrides: Partial<WorldStreamEvent> = {}): WorldStreamEvent => ({
  type: 'sync', worldId: 'world-a', timelineId: 'timeline-a', streamId: 'stream-a', sequence: 1, stateVersion: 3,
  ...overrides,
} as WorldStreamEvent)

describe('world stream generation guard', () => {
  it('rejects wrong ownership, stream changes, duplicate sequence, and version regression', () => {
    let generation = 4
    const guard = createWorldStreamGuard({ worldId: 'world-a', timelineId: 'timeline-a', generation: 4,
      isGenerationCurrent: value => value === generation })
    expect(guard.accept(frame())).toBe(true)
    expect(guard.accept(frame({ sequence: 1 }))).toBe(false)
    expect(guard.accept(frame({ sequence: 2, timelineId: 'timeline-b' }))).toBe(false)
    expect(guard.accept(frame({ sequence: 2, streamId: 'stream-b' }))).toBe(false)
    expect(guard.accept(frame({ sequence: 2, stateVersion: 2 }))).toBe(false)
    expect(guard.accept(frame({ sequence: 2, stateVersion: 4 }))).toBe(true)
    generation = 5
    expect(guard.accept(frame({ sequence: 3, stateVersion: 4 }))).toBe(false)
  })

  it('rejects buffered frames after unsubscribe invalidation', () => {
    const guard = createWorldStreamGuard({ worldId: 'world-a', timelineId: 'timeline-a', generation: 1,
      isGenerationCurrent: () => true })
    guard.invalidate()
    expect(guard.accept(frame())).toBe(false)
  })
})
