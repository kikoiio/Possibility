import { describe, expect, it } from 'vitest'
import { getBlock, validateDocument, validateWalkability } from '@possibility/voxel-contract'
import type { ChatMessage } from '../llm/client'
import { parseEditOperations } from './edit-planner'
import { assembleWorld, generateWorld, WorldGeneratorError } from './generate'
import type { CompleteFn } from './edit-planner'
import { WORLD_GEN_SPEC } from './prompts'

const payload = (ops: unknown[]) => JSON.stringify({
  size: { width: 16, height: 16, depth: 16 },
  groundBlock: 'grass',
  ops,
})

/** 无害操作:Parser 不接受空 ops;平地重写一块草等于不变 */
const NOOP_OPS = [{ kind: 'set-block', at: { x: 0, y: 0, z: 0 }, block: 'grass' }]

/** 净高 1 的「门洞」:平地上 (8,2,8) 压一块石头,(8,1,8) 成净空不足格 */
const LOW_DOOR_OPS = [{ kind: 'set-block', at: { x: 8, y: 2, z: 8 }, block: 'stone' }]
const OVERLAPPING_HOUSES = [
  { kind: 'place-object', objectId: 'a', objectType: 'manor-main-house', anchor: { x: 4, y: 1, z: 4 }, rotation: 0 },
  { kind: 'place-object', objectId: 'b', objectType: 'manor-main-house', anchor: { x: 4, y: 1, z: 4 }, rotation: 0 },
  { kind: 'place-object', objectId: 'c', objectType: 'manor-main-house', anchor: { x: 4, y: 1, z: 4 }, rotation: 0 },
]

