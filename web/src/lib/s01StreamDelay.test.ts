import { expect, it } from 'vitest'
import type { WorldStreamEvent } from '../api/types'
import { createSseParser } from './sseParser'
import { createWorldStreamGuard } from './streamGuard'

/** Controlled SSE frame that pauses after half its JSON payload has entered the parser buffer.
 * （原 scripts/fixtures/s01-stream-delay.ts,仓库收尾时误删,内联回本测试） */
function createS01StreamDelayFixture(frame: Record<string, unknown>) {
  const encoded = `data: ${JSON.stringify(frame)}\n\n`
  const midpoint = Math.max(1, Math.floor(encoded.length / 2))
  let release!: (chunk: string) => void
  let reject!: (error: Error) => void
  let released = false
  const remainder = new Promise<string>((resolve, rejectPromise) => { release = resolve; reject = rejectPromise })
  return {
    firstChunk: encoded.slice(0, midpoint),
    async *chunks() {
      yield encoded.slice(0, midpoint)
      yield await remainder
    },
    release() {
      if (released) throw new Error('S01 delayed frame was already released')
      released = true
      release(encoded.slice(midpoint))
    },
    fail() {
      if (released) throw new Error('S01 delayed frame was already released')
      released = true
      reject(new Error('S01 delayed frame fixture failed'))
    },
  }
}

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
