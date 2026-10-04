import { describe, expect, it } from 'vitest'
import type {
  BuildingPlacement,
  LayoutState,
  SampleScope,
} from '../types'
import { FIXTURE_SCOPE, PUBLIC_DEMO_SCOPE } from '../fixtures'
import { MIST_MANOR_SCENE } from '../scene'
import { createInitialLayout } from '../layout-validation'
import {
  LAYOUT_STORAGE_KEY_PREFIX,
  createLayoutRepository,
  layoutStorageKey,
  type LayoutStorage,
} from '../storage'

const scene = MIST_MANOR_SCENE
const SAVED_AT = '2026-10-04T01:02:03.456Z'

/** 内存 Storage stub：行为同 DOM localStorage 的最小子集。 */
function memoryStorage(): { storage: LayoutStorage; map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    storage: {
      getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
      setItem: (key, value) => {
        map.set(key, value)
      },
      removeItem: (key) => {
        map.delete(key)
      },
    },
  }
}

function baselineLayout(scope: SampleScope = FIXTURE_SCOPE): LayoutState {
  return createInitialLayout(scene, scope)
}

/** 直接生成载荷 JSON（可注入任意字段变体），用于播种损坏/不兼容记录。 */
function recordJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    formatVersion: 1,
    scope: { ...FIXTURE_SCOPE },
    placements: baselineLayout().placements.map((p) => ({
      buildingId: p.buildingId,
      spaceId: p.spaceId,
      origin: { x: p.origin.x, z: p.origin.z },
    })),
    savedAt: SAVED_AT,
    ...overrides,
  })
}

function scopeWith(patch: Partial<SampleScope>): SampleScope {
  return { ...FIXTURE_SCOPE, ...patch }
}

describe('T15 范围键与存储记录', () => {
  it('键带独立前缀，且各段含分隔符/引号/斜杠也不会串键', () => {
    const tricky = (worldId: string, timelineId: string): SampleScope =>
      scopeWith({ worldId, timelineId })
    const pairs: Array<[SampleScope, SampleScope]> = [
      [tricky('w:1', 't'), tricky('w', '1:t')],
      [tricky('a/b', 'c'), tricky('a', 'b/c')],
      [tricky('x","y', 'z'), tricky('x', 'y","z')],
      [tricky('["a"]', 'b'), tricky('["a', ']b')],
    ]
    for (const [a, b] of pairs) {
      expect(layoutStorageKey(a)).not.toBe(layoutStorageKey(b))
    }
    expect(layoutStorageKey(FIXTURE_SCOPE).startsWith(LAYOUT_STORAGE_KEY_PREFIX + ':')).toBe(true)
    // 键不含 sceneVersion：版本只放载荷。
    const keyA = layoutStorageKey(scopeWith({ sceneVersion: 1 }))
    const keyB = layoutStorageKey(scopeWith({ sceneVersion: 999 }))
    expect(keyA).toBe(keyB)
  })

  it('来源隔离：fixture 存档对 public 范围不可见', () => {
    const { storage } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    expect(repo.save(baselineLayout(FIXTURE_SCOPE), SAVED_AT)).toEqual({ ok: true })
    expect(repo.load(PUBLIC_DEMO_SCOPE)).toEqual({ status: 'none' })
  })

  it('worldId / timelineId / sceneId 分别隔离', () => {
    const { storage } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    expect(repo.save(baselineLayout(FIXTURE_SCOPE), SAVED_AT)).toEqual({ ok: true })
    expect(repo.load(scopeWith({ worldId: 'other-world' }))).toEqual({ status: 'none' })
    expect(repo.load(scopeWith({ timelineId: 'other-timeline' }))).toEqual({ status: 'none' })
    expect(repo.load(scopeWith({ sceneId: 'other-scene' }))).toEqual({ status: 'none' })
    expect(repo.load(FIXTURE_SCOPE).status).toBe('ready')
  })

  it('含分隔符的身份保存后互不串键、各自可恢复', () => {
    const { storage } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    const scopeA = scopeWith({ worldId: 'w:1/甲', timelineId: 't' })
    const scopeB = scopeWith({ worldId: 'w', timelineId: '1/甲:t' })
    const layoutA = baselineLayout(scopeA)
    expect(repo.save(layoutA, SAVED_AT)).toEqual({ ok: true })
    expect(repo.load(scopeB)).toEqual({ status: 'none' })
    expect(repo.load(scopeA)).toEqual({ status: 'ready', layout: layoutA })
  })

  it('载荷只含批准字段：formatVersion/scope/placements/savedAt，无世界快照或撤销历史', () => {
    const { storage, map } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    expect(repo.save(baselineLayout(FIXTURE_SCOPE), SAVED_AT)).toEqual({ ok: true })

    const raw = map.get(layoutStorageKey(FIXTURE_SCOPE))
    expect(typeof raw).toBe('string')
    const parsed = JSON.parse(raw as string) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual([
      'formatVersion',
      'placements',
      'savedAt',
      'scope',
    ])
    expect(parsed.formatVersion).toBe(1)
    expect(parsed.savedAt).toBe(SAVED_AT)
    expect(Object.keys(parsed.scope as Record<string, unknown>).sort()).toEqual([
      'sceneId',
      'sceneVersion',
      'source',
      'timelineId',
      'worldId',
    ])
    const placements = parsed.placements as Array<Record<string, unknown>>
    expect(placements.length).toBe(scene.buildings.length)
    for (const p of placements) {
      expect(Object.keys(p).sort()).toEqual(['buildingId', 'origin', 'spaceId'])
    }
    // 不保存世界快照或撤销历史。
    expect(raw).not.toContain('worldName')
    expect(raw).not.toContain('residents')
    expect(raw).not.toContain('undo')
  })
})