describe('generateWorld × 可行走性校验(S2b F5/AC6)', () => {
  it('normalizes missing size and repairable clearance once without an extra LLM call', async () => {
    const calls: ChatMessage[][] = []
    const complete: CompleteFn = async (messages) => {
      calls.push(messages)
      return JSON.stringify({
        ops: [{ kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' }, ...LOW_DOOR_OPS],
      })
    }
    const doc = await generateWorld('测试世界', 'mist-manor', { complete, maxAttempts: 1 })
    expect(calls).toHaveLength(1)
    expect(doc.size).toEqual({ width: 18, height: 5, depth: 18 })
    expect(getBlock(doc, { x: 8, y: 2, z: 8 })).toBe('air')
    expect(validateDocument(doc)).toEqual([])
    expect(validateWalkability(doc)).toEqual([])
  })

  it('unrepairable document retries with feedback and reports normalization fixes on exhaustion', async () => {
    const calls: ChatMessage[][] = []
    const overlap = JSON.stringify({ size: { width: 16.2, height: 16, depth: 16 }, ops: OVERLAPPING_HOUSES })
    const complete: CompleteFn = async (messages) => {
      calls.push(messages)
      return overlap
    }
    let error: unknown
    try {
      await generateWorld('测试世界', 'mist-manor', { complete, maxAttempts: 2 })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(WorldGeneratorError)
    expect(calls).toHaveLength(2)
    expect(calls[1][calls[1].length - 1].content).toContain('未通过契约校验')
    expect((error as WorldGeneratorError).issues.some(issue => issue.code === 'object-overlap')).toBe(true)
    expect((error as WorldGeneratorError).normalizationFixes).toEqual(['size:16.2x16x16->16x16x16'])
  })

  it('retry feedback gives exact world coordinate bounds for out-of-bounds edits', async () => {
    const calls: ChatMessage[][] = []
    const complete: CompleteFn = async (messages) => {
      calls.push(messages)
      return JSON.stringify({
        size: { width: 16, height: 16, depth: 16 },
        ops: [{ kind: 'place-object', objectId: 'edge-house', objectType: 'manor-main-house', anchor: { x: 15, y: 1, z: 15 }, rotation: 0 }],
      })
    }
    await expect(generateWorld('测试世界', 'mist-manor', { complete, maxAttempts: 2 })).rejects.toBeInstanceOf(WorldGeneratorError)
    expect(calls).toHaveLength(2)
    const feedback = calls[1][calls[1].length - 1].content
    expect(feedback).toContain('x=0..15, y=0..15, z=0..15')
  })

  it('connectivity retries identify and preserve the unreachable location carrier', async () => {
    const calls: ChatMessage[][] = []
    const complete: CompleteFn = async (messages) => {
      calls.push(messages)
      return JSON.stringify({
        size: { width: 16, height: 16, depth: 16 },
        ops: [
          { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
          { kind: 'place-object', objectId: 'cafe-carrier', objectType: 'stone-lantern', anchor: { x: 8, y: 1, z: 8 }, rotation: 0 },
          { kind: 'fill', from: { x: 7, y: 1, z: 7 }, to: { x: 7, y: 3, z: 9 }, block: 'stone' },
          { kind: 'fill', from: { x: 9, y: 1, z: 7 }, to: { x: 9, y: 3, z: 9 }, block: 'stone' },
          { kind: 'fill', from: { x: 8, y: 1, z: 7 }, to: { x: 8, y: 3, z: 7 }, block: 'stone' },
          { kind: 'fill', from: { x: 8, y: 1, z: 9 }, to: { x: 8, y: 3, z: 9 }, block: 'stone' },
        ],
        locations: [{ name: '咖啡馆', objectId: 'cafe-carrier' }],
      })
    }
    let error: unknown
    try {
      await generateWorld('测试世界', 'mist-manor', { complete, maxAttempts: 2 })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(WorldGeneratorError)
    expect((error as WorldGeneratorError).failureStage).toBe('validation')
    expect((error as WorldGeneratorError).issues.some(issue => issue.code === 'walk-connectivity')).toBe(true)
    expect(calls).toHaveLength(2)
    const feedback = calls[1][calls[1].length - 1].content
    expect(feedback).toContain('cafe-carrier/stone-lantern/咖啡馆@(8,1,8)')
    expect(feedback).toContain('保持物体及地点绑定不变')
  })

  it('reports assembly-stage failures separately from validation issues', async () => {
    const complete: CompleteFn = async () => JSON.stringify({})
    let error: unknown
    try {
      await generateWorld('测试世界', 'mist-manor', { complete, maxAttempts: 2 })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(WorldGeneratorError)
    expect((error as WorldGeneratorError).failureStage).toBe('assembly')
    expect((error as WorldGeneratorError).issues).toEqual([])
  })

  it('retries when a generated scene omits a required world location carrier', async () => {
    const calls: ChatMessage[][] = []
    const complete: CompleteFn = async (messages) => {
      calls.push(messages)
      return JSON.stringify({
        size: { width: 32, height: 16, depth: 32 },
        ops: [
          { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 31, y: 0, z: 31 }, block: 'grass' },
          { kind: 'place-object', objectId: 'cafe-carrier', objectType: 'manor-main-house', anchor: { x: 8, y: 1, z: 8 }, rotation: 0 },
        ],
        ...(calls.length > 1 ? { locations: [{ name: '咖啡馆', objectId: 'cafe-carrier' }] } : {}),
      })
    }
    const doc = await generateWorld('测试世界', 'mist-manor', {
      complete, maxAttempts: 2, requiredLocationNames: ['咖啡馆'],
    })

    expect(calls).toHaveLength(2)
    expect(calls[1][calls[1].length - 1].content).toContain('必需地点「咖啡馆」尚未绑定')
    expect(calls[1][calls[1].length - 1].content).toContain('逐字绑定地点名')
    expect(doc.locations).toEqual([{ name: '咖啡馆', objectId: 'cafe-carrier' }])
  })

  it('clearance-only failure is repaired before retry and passes in one provider call', async () => {
    const calls: ChatMessage[][] = []
    const complete: CompleteFn = async (messages) => {
      calls.push(messages)
      return payload(LOW_DOOR_OPS)
    }
    const doc = await generateWorld('测试世界', 'mist-manor', { complete })
    expect(calls).toHaveLength(1)
    expect(getBlock(doc, { x: 8, y: 2, z: 8 })).toBe('air')
    expect(validateDocument(doc)).toEqual([])
    expect(validateWalkability(doc)).toEqual([])
  })

  it('maxAttempts 耗尽 → WorldGeneratorError 携带结构 issue 与归一修复记录', async () => {
    const complete: CompleteFn = async () => JSON.stringify({ ops: OVERLAPPING_HOUSES })
    let error: unknown
    try {
      await generateWorld('测试世界', 'mist-manor', { complete, maxAttempts: 2 })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(WorldGeneratorError)
    expect((error as WorldGeneratorError).issues.some((i) => i.code === 'object-overlap')).toBe(true)
    expect((error as WorldGeneratorError).normalizationFixes).toEqual(['size:inferred->8x4x8'])
  })

  it('结构校验失败时跳过可行走性(先修结构)', async () => {
    const calls: string[] = []
    const complete: CompleteFn = async () => {
      calls.push('x')
      // 物体重叠 → validateDocument object-overlap;不应出现 walk-* issue
      // (S1 起 assembleWorld 确定性避让:就近找空位搬移。三栋主楼(9×8)在 16×16 里最多摆两栋,
      //  第三栋无处可去 → 仍 overlap,走重试/报错链)
      return JSON.stringify({
        size: { width: 16, height: 16, depth: 16 },
        ops: [
          { kind: 'place-object', objectId: 'a', objectType: 'manor-main-house', anchor: { x: 4, y: 1, z: 4 }, rotation: 0 },
          { kind: 'place-object', objectId: 'b', objectType: 'manor-main-house', anchor: { x: 4, y: 1, z: 4 }, rotation: 0 },
          { kind: 'place-object', objectId: 'c', objectType: 'manor-main-house', anchor: { x: 4, y: 1, z: 4 }, rotation: 0 },
        ],
      })
    }
    let error: unknown
    try {
      await generateWorld('测试世界', 'mist-manor', { complete, maxAttempts: 1 })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(WorldGeneratorError)
    const issues = (error as WorldGeneratorError).issues
    expect(issues.some((i) => i.code === 'object-overlap')).toBe(true)
    expect(issues.some((i) => i.code.startsWith('walk-'))).toBe(false)
  })

  it('S1 沉降归一:整体悬空的物体自动落地,不再触发 floating-object', async () => {
    const complete: CompleteFn = async () => JSON.stringify({
      size: { width: 16, height: 16, depth: 16 },
      groundBlock: 'grass',
      ops: [{ kind: 'place-object', objectId: 'l', objectType: 'stone-lantern', anchor: { x: 8, y: 8, z: 8 }, rotation: 0 }],
    })
    const doc = await generateWorld('测试世界', 'mist-manor', { complete, maxAttempts: 1 })
    expect(doc.objects.find(o => o.id === 'l')?.anchor.y).toBe(1)
    expect(validateDocument(doc)).toEqual([])
  })

  it('S1 重叠避让:同位物体就近搬移,地点绑定物体保持原位', async () => {
    const complete: CompleteFn = async () => JSON.stringify({
      size: { width: 16, height: 16, depth: 16 },
      groundBlock: 'grass',
      ops: [
        { kind: 'place-object', objectId: 'a', objectType: 'stone-lantern', anchor: { x: 8, y: 1, z: 8 }, rotation: 0 },
        { kind: 'place-object', objectId: 'b', objectType: 'stone-lantern', anchor: { x: 8, y: 1, z: 8 }, rotation: 0 },
      ],
      locations: [{ name: '主楼', objectId: 'a' }],
    })
    const doc = await generateWorld('测试世界', 'mist-manor', { complete, maxAttempts: 1 })
    expect(doc.objects.find(o => o.id === 'a')?.anchor).toEqual({ x: 8, y: 1, z: 8 })
    const b = doc.objects.find(o => o.id === 'b')!.anchor
    expect(b.x !== 8 || b.z !== 8).toBe(true)
    expect(validateDocument(doc)).toEqual([])
  })
})

describe('assembleWorld invalid dimensions', () => {
  it('rejects dimensions outside the supported range without provider calls', () => {
    const invalidSizes = [
      { width: 7, height: 16, depth: 16 },
      { width: 16, height: 3, depth: 16 },
      { width: 16, height: 16, depth: 7 },
      { width: 257, height: 16, depth: 16 },
      { width: 16, height: 65, depth: 16 },
      { width: 16, height: 16, depth: 257 },
      { width: 16.5, height: 16, depth: 16 },
    ]

    for (const size of invalidSizes) {
      expect(() => assembleWorld({ size, ops: NOOP_OPS }, 'mist-manor', 'invalid-size'))
        .toThrow(WorldGeneratorError)
    }
  })

  it('retries malformed sizes that cannot be inferred with a stable terminal error', async () => {
    const invalidPayload = JSON.stringify({ size: { width: 'wide', height: 16, depth: 16 }, ops: [] })
    const errors: string[] = []
    for (let run = 0; run < 2; run++) {
      let calls = 0
      const complete: CompleteFn = async () => {
        calls += 1
        return invalidPayload
      }
      let error: unknown
      try {
        await generateWorld('固定输入', 'mist-manor', { complete, id: 'fixed-size', maxAttempts: 2 })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(WorldGeneratorError)
      expect(calls).toBe(2)
      errors.push((error as Error).message)
    }
    expect(errors[0]).toBe(errors[1])
  })
})

describe('assembleWorld × S3b 地形与风格包', () => {
  it('带 terrain+style 负载:地形格存在、元数据落盘、建筑落在地形之上', () => {
    const doc = assembleWorld({
      size: { width: 24, height: 16, depth: 24 },
      terrain: {
        seed: 42,
        elevation: { amplitude: 4 },
        river: { enabled: true, width: 2 },
        vegetation: { density: 0.05, trees: true },
      },
      style: { preset: 'dusk-warm', tweaks: { exposure: 0.1 } },
      ops: [{ kind: 'fill', from: { x: 4, y: 4, z: 4 }, to: { x: 6, y: 5, z: 6 }, block: 'stone' }],
    }, 'mist-manor', 't1')
    expect(doc.terrain?.params.seed).toBe(42)
    expect(doc.style?.preset).toBe('dusk-warm')
    expect(doc.style?.tweaks).toEqual({ exposure: 0.1 })
    // 地形存在:非 y=0 平铺(有 dirt/stone 柱与高于 y=0 的 grass)
    expect(getBlock(doc, { x: 0, y: 2, z: 0 })).not.toBe('air')
    // 建筑 ops 落在地形之上未被地形覆盖
    expect(getBlock(doc, { x: 5, y: 5, z: 5 })).toBe('stone')
    expect(validateDocument(doc)).toEqual([])
  })

  it('无 terrain 负载:与现状等价(y=0 平铺 + groundBlock),无元数据字段', () => {
    const doc = assembleWorld({
      size: { width: 16, height: 16, depth: 16 },
      ops: NOOP_OPS,
    }, 'mist-manor', 't2')
    expect(doc.terrain).toBeUndefined()
    expect(doc.style).toBeUndefined()
    expect(getBlock(doc, { x: 0, y: 0, z: 0 })).toBe('grass')
    expect(getBlock(doc, { x: 15, y: 0, z: 15 })).toBe('grass')
    expect(getBlock(doc, { x: 8, y: 1, z: 8 })).toBe('air')
  })

  it('种子缺省时服务端分配并写入元数据;超限密度夹取有记录', () => {
    const doc = assembleWorld({
      size: { width: 16, height: 16, depth: 16 },
      terrain: { vegetation: { density: 0.9 } },
    }, 'mist-manor', 't3')
    expect(Number.isInteger(doc.terrain?.params.seed)).toBe(true)
    expect(doc.terrain?.params.vegetation?.density).toBe(0.1)
    expect(doc.terrain?.clamps).toEqual([{ field: 'vegetation.density', from: 0.9, to: 0.1 }])
  })

  it('未知风格预设夹到默认并记录', () => {
    const doc = assembleWorld({
      size: { width: 16, height: 16, depth: 16 },
      style: { preset: 'cyberpunk' },
    }, 'mist-manor', 't4')
    expect(doc.style?.preset).toBe('default')
    expect(doc.style?.clamps).toEqual([{ field: 'style.preset', from: 'cyberpunk', to: 'default' }])
  })

  it('同种子同参数:两次组装地形逐格一致(AC11 服务端侧)', () => {
    const payload = {
      size: { width: 24, height: 16, depth: 24 },
      terrain: { seed: 7, elevation: { amplitude: 5 }, river: { enabled: true }, vegetation: { density: 0.05 } },
    }
    const a = assembleWorld(payload, 'mist-manor', 't5')
    const b = assembleWorld(payload, 'mist-manor', 't5')
    for (const probe of [
      { x: 0, y: 1, z: 0 }, { x: 12, y: 3, z: 12 }, { x: 23, y: 5, z: 7 }, { x: 5, y: 4, z: 20 },
    ]) {
      expect(getBlock(a, probe)).toBe(getBlock(b, probe))
    }
  })
})

describe('assembleWorld × S2b assetPlacements 契约', () => {
  it('assetPlacements 产出 GLB 摆放(place-asset),不产 place-object 物体', () => {
    const doc = assembleWorld({
      size: { width: 16, height: 16, depth: 16 },
      assetPlacements: [
        { assetId: 'bld-hut-a', anchor: { x: 4, y: 1, z: 4 }, rotation: 1, seed: 7 },
        { assetId: 'veg-tree-a', anchor: { x: 10, y: 1, z: 10 } },
      ],
    }, 'mist-manor', 'ap-1')
    expect(doc.objects).toHaveLength(0)
    expect(doc.assetPlacements).toHaveLength(2)
    expect(doc.assetPlacements![0]).toMatchObject({ assetId: 'bld-hut-a', anchor: [4, 1, 4], rotation: 1, seed: 7 })
    // 缺省 rotation/seed/id 派生
    expect(doc.assetPlacements![1].rotation).toBe(0)
    expect(doc.assetPlacements![1].id).toMatch(/^ast-/)
    expect(Number.isInteger(doc.assetPlacements![1].seed)).toBe(true)
  })

  it('assetPlacements 的 id 别名可被地点绑定复用,冲突时明确拒绝', () => {
    const doc = assembleWorld({
      size: { width: 16, height: 16, depth: 16 },
      assetPlacements: [{ assetId: 'bld-hut-a', id: 'cafe-building', anchor: { x: 4, y: 1, z: 4 } }],
      locations: [{ name: '咖啡馆', objectId: 'cafe-building' }],
    }, 'mist-manor', 'ap-id-alias')
    expect(doc.assetPlacements![0].id).toBe('cafe-building')
    expect(doc.locations[0].objectId).toBe('cafe-building')

    expect(() => assembleWorld({
      size: { width: 16, height: 16, depth: 16 },
      assetPlacements: [{ assetId: 'bld-hut-a', id: 'one', placementId: 'two', anchor: { x: 4, y: 1, z: 4 } }],
    }, 'mist-manor', 'ap-id-conflict')).toThrow(/id 与 placementId 不一致/)
  })

  it('旧字段 placements 报明确改名错误(N4)', () => {
    expect(() => assembleWorld({
      size: { width: 16, height: 16, depth: 16 },
      placements: [{ objectType: 'stone-lantern', anchor: { x: 4, y: 1, z: 4 }, rotation: 0 }],
    }, 'mist-manor', 'ap-2')).toThrow(/已改名为 assetPlacements/)
  })

  it('assetPlacements 条目形状不合法逐条报错', () => {
    expect(() => assembleWorld({
      size: { width: 16, height: 16, depth: 16 },
      assetPlacements: [{ assetId: 'bld-hut-a', anchor: { x: 4.5, y: 1, z: 4 } }],
    }, 'mist-manor', 'ap-3')).toThrow(/assetPlacements\[0\]/)
    expect(() => assembleWorld({
      size: { width: 16, height: 16, depth: 16 },
      assetPlacements: [{ assetId: 'bld-hut-a', anchor: { x: 4, y: 1, z: 4 }, rotation: 45 }],
    }, 'mist-manor', 'ap-4')).toThrow(/rotation/)
  })

  it('generateWorld 传清单时摆放参与严格校验;悬空摆放由沉降归一落地(S1 起不进重试链)', async () => {
    const manifest = {
      version: 2 as const,
      assets: {
        'bld-hut-a': { id: 'bld-hut-a', category: 'building' as const, url: '/x.glb', footprint: [2, 2] as [number, number], height: 2, thumbnail: '/x.png', sway: 0 },
      },
    }
    let call = 0
    const doc = await generateWorld('小屋', 'mist-manor', {
      complete: async () => {
        call += 1
        return JSON.stringify({ size: { width: 16, height: 16, depth: 16 }, assetPlacements: [{ assetId: 'bld-hut-a', anchor: { x: 4, y: 8, z: 4 } }] })
      },
      id: 'ap-5',
      assets: manifest,
    })
    // 沉降到世界底面基岩之上(y=1),一次通过
    expect(call).toBe(1)
    expect(doc.assetPlacements![0].anchor).toEqual([4, 1, 4])
  })
})

describe('generateWorld semantic building carriers', () => {
  it('keeps the default payload flat and makes terrain and asset identity explicitly optional', () => {
    const defaultExample = WORLD_GEN_SPEC.slice(0, WORLD_GEN_SPEC.indexOf('可选地形'))
    expect(defaultExample).not.toContain('"terrain"')
    expect(WORLD_GEN_SPEC).toContain('"placementId":"building-1"')
    expect(WORLD_GEN_SPEC).toContain('locations.objectId 中逐字使用同一个值')
  })

  it('normalizes the model object alias and rejects furniture as a required cafe carrier', async () => {
    expect(parseEditOperations(JSON.stringify({ ops: [
      { type: 'place-object', objectId: 'cafe', object: 'manor-main-house', anchor: { x: 4, y: 1, z: 4 } },
    ] }))).toMatchObject([{ kind: 'place-object', objectType: 'manor-main-house' }])

    let error: unknown
    try {
      await generateWorld('咖啡馆', 'mist-manor', {
        id: 'required-cafe-marker',
        maxAttempts: 1,
        requiredLocationNames: ['街角咖啡馆'],
        complete: async () => JSON.stringify({
          size: { width: 16, height: 16, depth: 16 },
          ops: [{ kind: 'place-object', objectId: 'cafe-bench', objectType: 'bench', anchor: { x: 4, y: 1, z: 4 } }],
          locations: [{ name: '街角咖啡馆', objectId: 'cafe-bench' }],
        }),
      })
    } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(WorldGeneratorError)
    expect((error as WorldGeneratorError).issues).toContainEqual(expect.objectContaining({
      code: 'location-unbound', message: expect.stringContaining('必须绑定建筑物体'),
    }))
  })

  it('normalizes bounded legacy place-object fields and reports missing location carriers clearly', async () => {
    expect(parseEditOperations(JSON.stringify({ ops: [
      { op: 'place-object', objectId: 'street-lantern', object: 'stone-lantern', x: 4, y: 1, z: 6, rotation: 2, size: { width: 1, height: 2, depth: 1 } },
      { type: 'place-object', objectId: 'house', assetId: 'manor-two-story-house', anchor: { x: 8, y: 1, z: 8 }, rotation: 0 },
    ] }))).toEqual([
      { kind: 'place-object', objectType: 'stone-lantern', objectId: 'street-lantern', anchor: { x: 4, y: 1, z: 6 }, rotation: 180 },
      { kind: 'place-object', objectType: 'manor-two-story-house', objectId: 'house', anchor: { x: 8, y: 1, z: 8 }, rotation: 0 },
    ])
    expect(() => parseEditOperations(JSON.stringify({ ops: [
      { type: 'place-object', assetId: 'stone-lantern', anchor: { x: 4, y: 1, z: 6 }, size: { width: 8, height: 1, depth: 8 } },
    ] }))).toThrow('size 与目录占地不一致')

    const assets = {
      version: 2 as const,
      assets: {
        'bld-hut-a': { id: 'bld-hut-a', category: 'building' as const, url: '/x.glb', footprint: [2, 3] as [number, number], height: 2, thumbnail: '/x.png', sway: 0 },
      },
    }
    expect(parseEditOperations(JSON.stringify({ ops: [
      { type: 'place-object', assetId: 'bld-hut-a', anchor: { x: 4, y: 1, z: 6 }, rotation: 1, size: { width: 3, height: 2, depth: 2 } },
    ] }), assets)).toEqual([
      { kind: 'place-object', objectType: 'bld-hut-a', anchor: { x: 4, y: 1, z: 6 }, rotation: 90 },
    ])

    let error: unknown
    try {
      await generateWorld('一条沿海街道', 'mist-manor', {
        id: 'missing-road-carrier',
        requiredLocationNames: ['海边小街'],
        maxAttempts: 1,
        complete: async () => JSON.stringify({
          size: { width: 16, height: 16, depth: 16 },
          ops: [{ kind: 'fill', from: { x: 2, y: 0, z: 4 }, to: { x: 13, y: 0, z: 4 }, block: 'cobble' }],
          locations: [{ name: '海边小街', objectId: 'road-marker' }],
        }),
      })
    } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(WorldGeneratorError)
    expect((error as Error).message).toContain('先在该地点区域内实际放置独立且语义相符')
    expect((error as Error).message).toContain('road-marker')
  })

  it('normalizes legacy block-edit aliases and block geometry without inventing object carriers', () => {
    expect(parseEditOperations(JSON.stringify({ ops: [
      { op: 'add', block: 'cobble', x: 2, y: 0, z: 4 },
      { type: 'set', block: 'stone', x: 3, y: 1, z: 4 },
      { op: 'place-object', objectId: 'single-cell-road', block: 'cobble', x: 4, y: 0, z: 6 },
      { kind: 'fill', block: 'cobble', region: { x1: 0, y: 0, z1: 8, x2: 3, z2: 8 } },
      { kind: 'fill', block: 'grass', box: { x: 4, y: 0, z: 8, w: 2, h: 1, d: 3 } },
      { kind: 'set-block', block: 'wood-log', from: { x: 4, y: 2, z: 6 }, to: { x: 4, y: 5, z: 6 } },
      { kind: 'place-object', objectId: 'road', block: 'cobble', x: 5, y: 0, z: 6, xLength: 8, zLength: 1 },
      { kind: 'place-object', id: 'legacy-station', objectType: 'manor-main-house', at: { x: 2, y: 1, z: 10 }, rotation: 0 },
      { kind: 'place-object', objectId: 'cafe-building', block: 'stone', anchor: { x: 8, y: 1, z: 8 }, geometry: { type: 'cube', sx: 3, sy: 2, sz: 3 } },
    ] }))).toEqual([
      { kind: 'set-block', at: { x: 2, y: 0, z: 4 }, block: 'cobble' },
      { kind: 'set-block', at: { x: 3, y: 1, z: 4 }, block: 'stone' },
      { kind: 'set-block', at: { x: 4, y: 0, z: 6 }, block: 'cobble' },
      { kind: 'fill', from: { x: 0, y: 0, z: 8 }, to: { x: 3, y: 0, z: 8 }, block: 'cobble' },
      { kind: 'fill', from: { x: 4, y: 0, z: 8 }, to: { x: 5, y: 0, z: 10 }, block: 'grass' },
      { kind: 'fill', from: { x: 4, y: 2, z: 6 }, to: { x: 4, y: 5, z: 6 }, block: 'wood-log' },
      { kind: 'fill', from: { x: 5, y: 0, z: 6 }, to: { x: 12, y: 0, z: 6 }, block: 'cobble' },
      { kind: 'place-object', objectType: 'manor-main-house', objectId: 'legacy-station', anchor: { x: 2, y: 1, z: 10 }, rotation: 0 },
      { kind: 'fill', from: { x: 8, y: 1, z: 8 }, to: { x: 10, y: 2, z: 10 }, block: 'stone' },
    ])
    expect(() => parseEditOperations(JSON.stringify({ ops: [
      { kind: 'place-object', block: 'stone', anchor: { x: 0, y: 1, z: 0 }, geometry: { sx: 64, sy: 64, sz: 64 } },
    ] }))).toThrow('place-object 需要目录 objectType/assetId')
    expect(() => parseEditOperations(JSON.stringify({ ops: [
      { kind: 'fill', block: 'stone', box: { x: 0, y: 0, z: 0, w: 64, h: 64, d: 64 } },
    ] }))).toThrow('fill 需要 from/to 与 block')
  })

  it('converts known object templates mistakenly returned as asset placements', () => {
    const manifest = {
      version: 2 as const,
      assets: {
        'bld-hut-a': { id: 'bld-hut-a', category: 'building' as const, url: '/x.glb', footprint: [2, 3] as [number, number], height: 2, thumbnail: '/x.png', sway: 0 },
      },
    }
    const doc = assembleWorld({
      size: { width: 16, height: 16, depth: 16 },
      assetPlacements: [
        { assetId: 'manor-main-house', placementId: 'main-house', anchor: { x: 4, y: 1, z: 4 }, rotation: 1 },
        { assetId: 'bld-hut-a', placementId: 'legacy-glb', anchor: { x: 12, y: 1, z: 12 }, rotation: 180 },
      ],
      locations: [{ name: '主楼', objectId: 'main-house' }],
      lockedObjectIds: ['main-house'],
    }, 'mist-manor', 'legacy-template-placement', manifest)
    expect(doc.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'main-house', objectType: 'manor-main-house', rotation: 90 }),
    ]))
    expect(doc.locations).toEqual([{ name: '主楼', objectId: 'main-house' }])
    expect(doc.lockedObjectIds).toContain('main-house')
    expect(doc.assetPlacements?.find(placement => placement.id === 'legacy-glb')?.rotation).toBe(2)
  })

  it('accepts a building template or building asset for a required semantic location', async () => {
    const manifest = {
      version: 2 as const,
      assets: {
        'bld-hut-a': { id: 'bld-hut-a', category: 'building' as const, url: '/x.glb', footprint: [2, 2] as [number, number], height: 2, thumbnail: '/x.png', sway: 0 },
      },
    }
    const complete = async () => JSON.stringify({
      size: { width: 16, height: 16, depth: 16 },
      assetPlacements: [{ assetId: 'bld-hut-a', placementId: 'cafe-building', anchor: { x: 4, y: 1, z: 4 } }],
      locations: [{ name: '街角咖啡馆', objectId: 'cafe-building' }],
    })
    const byAsset = await generateWorld('咖啡馆', 'mist-manor', {
      id: 'required-cafe-asset', requiredLocationNames: ['街角咖啡馆'], assets: manifest, complete,
    })
    expect(byAsset.locations[0].objectId).toBe('cafe-building')

    const byTemplate = await generateWorld('咖啡馆', 'mist-manor', {
      id: 'required-cafe-template', requiredLocationNames: ['街角咖啡馆'],
      complete: async () => JSON.stringify({
        size: { width: 16, height: 16, depth: 16 },
        ops: [{ kind: 'place-object', objectId: 'cafe-house', objectType: 'manor-main-house', anchor: { x: 4, y: 1, z: 4 } }],
        locations: [{ name: '街角咖啡馆', objectId: 'cafe-house' }],
      }),
    })
    expect(byTemplate.locations[0].objectId).toBe('cafe-house')
  })
})
