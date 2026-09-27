import { describe, expect, it } from 'vitest'
import { envelopeWorldStreamFrame } from './stream'

describe('world stream ownership envelope', () => {
  it('adds stable ownership, strictly increasing sequence, and nondecreasing state versions', () => {
    const cursor = { streamId: 'stream-a', sequence: 0, lastStateVersion: 4 }
    const frames = [
      envelopeWorldStreamFrame(cursor, 'world-a', 'timeline-a', { type: 'sync' }, 4),
      envelopeWorldStreamFrame(cursor, 'world-a', 'timeline-a', { type: 'event', id: 'event-1' }, 6),
      envelopeWorldStreamFrame(cursor, 'world-a', 'timeline-a', { type: 'state', personId: 'resident' }, 5),
      envelopeWorldStreamFrame(cursor, 'world-a', 'timeline-a', { type: 'clock', simNow: 'now' }, 7),
    ]
    expect(frames.map(frame => frame.sequence)).toEqual([1, 2, 3, 4])
    expect(frames.map(frame => frame.stateVersion)).toEqual([4, 6, 6, 7])
    expect(frames.every(frame => frame.worldId === 'world-a' && frame.timelineId === 'timeline-a'
      && frame.streamId === 'stream-a')).toBe(true)
  })

  it('keeps connection cursors isolated', () => {
    const first = { streamId: 'stream-a', sequence: 0, lastStateVersion: 1 }
    const second = { streamId: 'stream-b', sequence: 0, lastStateVersion: 9 }
    expect(envelopeWorldStreamFrame(first, 'world', 'a', { type: 'sync' }, 1)).toMatchObject({ sequence: 1, streamId: 'stream-a' })
    expect(envelopeWorldStreamFrame(second, 'world', 'b', { type: 'sync' }, 9)).toMatchObject({ sequence: 1, streamId: 'stream-b' })
  })
})