describe('T16 恢复与损坏识别', () => {
  it('无记录 → none', () => {
    const { storage } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    expect(repo.load(FIXTURE_SCOPE)).toEqual({ status: 'none' })
  })

  it('合法记录 → ready 且布局完整一致', () => {
    const { storage } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    const layout = baselineLayout()
    expect(repo.save(layout, SAVED_AT)).toEqual({ ok: true })
    expect(repo.load(FIXTURE_SCOPE)).toEqual({ status: 'ready', layout })
  })

  it('坏 JSON → damaged，原记录保持不变', () => {
    const { storage, map } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    const key = layoutStorageKey(FIXTURE_SCOPE)
    storage.setItem(key, '{not-json')
    const result = repo.load(FIXTURE_SCOPE)
    expect(result.status).toBe('damaged')
    expect(map.get(key)).toBe('{not-json')
  })

  it('结构不符（数组/缺字段/坏 placements）→ damaged，原值不变', () => {
    const { storage, map } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    const key = layoutStorageKey(FIXTURE_SCOPE)
    const variants = [
      '[1,2,3]',
      JSON.stringify({ formatVersion: 1 }), // 缺 scope/placements/savedAt
      recordJson({ scope: { ...FIXTURE_SCOPE, sceneVersion: undefined } }),
      recordJson({ placements: [{ buildingId: 1 }] }),
      recordJson({ savedAt: '' }),
    ]
    for (const text of variants) {
      storage.setItem(key, text)
      const result = repo.load(FIXTURE_SCOPE)
      expect(result.status).toBe('damaged')
      expect(map.get(key)).toBe(text)
    }
  })

  it('formatVersion 不匹配 → incompatible，原值不变', () => {
    const { storage, map } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    const key = layoutStorageKey(FIXTURE_SCOPE)
    const text = recordJson({ formatVersion: 2 })
    storage.setItem(key, text)
    const result = repo.load(FIXTURE_SCOPE)
    expect(result.status).toBe('incompatible')
    expect(map.get(key)).toBe(text)
  })

  it('sceneVersion 不匹配 → incompatible（同一键，证明版本在载荷而非键）', () => {
    const { storage, map } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    expect(repo.save(baselineLayout(FIXTURE_SCOPE), SAVED_AT)).toEqual({ ok: true })
    const key = layoutStorageKey(FIXTURE_SCOPE)
    const before = map.get(key)
    const newer = scopeWith({ sceneVersion: FIXTURE_SCOPE.sceneVersion + 1 })
    const result = repo.load(newer)
    expect(result.status).toBe('incompatible')
    if (result.status === 'incompatible') {
      expect(result.message).toContain('场景版本')
    }
    expect(map.get(key)).toBe(before)
  })

  it('记录 scope 段与请求范围不一致 → incompatible，原值不变', () => {
    const { storage, map } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    const key = layoutStorageKey(FIXTURE_SCOPE)
    const text = recordJson({ scope: { ...FIXTURE_SCOPE, worldId: 'tampered-world' } })
    storage.setItem(key, text)
    const result = repo.load(FIXTURE_SCOPE)
    expect(result.status).toBe('incompatible')
    expect(map.get(key)).toBe(text)
  })

  it('placements 缺建筑（validateLayout 非法）→ damaged，原值不变', () => {
    const { storage, map } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    const key = layoutStorageKey(FIXTURE_SCOPE)
    const partial = baselineLayout().placements.slice(1)
    const text = recordJson({ placements: partial })
    storage.setItem(key, text)
    const result = repo.load(FIXTURE_SCOPE)
    expect(result.status).toBe('damaged')
    expect(map.get(key)).toBe(text)
  })

  it('placements 越界 → damaged，原值不变', () => {
    const { storage, map } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    const key = layoutStorageKey(FIXTURE_SCOPE)
    const outOfBounds: BuildingPlacement[] = baselineLayout().placements.map((p, i) =>
      i === 0 ? { ...p, origin: { x: -50, z: -50 } } : p,
    )
    const text = recordJson({ placements: outOfBounds })
    storage.setItem(key, text)
    const result = repo.load(FIXTURE_SCOPE)
    expect(result.status).toBe('damaged')
    expect(map.get(key)).toBe(text)
  })

  it('storageProvider 获取失败 → error/storage_unavailable，不误报无存档', () => {
    const repo = createLayoutRepository(scene, () => {
      throw new Error('storage blocked')
    })
    const result = repo.load(FIXTURE_SCOPE)
    expect(result).toEqual({
      status: 'error',
      reason: 'storage_unavailable',
      message: 'storage blocked',
    })
  })

  it('getItem 抛错 → error/storage_error，原值不变', () => {
    const { map } = memoryStorage()
    const key = layoutStorageKey(FIXTURE_SCOPE)
    const text = recordJson({})
    map.set(key, text)
    const storage: LayoutStorage = {
      getItem: () => {
        throw new Error('read failed')
      },
      setItem: (k, v) => {
        map.set(k, v)
      },
      removeItem: (k) => {
        map.delete(k)
      },
    }
    const repo = createLayoutRepository(scene, () => storage)
    const result = repo.load(FIXTURE_SCOPE)
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.reason).toBe('storage_error')
      expect(result.message).toContain('read failed')
    }
    expect(map.get(key)).toBe(text)
  })
})

