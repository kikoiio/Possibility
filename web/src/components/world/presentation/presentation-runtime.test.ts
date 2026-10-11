import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { SerializedVoxelSpaces } from '@possibility/voxel-contract'
import type { MapBootstrap, MapScene } from '../../../api/map'
import type { WorldSnapshot } from '../../../api/types'

vi.mock('../../../api/client', () => ({
  authApi: { me: vi.fn(async () => ({ user: { id: 'user-1', username: 'neo' } })) },
  guestMapApi: { bootstrap: vi.fn() },
  mapApi: { bootstrap: vi.fn() },
  publicApi: { snapshot: vi.fn(), scene: vi.fn() },
}))
vi.mock('../native2d/WorldPresentationAdapter', () => ({
  createNative2dPresentationAdapter: vi.fn((source: unknown) => ({ kind: 'native2d', supports: () => true, source, mount: vi.fn() })),
}))
vi.mock('./VoxelPresentationAdapter', () => ({
  createVoxelPresentationAdapter: vi.fn((resolve: unknown) => ({ kind: 'voxel3d', supports: () => true, resolve, mount: vi.fn() })),
}))

import { authApi, guestMapApi, mapApi, publicApi } from '../../../api/client'
import { createPresentationRuntime } from './presentation-runtime'
import type { PaneSessionLoader, PaneUnsupported, PaneWorldData } from './presentation-types'

async function expectWorldData(promise: ReturnType<PaneSessionLoader>): Promise<PaneWorldData> {
  const loaded = await promise
  if ('kind' in loaded && loaded.kind === 'unsupported') {
    throw new Error(`unexpected unsupported (${loaded.code}): ${loaded.reason}`)
  }
  return loaded as PaneWorldData
}

const mockedAuthMe = vi.mocked(authApi.me)
const mockedGuestBootstrap = vi.mocked(guestMapApi.bootstrap)
const mockedMapBootstrap = vi.mocked(mapApi.bootstrap)
const mockedPublicSnapshot = vi.mocked(publicApi.snapshot)
const mockedPublicScene = vi.mocked(publicApi.scene)

function snapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    world: {
      id: 'w1', name: '雾影庄', description: '', status: 'running', pauseReason: null,
      isDemo: false, callsToday: 0,
      locations: [{ name: '大厅', description: '主楼大厅' }],
      timeZone: 'Asia/Shanghai',
    },
    timelines: [{ id: 'main', parentTimelineId: null, forkScenario: null, simNow: '2026-10-07T12:00:00Z', createdAt: '2026-10-01T00:00:00Z' }],
    currentTimelineId: 'main',
    simNow: '2026-10-07T12:00:00Z',
    timeZone: 'Asia/Shanghai',
    stateVersion: 7,
    worldModelVersion: null,
    evidenceStatus: 'structured',
    evidence: { level: 'complete', reasonCodes: [] },
    currentFacts: [],
    locationBoard: [{ location: '大厅', persons: [{ id: 'p1', name: '千鹤', activity: '整理书稿' }] }],
    events: [],
    ...overrides,
  } as WorldSnapshot
}

function spacesEnvelope(): SerializedVoxelSpaces {
  return {
    format: 'voxel-spaces',
    version: 1,
    defaultSpaceId: 'exterior',
    spaces: [
      {
        id: 'exterior', name: '外景',
        document: {
          format: 'voxel-document', version: 1, id: 'scene-1', theme: 'mist-manor',
          size: { width: 10, height: 6, depth: 10 }, sections: {},
          objects: [{ id: 'obj-house', objectType: 'manor-main-house', anchor: { x: 3, y: 1, z: 3 }, rotation: 0 }],
          objectCells: [{ objectId: 'obj-house', cells: [{ x: 3, y: 1, z: 3 }] }],
          locations: [{ name: '大厅', objectId: 'obj-house' }],
          spaceEntries: [{ spaceId: 'main-house-interior', label: '进入主楼 →', at: { x: 3, y: 1, z: 4 } }],
          lockedObjectIds: ['obj-house'],
        },
      },
      {
        id: 'main-house-interior', name: '主楼内厅',
        document: {
          format: 'voxel-document', version: 1, id: 'scene-1', theme: 'mist-manor',
          size: { width: 6, height: 5, depth: 6 }, sections: {},
          objects: [], objectCells: [],
          locations: [], spaceEntries: [{ spaceId: 'exterior', label: '回到庭院 →', at: { x: 2, y: 1, z: 3 } }],
          lockedObjectIds: [],
        },
      },
    ],
  }
}

