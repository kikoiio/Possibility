/**
 * N2D1 T07–T09：world-source 定向行为验证。
 * T07 固定来源适配 / T08 公开 GET 与身份适配 / T09 固定时间线与读取失败。
 */

import { describe, expect, it } from 'vitest'
import type { SourceConfig } from '../types'
import { createFixtureReadModel } from '../fixtures'
import { MIST_MANOR_SCENE, createMistManorScene } from '../scene'
import { createWorldSource } from '../world-source'

const scene = MIST_MANOR_SCENE

function abortedSignal(): AbortSignal {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

describe('T07 固定来源适配', () => {
  it('不发起网络请求，产出模型身份与场景一致', async () => {
    const requests: string[] = []
    const spyFetch = (async (input: unknown) => {
      requests.push(String(input))
      throw new Error('固定来源不应发起网络请求')
    }) as unknown as typeof fetch

    const source = createWorldSource(
      { kind: 'fixture', fixtureId: 'mist-manor-day' },
      scene,
      { fetch: spyFetch },
    )
    const model = await source.load(new AbortController().signal)

    expect(requests).toEqual([])
    expect(model.scope).toEqual({
      source: 'fixture',
      worldId: 'fixture-world-mist-manor',
      timelineId: 'fixture-timeline-mist-manor-001',
      sceneId: scene.id,
      sceneVersion: scene.version,
    })
    expect(model.worldName).toBe('雾影庄')
    expect(model.simNow).toBe('2026-01-15T04:00:00.000Z')
    expect(model.residents.length).toBeGreaterThan(0)
    expect(model.locations.length).toBeGreaterThan(0)
  })

  it('同一输入身份与时间稳定，且每次返回全新对象', async () => {
    const source = createWorldSource({ kind: 'fixture', fixtureId: 'mist-manor-day' }, scene)
    const first = await source.load(new AbortController().signal)
    const second = await source.load(new AbortController().signal)

    expect(second.scope).toEqual(first.scope)
    expect(second.simNow).toBe(first.simNow)
    expect(second.stateVersion).toBe(first.stateVersion)
    expect(second).not.toBe(first)
    expect(second.residents).not.toBe(first.residents)
    expect(second.locations).not.toBe(first.locations)

    // 对第一次结果的（违规）修改不污染后续读取。
    ;(first.residents[0] as unknown as { name: string }).name = '被篡改'
    const third = await source.load(new AbortController().signal)
    expect(third.residents[0].name).not.toBe('被篡改')
  })

  it('中止后不报告成功', async () => {
    const source = createWorldSource({ kind: 'fixture', fixtureId: 'mist-manor-day' }, scene)
    await expect(source.load(abortedSignal())).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('固定快照与场景版本不一致时明确失败', async () => {
    const mismatchedScene = { ...createMistManorScene(), version: 99 }
    const source = createWorldSource(
      { kind: 'fixture', fixtureId: 'mist-manor-day' },
      mismatchedScene,
    )
    await expect(source.load(new AbortController().signal)).rejects.toThrow('不一致')
  })

  it('未知 fixtureId 在创建时明确失败', () => {
    expect(() =>
      createWorldSource({ kind: 'fixture', fixtureId: 'no-such-fixture' }, scene),
    ).toThrow('未知的固定快照')
  })
})

/* -------------------------------------------------------------------------- */
/* 公开来源 stub fetch 工具                                                     */
/* -------------------------------------------------------------------------- */

interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly credentials: string
}

type StubHandler = (url: string) => Response | Promise<Response>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createStubFetch(handler: StubHandler): {
  fetchImpl: typeof fetch
  requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : String(input)
    requests.push({
      url,
      method: init?.method ?? 'GET',
      credentials: init?.credentials ?? 'same-origin',
    })
    return handler(url)
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

interface SnapshotOverrides {
  readonly worldId?: string
  readonly worldName?: string
  readonly timelineId?: string
  readonly simNow?: string | null
  readonly timeZone?: string
  readonly stateVersion?: number
  readonly locationBoard?: unknown
  readonly locations?: unknown
}

/** 与 api/src/public/routes.ts 的 worldSnapshot 同构的最小公开快照响应体。 */
function snapshotBody(overrides: SnapshotOverrides = {}): Record<string, unknown> {
  const worldId = overrides.worldId ?? 'demo-world-mist-manor'
  const timelineId = overrides.timelineId ?? 'demo-timeline-mist-manor-001'
  return {
    world: {
      id: worldId,
      name: overrides.worldName ?? '雾影庄',
      description: '雾影庄公开演示世界。',
      status: 'running',
      pauseReason: null,
      isDemo: true,
      callsToday: 0,
      locations: overrides.locations ?? [
        { name: '大厅', description: '迎客厅。' },
        { name: '后山散步道', description: '通往温泉的山径。' },
      ],
      timeZone: overrides.timeZone ?? 'Asia/Tokyo',
    },
    timelines: [
      {
        id: timelineId,
        parentTimelineId: null,
        status: 'active',
        simNow: '2026-01-15T04:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        forkScenario: null,
      },
    ],
    currentTimelineId: timelineId,
    simNow: overrides.simNow === undefined ? '2026-01-15T04:00:00.000Z' : overrides.simNow,
    timeZone: overrides.timeZone ?? 'Asia/Tokyo',
    stateVersion: overrides.stateVersion ?? 7,
    worldModelVersion: null,
    evidenceStatus: 'legacy',
    evidence: { level: 'unassessed', reasonCodes: [] },
    currentFacts: [],
    locationBoard: overrides.locationBoard ?? [
      {
        location: '大厅',
        persons: [
          { id: 'person-sayo', name: '小夜', activity: '为住客们准备热茶' },
          { id: 'person-mugino-toru', name: '雾野 透', activity: '' },
        ],
      },
      {
        location: '后山散步道',
        persons: [{ id: 'person-shirakawa-rei', name: '白川 怜', activity: '沿山径独自散步' }],
      },
    ],
    events: [],
  }
}

function demoBody(overrides: { id?: string; name?: string } = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? 'demo-world-mist-manor',
    name: overrides.name ?? '雾影庄',
    description: '雾影庄公开演示世界。',
  }
}

describe('T08 公开 GET 与身份适配', () => {
  it('显式 worldId 直接读取快照，身份与时间字段一致', async () => {
    const { fetchImpl, requests } = createStubFetch(() => jsonResponse(snapshotBody()))
    const config: SourceConfig = { kind: 'public', worldId: 'demo-world-mist-manor' }
    const source = createWorldSource(config, scene, { fetch: fetchImpl })

    const model = await source.load(new AbortController().signal)

    expect(requests).toEqual([
      {
        url: '/api/public/worlds/demo-world-mist-manor',
        method: 'GET',
        credentials: 'omit',
      },
    ])
    expect(model.scope).toEqual({
      source: 'public',
      worldId: 'demo-world-mist-manor',
      timelineId: 'demo-timeline-mist-manor-001',
      sceneId: scene.id,
      sceneVersion: scene.version,
    })
    expect(model.worldName).toBe('雾影庄')
    expect(model.simNow).toBe('2026-01-15T04:00:00.000Z')
    expect(model.timeZone).toBe('Asia/Tokyo')
    expect(model.stateVersion).toBe(7)
    expect(model.locations).toEqual([
      { name: '大厅', description: '迎客厅。' },
      { name: '后山散步道', description: '通往温泉的山径。' },
    ])
  })

  it('从 locationBoard 提取居民，空活动保留为 null', async () => {
    const { fetchImpl } = createStubFetch(() => jsonResponse(snapshotBody()))
    const source = createWorldSource(
      { kind: 'public', worldId: 'demo-world-mist-manor' },
      scene,
      { fetch: fetchImpl },
    )
    const model = await source.load(new AbortController().signal)

    expect(model.residents).toEqual([
      {
        personId: 'person-sayo',
        name: '小夜',
        locationName: '大厅',
        activity: '为住客们准备热茶',
      },
      { personId: 'person-mugino-toru', name: '雾野 透', locationName: '大厅', activity: null },
      {
        personId: 'person-shirakawa-rei',
        name: '白川 怜',
        locationName: '后山散步道',
        activity: '沿山径独自散步',
      },
    ])
  })

  it('未配置 worldId 时先发现再读取，只发允许的公开 GET', async () => {
    const { fetchImpl, requests } = createStubFetch((url) => {
      if (url === '/api/public/demo') return jsonResponse(demoBody())
      if (url === '/api/public/worlds/demo-world-mist-manor') {
        return jsonResponse(snapshotBody())
      }
      return jsonResponse({ error: '不存在' }, 404)
    })
    const source = createWorldSource({ kind: 'public' }, scene, { fetch: fetchImpl })

    const model = await source.load(new AbortController().signal)

    expect(requests.map((r) => r.url)).toEqual([
      '/api/public/demo',
      '/api/public/worlds/demo-world-mist-manor',
    ])
    for (const request of requests) {
      expect(request.method).toBe('GET')
      expect(request.credentials).toBe('omit')
    }
    expect(model.scope.worldId).toBe('demo-world-mist-manor')
    expect(model.scope.timelineId).toBe('demo-timeline-mist-manor-001')
  })

  it('发现的演示世界不是雾影庄时明确失败，不继续读取', async () => {
    const { fetchImpl, requests } = createStubFetch((url) => {
      if (url === '/api/public/demo') return jsonResponse(demoBody({ name: '阳光花园' }))
      return jsonResponse(snapshotBody())
    })
    const source = createWorldSource({ kind: 'public' }, scene, { fetch: fetchImpl })

    await expect(source.load(new AbortController().signal)).rejects.toThrow('不是雾影庄')
    expect(requests.map((r) => r.url)).toEqual(['/api/public/demo'])
  })

  it('快照身份与请求世界不一致时明确失败', async () => {
    const { fetchImpl } = createStubFetch(() =>
      jsonResponse(snapshotBody({ worldId: 'another-world', worldName: '雾影庄分馆' })),
    )
    const source = createWorldSource(
      { kind: 'public', worldId: 'demo-world-mist-manor' },
      scene,
      { fetch: fetchImpl },
    )
    await expect(source.load(new AbortController().signal)).rejects.toThrow('身份')
  })

  it('畸形响应明确失败：缺少 locationBoard / world.id / currentTimelineId', async () => {
    const cases: Record<string, unknown>[] = [
      { ...snapshotBody(), locationBoard: undefined },
      { ...snapshotBody(), world: { name: '雾影庄' } },
      { ...snapshotBody(), currentTimelineId: 42 },
      { ...snapshotBody(), timelines: 'not-an-array' },
    ]
    for (const body of cases) {
      const { fetchImpl } = createStubFetch(() => jsonResponse(body))
      const source = createWorldSource(
        { kind: 'public', worldId: 'demo-world-mist-manor' },
        scene,
        { fetch: fetchImpl },
      )
      await expect(source.load(new AbortController().signal)).rejects.toThrow('结构不完整')
    }
  })

  it('时区经 effectiveTimeZone 归一，非法时区回退 UTC', async () => {
    const { fetchImpl } = createStubFetch(() =>
      jsonResponse(snapshotBody({ timeZone: '+09:00' })),
    )
    const source = createWorldSource(
      { kind: 'public', worldId: 'demo-world-mist-manor' },
      scene,
      { fetch: fetchImpl },
    )
    const model = await source.load(new AbortController().signal)
    expect(model.timeZone).toBe('UTC')
  })

  it('simNow 缺失时保留 null（未知时间）', async () => {
    const { fetchImpl } = createStubFetch(() => jsonResponse(snapshotBody({ simNow: null })))
    const source = createWorldSource(
      { kind: 'public', worldId: 'demo-world-mist-manor' },
      scene,
      { fetch: fetchImpl },
    )
    const model = await source.load(new AbortController().signal)
    expect(model.simNow).toBeNull()
  })
})

describe('T09 固定时间线与读取失败', () => {
  it('首次成功后固定时间线，后续刷新携带同一时间线且不重新发现', async () => {
    const snapshots = [
      snapshotBody({ stateVersion: 7 }),
      snapshotBody({ stateVersion: 9 }),
    ]
    let worldCalls = 0
    const { fetchImpl, requests } = createStubFetch((url) => {
      if (url === '/api/public/demo') return jsonResponse(demoBody())
      if (url.startsWith('/api/public/worlds/')) {
        const body = snapshots[Math.min(worldCalls, snapshots.length - 1)]
        worldCalls += 1
        return jsonResponse(body)
      }
      return jsonResponse({ error: '不存在' }, 404)
    })
    const source = createWorldSource({ kind: 'public' }, scene, { fetch: fetchImpl })

    const first = await source.load(new AbortController().signal)
    const second = await source.load(new AbortController().signal)

    expect(first.stateVersion).toBe(7)
    expect(second.stateVersion).toBe(9)
    expect(second.scope.timelineId).toBe('demo-timeline-mist-manor-001')
    expect(requests.map((r) => r.url)).toEqual([
      '/api/public/demo',
      '/api/public/worlds/demo-world-mist-manor',
      '/api/public/worlds/demo-world-mist-manor?timelineId=demo-timeline-mist-manor-001',
    ])
  })

  it('响应时间线与已固定时间线不匹配时明确失败，固定范围不丢失', async () => {
    const snapshots = [
      snapshotBody({ timelineId: 'tl-1', stateVersion: 7 }),
      snapshotBody({ timelineId: 'tl-2', stateVersion: 8 }),
      snapshotBody({ timelineId: 'tl-1', stateVersion: 9 }),
    ]
    let worldCalls = 0
    const { fetchImpl, requests } = createStubFetch(() => {
      const body = snapshots[Math.min(worldCalls, snapshots.length - 1)]
      worldCalls += 1
      return jsonResponse(body)
    })
    const source = createWorldSource(
      { kind: 'public', worldId: 'demo-world-mist-manor' },
      scene,
      { fetch: fetchImpl },
    )

    await source.load(new AbortController().signal)
    await expect(source.load(new AbortController().signal)).rejects.toThrow('时间线已变化')
    // 固定范围未跳到 tl-2：第三次请求仍携带 tl-1 并可成功。
    const third = await source.load(new AbortController().signal)
    expect(third.scope.timelineId).toBe('tl-1')
    expect(third.stateVersion).toBe(9)
    expect(requests.map((r) => r.url)).toEqual([
      '/api/public/worlds/demo-world-mist-manor',
      '/api/public/worlds/demo-world-mist-manor?timelineId=tl-1',
      '/api/public/worlds/demo-world-mist-manor?timelineId=tl-1',
    ])
  })

  it('首次读取失败不错误固定范围，可重试成功', async () => {
    let worldCalls = 0
    const { fetchImpl, requests } = createStubFetch((url) => {
      if (url === '/api/public/demo') return jsonResponse(demoBody())
      worldCalls += 1
      if (worldCalls === 1) return jsonResponse({ error: '服务器错误' }, 500)
      return jsonResponse(snapshotBody({ stateVersion: 7 }))
    })
    const source = createWorldSource({ kind: 'public' }, scene, { fetch: fetchImpl })

    await expect(source.load(new AbortController().signal)).rejects.toThrow('HTTP 500')
    const model = await source.load(new AbortController().signal)
    expect(model.scope.timelineId).toBe('demo-timeline-mist-manor-001')
    // 重试直接读取已发现的世界（不重复发现），成功后才固定时间线。
    expect(requests.map((r) => r.url)).toEqual([
      '/api/public/demo',
      '/api/public/worlds/demo-world-mist-manor',
      '/api/public/worlds/demo-world-mist-manor',
    ])
  })

  it('发现失败可重试，不残留固定范围', async () => {
    let demoCalls = 0
    const { fetchImpl } = createStubFetch((url) => {
      if (url === '/api/public/demo') {
        demoCalls += 1
        if (demoCalls === 1) return jsonResponse({ error: '演示世界不存在' }, 404)
        return jsonResponse(demoBody())
      }
      return jsonResponse(snapshotBody())
    })
    const source = createWorldSource({ kind: 'public' }, scene, { fetch: fetchImpl })

    await expect(source.load(new AbortController().signal)).rejects.toThrow('HTTP 404')
    const model = await source.load(new AbortController().signal)
    expect(model.worldName).toBe('雾影庄')
    expect(demoCalls).toBe(2)
  })

  it('网络失败给出可理解的中文错误', async () => {
    const { fetchImpl } = createStubFetch(() => {
      throw new TypeError('fetch failed')
    })
    const source = createWorldSource(
      { kind: 'public', worldId: 'demo-world-mist-manor' },
      scene,
      { fetch: fetchImpl },
    )
    await expect(source.load(new AbortController().signal)).rejects.toThrow('网络错误')
  })

  it('非 JSON 响应明确失败', async () => {
    const { fetchImpl } = createStubFetch(
      () => new Response('<html>bad gateway</html>', { status: 200 }),
    )
    const source = createWorldSource(
      { kind: 'public', worldId: 'demo-world-mist-manor' },
      scene,
      { fetch: fetchImpl },
    )
    await expect(source.load(new AbortController().signal)).rejects.toThrow('JSON')
  })

  it('中止不产生伪成功也不当读取失败', async () => {
    // 信号在请求前已中止。
    const { fetchImpl, requests } = createStubFetch(() => jsonResponse(snapshotBody()))
    const source = createWorldSource(
      { kind: 'public', worldId: 'demo-world-mist-manor' },
      scene,
      { fetch: fetchImpl },
    )
    await expect(source.load(abortedSignal())).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests).toEqual([])

    // fetch 被中止（reject AbortError）：原样抛 AbortError，不包成中文读取失败。
    const abortingFetch = (async () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      throw error
    }) as unknown as typeof fetch
    const source2 = createWorldSource(
      { kind: 'public', worldId: 'demo-world-mist-manor' },
      scene,
      { fetch: abortingFetch },
    )
    const rejection = await source2.load(new AbortController().signal).then(
      () => null,
      (error: unknown) => error,
    )
    expect(rejection).toMatchObject({ name: 'AbortError' })
    expect((rejection as Error).message).not.toContain('网络错误')

    // 响应到达后信号已中止：不报告成功。
    const controller = new AbortController()
    const lateAbortFetch = (async (_input: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => undefined)
      controller.abort()
      return jsonResponse(snapshotBody())
    }) as unknown as typeof fetch
    const source3 = createWorldSource(
      { kind: 'public', worldId: 'demo-world-mist-manor' },
      scene,
      { fetch: lateAbortFetch },
    )
    await expect(source3.load(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('原始输入不被更改：config 与 fixtures 快照保持原样', async () => {
    const config: SourceConfig = { kind: 'public' }
    const configBefore = JSON.parse(JSON.stringify(config)) as unknown
    const fixtureBefore = JSON.parse(
      JSON.stringify(createFixtureReadModel('public-mist-manor-day')),
    ) as unknown

    const { fetchImpl } = createStubFetch((url) => {
      if (url === '/api/public/demo') return jsonResponse(demoBody())
      return jsonResponse(snapshotBody())
    })
    const source = createWorldSource(config, scene, { fetch: fetchImpl })
    await source.load(new AbortController().signal)
    await source.load(new AbortController().signal)

    expect(JSON.parse(JSON.stringify(config))).toEqual(configBefore)
    expect(
      JSON.parse(JSON.stringify(createFixtureReadModel('public-mist-manor-day'))),
    ).toEqual(fixtureBefore)
  })
})
