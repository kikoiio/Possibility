import { afterEach, describe, expect, it, vi } from 'vitest'
import { authApi, chatApi, demoApi, getGuestToken, sceneApi, setGuestToken, setToken } from './client'
import type { CatchupEvent, ChatMessageEvent, SceneEvent } from './types'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function sseResponse(...frames: (unknown | string)[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        const data = typeof frame === 'string' ? frame : JSON.stringify(frame)
        controller.enqueue(encoder.encode(`data: ${data}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function stubSse(frames: (unknown | string)[]) {
  vi.stubGlobal('localStorage', new MemoryStorage())
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => sseResponse(...frames))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('typed POST SSE endpoints', () => {
  it('decodes chat route events and ignores malformed JSON and unknown event kinds', async () => {
    const fetchMock = stubSse([
      '{not-json',
      { type: 'future-event', payload: 1 },
      { type: 'text', delta: 'hello', replayed: true },
      { type: 'pending', requestId: 'request-1' },
      { type: 'error', message: 'try again', requestId: 'request-1', errorCode: 'retryable' },
      { type: 'done', requestId: 'request-1', replayed: true },
    ])
    const events: ChatMessageEvent[] = []

    await chatApi.send('conversation/a', 'hello', 'request-1', event => events.push(event))

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/conversations/conversation%2Fa/messages')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ content: 'hello', requestId: 'request-1' })
    expect(events).toEqual([
      { type: 'text', delta: 'hello', replayed: true },
      { type: 'pending', requestId: 'request-1' },
      { type: 'error', message: 'try again', requestId: 'request-1', errorCode: 'retryable' },
      { type: 'done', requestId: 'request-1', replayed: true },
    ])
  })

  it('decodes catchup agent events and its skipped route event', async () => {
    stubSse([
      { type: 'state', state: { simTime: '2026-10-01T00:00:00.000Z', location: 'home', activity: 'resting', mood: 'calm', goal: 'sleep' } },
      { type: 'skipped' },
      { type: 'done' },
    ])
    const events: CatchupEvent[] = []

    await chatApi.catchup('conversation-1', event => events.push(event))

    expect(events.map(event => event.type)).toEqual(['state', 'skipped', 'done'])

    stubSse([{ type: 'memory', id: 'memory-1', content: 'private detail' }])
    await expect(chatApi.catchup('conversation-1', () => undefined))
      .rejects.toMatchObject({ name: 'SseProtocolError' })
  })

  it('rejects malformed known scene events and propagates consumer exceptions', async () => {
    stubSse([{ type: 'utterance', personId: 'person-1', name: 'Ada' }])
    await expect(sceneApi.send('world-1', { timelineId: 'timeline-1', content: 'hello' }, () => undefined))
      .rejects.toMatchObject({ name: 'SseProtocolError' })

    stubSse([{ type: 'scene_start', dialogueId: 'dialogue-1', location: 'home', participants: ['Ada'] } satisfies SceneEvent])
    await expect(sceneApi.send('world-1', { timelineId: 'timeline-1', content: 'hello' }, () => {
      throw new Error('consumer failed')
    })).rejects.toThrow('consumer failed')
  })
})

describe('explicit claim identity', () => {
  it('does not attach guest identity to login and preserves it on authentication failure', async () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    setGuestToken('guest-token')
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('X-Possibility-Guest')).toBe(false)
      return { ok: false, status: 401, json: async () => ({ error: '密码错误' }) } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(authApi.login({ username: 'alice', password: 'wrong' })).rejects.toMatchObject({ status: 401 })
    expect(getGuestToken()).toBe('guest-token')
  })

  it('sends account and source copy identities to status, claim and recover', async () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    setToken('account-token'); setGuestToken('guest-token')
    const requests: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {})
      return { ok: true, status: 200, json: async () => ({ kind: 'retryable', epoch: 1, safeToSwitch: true }) } as Response
    }))
    const binding = { sessionId: 's', worldId: 'w', generation: 2 }
    await demoApi.claimStatus({ requestId: 'r', expectedBinding: binding })
    await demoApi.claim({ requestId: 'r', expectedEpoch: 0, expectedBinding: binding })
    await demoApi.recoverClaim({ requestId: 'r', observedEpoch: 0, observedExecutionId: null, expectedBinding: binding })
    for (const request of requests) {
      const headers = new Headers(request.headers)
      expect(headers.get('Authorization')).toBe('Bearer account-token')
      expect(headers.get('X-Possibility-Guest')).toBe('guest-token')
    }
    expect(new Headers(requests[0].headers).get('Cache-Control')).toBeNull()
  })
})
// End of the explicit identity client tests.