describe('T17 保存和重置故障', () => {
  it('save：storageProvider 获取失败 → storage_unavailable', () => {
    const repo = createLayoutRepository(scene, () => {
      throw new Error('storage blocked')
    })
    expect(repo.save(baselineLayout(), SAVED_AT)).toEqual({
      ok: false,
      reason: 'storage_unavailable',
      message: 'storage blocked',
    })
  })

  it('save：QuotaExceededError（name 识别）→ quota_exceeded', () => {
    const quota = new Error('disk full')
    quota.name = 'QuotaExceededError'
    const storage: LayoutStorage = {
      getItem: () => null,
      setItem: () => {
        throw quota
      },
      removeItem: () => {},
    }
    const repo = createLayoutRepository(scene, () => storage)
    const result = repo.save(baselineLayout(), SAVED_AT)
    expect(result).toEqual({ ok: false, reason: 'quota_exceeded', message: 'disk full' })
  })

  it('save：旧式 code=22 异常 → quota_exceeded', () => {
    const legacy = new Error('legacy quota') as Error & { code: number }
    legacy.code = 22
    const storage: LayoutStorage = {
      getItem: () => null,
      setItem: () => {
        throw legacy
      },
      removeItem: () => {},
    }
    const repo = createLayoutRepository(scene, () => storage)
    const result = repo.save(baselineLayout(), SAVED_AT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('quota_exceeded')
  })

  it('save：其他 setItem 异常 → storage_error', () => {
    const storage: LayoutStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('weird write failure')
      },
      removeItem: () => {},
    }
    const repo = createLayoutRepository(scene, () => storage)
    expect(repo.save(baselineLayout(), SAVED_AT)).toEqual({
      ok: false,
      reason: 'storage_error',
      message: 'weird write failure',
    })
  })

  it('save 失败不删除原值：旧记录仍可恢复', () => {
    const { storage, map } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    const original = baselineLayout()
    expect(repo.save(original, SAVED_AT)).toEqual({ ok: true })
    const key = layoutStorageKey(FIXTURE_SCOPE)
    const before = map.get(key)

    // 换成写必失败的存储，但读仍指向同一数据。
    const flaky: LayoutStorage = {
      getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: () => {
        throw new Error('write broken')
      },
      removeItem: (k) => {
        map.delete(k)
      },
    }
    const repoFlaky = createLayoutRepository(scene, () => flaky)
    const moved: LayoutState = {
      scope: FIXTURE_SCOPE,
      placements: original.placements.map((p, i) =>
        i === 0 ? { ...p, origin: { x: p.origin.x + 1, z: p.origin.z } } : p,
      ),
    }
    const result = repoFlaky.save(moved, SAVED_AT)
    expect(result.ok).toBe(false)
    expect(map.get(key)).toBe(before)
    expect(repo.load(FIXTURE_SCOPE)).toEqual({ status: 'ready', layout: original })
  })

  it('reset 成功 → ok:true，随后 load 为 none', () => {
    const { storage } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    expect(repo.save(baselineLayout(), SAVED_AT)).toEqual({ ok: true })
    expect(repo.reset(FIXTURE_SCOPE)).toEqual({ ok: true })
    expect(repo.load(FIXTURE_SCOPE)).toEqual({ status: 'none' })
  })

  it('reset 对不存在记录也成功（幂等清除）', () => {
    const { storage } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    expect(repo.reset(FIXTURE_SCOPE)).toEqual({ ok: true })
  })

  it('reset：removeItem 抛错 → storage_error 且原记录保留', () => {
    const { storage, map } = memoryStorage()
    const repo = createLayoutRepository(scene, () => storage)
    const layout = baselineLayout()
    expect(repo.save(layout, SAVED_AT)).toEqual({ ok: true })
    const key = layoutStorageKey(FIXTURE_SCOPE)
    const before = map.get(key)

    const cannotDelete: LayoutStorage = {
      getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: (k, v) => {
        map.set(k, v)
      },
      removeItem: () => {
        throw new Error('delete denied')
      },
    }
    const repoBlocked = createLayoutRepository(scene, () => cannotDelete)
    expect(repoBlocked.reset(FIXTURE_SCOPE)).toEqual({
      ok: false,
      reason: 'storage_error',
      message: 'delete denied',
    })
    expect(map.get(key)).toBe(before)
    expect(repo.load(FIXTURE_SCOPE)).toEqual({ status: 'ready', layout })
  })

  it('reset：storageProvider 获取失败 → storage_unavailable', () => {
    const repo = createLayoutRepository(scene, () => {
      throw new Error('storage blocked')
    })
    expect(repo.reset(FIXTURE_SCOPE)).toEqual({
      ok: false,
      reason: 'storage_unavailable',
      message: 'storage blocked',
    })
  })
})
