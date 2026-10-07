import { describe, expect, it } from 'vitest'
import { createAccountSessionAdapter, type AccountSessionRequestOptions } from '../session-adapter'
import { MIST_MANOR_SCENE } from '../scene'

const capabilities = { read: true, participate: false, chat: true, intervene: true, fork: true, compare: true }

function harness(overrides: Partial<AccountSessionRequestOptions> = {}) {
  const requests: { path: string; method: string; body: unknown }[] = []
  const request: NonNullable<AccountSessionRequestOptions['request']> = async <T>(path: string, options?: RequestInit) => {
    requests.push({ path, method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) : null })
    return {} as T
  }
  const stream: NonNullable<AccountSessionRequestOptions['stream']> = async (path, body, onEvent) => {
    requests.push({ path, method: 'POST SSE', body })
    onEvent({ text: 'reply' })
  }
  const adapter = createAccountSessionAdapter(MIST_MANOR_SCENE, 'account-world', 'main-line', {
    request, stream, capabilities, ...overrides,
  })
  return { adapter, requests }
}

describe('native2d account interactions', () => {
  it('routes chat, intervention, fork, and compare through scoped account APIs', async () => {
    const { adapter, requests } = harness()
    const events: Record<string, unknown>[] = []
    await adapter.chat('你好', 'chat-1', event => events.push(event))
    await adapter.intervene({ expectedVersion: 9, commandId: 'action-1', action: {
      type: 'inform', recipientId: 'resident-1', topic: '提示', content: '请留意花房。',
    } })
    await adapter.fork('fork-1', { name: '分支', whatIf: '如果下雨', changedVariable: '天气改为雨' })
    await adapter.compare('main-line', 'child-line')

    expect(events).toEqual([{ text: 'reply' }])
    expect(requests.map(item => item.path)).toEqual([
      '/api/worlds/account-world/scene',
      '/api/worlds/account-world/actions',
      '/api/worlds/account-world/timelines/main-line/fork',
      '/api/worlds/account-world/compare?left=main-line&right=child-line',
    ])
    expect(requests[1]?.body).toMatchObject({ timelineId: 'main-line', expectedVersion: 9, action: { recipientId: 'resident-1' } })
    expect(requests[2]?.body).toMatchObject({ requestId: 'fork-1', scenario: { name: '分支', changedVariable: '天气改为雨' } })
  })

  it('keeps interaction capabilities disabled for a default observer session', async () => {
    const adapter = createAccountSessionAdapter(MIST_MANOR_SCENE, 'account-world', 'main-line', {
      request: async <T>() => ({} as T),
      stream: async () => undefined,
    })
    await expect(adapter.chat('你好', 'chat-1', () => undefined)).rejects.toMatchObject({ code: 'capability_denied' })
    await expect(adapter.fork('fork-1', { name: '分支', whatIf: '假设', changedVariable: '变量' })).rejects.toMatchObject({ code: 'capability_denied' })
  })
})
