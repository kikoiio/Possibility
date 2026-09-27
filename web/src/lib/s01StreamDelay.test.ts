import { expect, it } from 'vitest'
import type { WorldStreamEvent } from '../api/types'
import { createS01StreamDelayFixture } from '../../../scripts/fixtures/s01-stream-delay'
import { createSseParser } from './sseParser'
import { createWorldStreamGuard } from './streamGuard'

it('drops the remaining buffered old-timeline SSE frame after switch without changing URL, version, or events', async () => {
  let generation = 1
  let state = { url: '/worlds/world-a?timeline=timeline-old', timelineId: 'timeline-old', version: 4,
    eventIds: ['old-existing-event'] }
  const beforeOldTail = { ...state, eventIds: [...state.eventIds] }
  const parser = createSseParser()
  const guard = createWorldStreamGuard({ worldId: 'world-a', timelineId: 'timeline-old', generation: 1,
    isGenerationCurrent: expected => expected === generation })
  const delayed = createS01StreamDelayFixture({ type: 'event', worldId: 'world-a', timelineId: 'timeline-old',
    streamId: 'old-stream', sequence: 2, stateVersion: 5,
    event: { id: 'must-not-appear', title: 'stale event' } })
  const chunks = delayed.chunks()
  const first = await chunks.next()
  expect(first.value).toBe(delayed.firstChunk)
  expect(parser.push(first.value!)).toEqual([])

  generation++
  state = { url: '/worlds/world-a?timeline=timeline-new', timelineId: 'timeline-new', version: 8,
    eventIds: ['new-timeline-event'] }
  guard.invalidate()
  delayed.release()

  const tail = await chunks.next()
  const frames = parser.push(tail.value!)
  for (const parsed of frames) {
    const event = JSON.parse(parsed.data) as WorldStreamEvent
    if (guard.accept(event)) state = { ...state, version: event.stateVersion, eventIds: [
      ...state.eventIds, (event as unknown as { event?: { id?: string } }).event?.id ?? '',
    ].filter(Boolean) }
  }
  expect(state).toEqual({ ...beforeOldTail, url: '/worlds/world-a?timeline=timeline-new',
    timelineId: 'timeline-new', version: 8, eventIds: ['new-timeline-event'] })
})