function bootstrap(overrides: Partial<MapBootstrap> = {}): MapBootstrap {
  return {
    access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
    world: snapshot(),
    scene: { status: 'ready', document: spacesEnvelope(), version: 4 },
    presentation: {
      timelineId: 'main', stateVersion: 7, simNow: '2026-10-07T12:00:00Z', timeOfDay: 'day',
      weather: { kind: null, label: null }, residents: [], locations: [], signals: [],
    },
    theme: { id: 'mist-manor', assetVersion: 'current' },
    resume: { worldId: 'w1', timelineId: 'main', spaceId: 'main-house-interior', mode: 'life', updatedAt: '2026-10-07T00:00:00Z' },
    ...overrides,
  } as MapBootstrap
}

const accountTarget = { worldId: 'w1', presentation: 'voxel3d' as const }

beforeEach(() => {
  mockedMapBootstrap.mockResolvedValue(bootstrap())
  mockedGuestBootstrap.mockResolvedValue(bootstrap())
  mockedPublicSnapshot.mockResolvedValue(snapshot())
  mockedPublicScene.mockResolvedValue({ status: 'ready', scope: { worldId: 'w1', timelineId: 'main', representation: 'voxel' }, revisionId: 'rev-1', version: 4, contentHash: 'hash', createdAt: '2026-10-01T00:00:00Z', document: spacesEnvelope() } as Awaited<ReturnType<typeof publicApi.scene>>)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('presentation runtime pane reader', () => {
  it('assembles the context from one authorized read, defaulting the space to exterior', async () => {
    const { loadSession } = createPresentationRuntime('account')
    const data = await expectWorldData(loadSession(accountTarget, new AbortController().signal))
    expect(mockedMapBootstrap).toHaveBeenCalledWith('w1', undefined, expect.any(AbortSignal))
    expect(mockedAuthMe).toHaveBeenCalled()
    expect(data.context).toMatchObject({
      paneId: 'single', worldId: 'w1', timelineId: 'main', spaceId: 'exterior',
      presentation: 'voxel3d', identity: 'owner', sceneId: 'scene-1', sceneVersion: 4,
      stateVersion: 7, simNow: '2026-10-07T12:00:00Z', timeZone: 'Asia/Shanghai',
    })
    expect(data.context.availableSpaces.map(space => space.id)).toEqual(['exterior', 'main-house-interior'])
    expect(data.sceneDocument.format).toBe('voxel-spaces')
    // 选定空间文档是反序列化文档（无 format 信封字段），以文档 id 核对身份。
    expect(data.selectedSpaceDocument.id).toBe('scene-1')
    expect(data.worldReadModel.scope).toEqual({
      source: 'account', worldId: 'w1', timelineId: 'main', sceneId: 'scene-1', sceneVersion: 4,
    })
    // 读取器返回的 snapshot 与上下文来自同一次读取。
    expect(data.snapshot.stateVersion).toBe(data.context.stateVersion)
    expect(data.snapshot.simNow).toBe(data.context.simNow)
  })

  it('honors an explicit interior space and does not fall back to resume or exterior', async () => {
    const { loadSession } = createPresentationRuntime('account')
    const data = await expectWorldData(loadSession({ ...accountTarget, spaceId: 'main-house-interior' }, new AbortController().signal))
    expect(data.context.spaceId).toBe('main-house-interior')
    expect(data.selectedSpaceDocument.size).toEqual({ width: 6, height: 5, depth: 6 })
  })

  it('rejects an unknown space with reasons and alternatives instead of silently falling back', async () => {
    const { loadSession } = createPresentationRuntime('account')
    const result = await loadSession({ ...accountTarget, spaceId: 'ghost-space' }, new AbortController().signal)
    expect(result).toMatchObject({ kind: 'unsupported', code: 'space-missing' })
    expect((result as PaneUnsupported).alternatives?.map(space => space.id)).toEqual(['exterior', 'main-house-interior'])
  })

  it('reads the requested timeline and never accepts a different echo', async () => {
    const { loadSession } = createPresentationRuntime('account')
    mockedMapBootstrap.mockResolvedValue(bootstrap({ world: snapshot({ currentTimelineId: 'main' }) }))
    const data = await expectWorldData(loadSession({ ...accountTarget, timelineId: 'main' }, new AbortController().signal))
    expect(data.context.timelineId).toBe('main')
    expect(mockedMapBootstrap).toHaveBeenCalledWith('w1', 'main', expect.any(AbortSignal))
    // 服务端无法按请求读取 fork-1 时（这里以回显 main 模拟），读取失败而非静默改线。
    await expect(loadSession({ ...accountTarget, timelineId: 'fork-1' }, new AbortController().signal))
      .rejects.toThrow('不同时间线')
  })

  it('maps a missing scene to an unsupported result and unavailable scene to a retryable error', async () => {
    const { loadSession } = createPresentationRuntime('account')
    mockedMapBootstrap.mockResolvedValue(bootstrap({ scene: { status: 'missing' } }))
    expect(await loadSession(accountTarget, new AbortController().signal))
      .toMatchObject({ kind: 'unsupported', code: 'scene-missing' })
    mockedMapBootstrap.mockResolvedValue(bootstrap({ scene: { status: 'unavailable', retryable: true } }))
    await expect(loadSession(accountTarget, new AbortController().signal)).rejects.toThrow('场景暂时不可用')
  })

  it('rejects a snapshot whose world echo differs from the target', async () => {
    const { loadSession } = createPresentationRuntime('account')
    mockedMapBootstrap.mockResolvedValue(bootstrap({ world: snapshot({ world: { ...snapshot().world, id: 'w-other' } }) }))
    await expect(loadSession(accountTarget, new AbortController().signal)).rejects.toThrow('世界与请求目标不一致')
  })

  it('marks guest identity from the guest bootstrap without account capabilities', async () => {
    const { loadSession } = createPresentationRuntime('guest')
    const data = await expectWorldData(loadSession(accountTarget, new AbortController().signal))
    expect(data.context.identity).toBe('guest')
    expect(mockedGuestBootstrap).toHaveBeenCalledWith('w1', undefined, expect.any(AbortSignal))
    expect(mockedMapBootstrap).not.toHaveBeenCalled()
  })

  it('marks readonly identity for accounts without scene edit or persist capability', async () => {
    const { loadSession } = createPresentationRuntime('account')
    mockedMapBootstrap.mockResolvedValue(bootstrap({
      access: { observe: true, participate: false, editScene: false, fork: false, compare: true, persist: false, resetDemo: false },
    }))
    const data = await expectWorldData(loadSession(accountTarget, new AbortController().signal))
    expect(data.context.identity).toBe('readonly')
  })

  it('reads public worlds through the public snapshot and scene endpoints with echo validation', async () => {
    const { loadSession } = createPresentationRuntime('public')
    const data = await expectWorldData(loadSession(accountTarget, new AbortController().signal))
    expect(mockedPublicSnapshot).toHaveBeenCalledWith('w1', undefined, expect.any(AbortSignal))
    expect(mockedPublicScene).toHaveBeenCalledWith('w1', { timelineId: 'main', representation: 'voxel' }, expect.any(AbortSignal))
    expect(data.context.identity).toBe('readonly')
    expect(data.context.sceneVersion).toBe(4)
  })

  it('reports unsupported 2D for an unknown theme before declaring readiness', async () => {
    const { loadSession } = createPresentationRuntime('account')
    const envelope = spacesEnvelope()
    const themed: MapScene = {
      status: 'ready',
      version: 4,
      document: {
        ...envelope,
        spaces: envelope.spaces.map(space => ({ ...space, document: { ...space.document, theme: 'cyber-city' } })),
      } as SerializedVoxelSpaces,
    }
    mockedMapBootstrap.mockResolvedValue(bootstrap({ scene: themed }))
    const result3d = await expectWorldData(loadSession(accountTarget, new AbortController().signal))
    // 主题不支持 2D 时，空间描述只登记 3D。
    expect(result3d.context.availableSpaces[0].supportedPresentations).toEqual(['voxel3d'])
    const result2d = await loadSession({ ...accountTarget, presentation: 'native2d' }, new AbortController().signal)
    expect(result2d).toMatchObject({ kind: 'unsupported', code: 'theme-unsupported' })
  })

  it('propagates cancellation from the caller signal', async () => {
    const { loadSession } = createPresentationRuntime('account')
    const controller = new AbortController()
    controller.abort()
    mockedMapBootstrap.mockImplementation((_worldId, _timelineId, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    await expect(loadSession(accountTarget, controller.signal)).rejects.toThrow()
  })

  it('never calls write or resume endpoints from the reader path', async () => {
    const { loadSession } = createPresentationRuntime('guest')
    await loadSession(accountTarget, new AbortController().signal)
    expect(mockedGuestBootstrap).toHaveBeenCalledTimes(1)
    // mocked module 只暴露读取端点；此处断言没有其他调用发生。
    expect(mockedGuestBootstrap.mock.calls).toHaveLength(1)
  })
})
