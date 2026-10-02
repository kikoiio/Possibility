import { describe, expect, it } from 'vitest'
import { getBlock, validateDocument, validateWalkability } from '@possibility/voxel-contract'
import type { ChatMessage } from '../llm/client'
import { assembleWorld, generateWorld, WorldGeneratorError } from './generate'
import type { CompleteFn } from './edit-planner'

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
      assetPlacements: [{ assetId: 'bld-hut-a', anchor: { x: 4, y: 1, z: 4 }, rotation: 90 }],
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
