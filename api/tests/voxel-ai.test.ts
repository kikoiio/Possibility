import { describe, expect, it } from 'vitest'
import { applyEdits, createEmptyWorld, type VoxelDocument } from '@possibility/voxel-contract'
import { EditPlannerError, parseEditOperations, planEdits } from '../src/voxel/edit-planner'
import { assembleWorld, generateWorld, WorldGeneratorError } from '../src/voxel/generate'
import { buildEditPlannerMessages, buildWorldGeneratorMessages, worldSummary } from '../src/voxel/prompts'

const at = (x: number, y: number, z: number) => ({ x, y, z })

function groundedWorld(): VoxelDocument {
  const base = createEmptyWorld({ width: 32, height: 16, depth: 32 }, 'mist-manor', 'test')
  return applyEdits(base, [
    { kind: 'fill', from: at(0, 0, 0), to: at(31, 0, 31), block: 'grass' },
    { kind: 'place-object', objectType: 'manor-main-house', anchor: at(4, 1, 4), rotation: 0, objectId: 'house' },
  ]).document
}

describe('parseEditOperations', () => {
  it('parses all five op kinds and strips markdown fences', () => {
    const content = '```json\n{"ops":[{"kind":"set-block","at":{"x":1,"y":1,"z":1},"block":"stone"},{"kind":"fill","from":{"x":0,"y":0,"z":0},"to":{"x":2,"y":0,"z":2},"block":"cobble"},{"kind":"place-object","objectType":"stone-lantern","anchor":{"x":3,"y":1,"z":3},"rotation":90},{"kind":"move-object","objectId":"house","anchor":{"x":8,"y":1,"z":8}},{"kind":"remove-object","objectId":"old"}]}\n```'
    const ops = parseEditOperations(content)
    expect(ops).toHaveLength(5)
    expect(ops[0]).toEqual({ kind: 'set-block', at: at(1, 1, 1), block: 'stone' })
    expect(ops[2]).toMatchObject({ kind: 'place-object', rotation: 90 })
  })

  it('rejects malformed ops with a diagnosable error', () => {
    expect(() => parseEditOperations('no json here')).toThrow(EditPlannerError)
    expect(() => parseEditOperations('{"ops":[]}')).toThrow(/ops 为空/)
    expect(() => parseEditOperations('{"ops":[{"kind":"set-block","at":{"x":1.5,"y":1,"z":1},"block":"stone"}]}')).toThrow(/ops\[0\]/)
    expect(() => parseEditOperations('{"ops":[{"kind":"teleport"}]}')).toThrow(/未知操作/)
  })

  it('S2b: parses the three asset op kinds with quarter-turn rotation', () => {
    const ops = parseEditOperations('{"ops":['
      + '{"kind":"place-asset","assetId":"bld-hut-a","anchor":{"x":4,"y":1,"z":4},"rotation":1,"seed":7},'
      + '{"kind":"move-asset","placementId":"ast-a","anchor":{"x":8,"y":1,"z":8},"rotation":3},'
      + '{"kind":"remove-asset","placementId":"ast-b"}'
      + ']}')
    expect(ops).toEqual([
      { kind: 'place-asset', assetId: 'bld-hut-a', anchor: at(4, 1, 4), rotation: 1, seed: 7 },
      { kind: 'move-asset', placementId: 'ast-a', anchor: at(8, 1, 8), rotation: 3 },
      { kind: 'remove-asset', placementId: 'ast-b' },
    ])
    // rotation 角度制(90)必须被拒——资产 op 是 0..3 四分之一圈
    expect(() => parseEditOperations('{"ops":[{"kind":"place-asset","assetId":"bld-hut-a","anchor":{"x":4,"y":1,"z":4},"rotation":90}]}')).toThrow(/rotation/)
    expect(() => parseEditOperations('{"ops":[{"kind":"move-asset","placementId":"a"}]}')).toThrow(/anchor/)
    expect(() => parseEditOperations('{"ops":[{"kind":"remove-asset"}]}')).toThrow(/placementId/)
  })
})

describe('planEdits（mock LLM 三态）', () => {
  it('一次通过：合法输出直接返回', async () => {
    const doc = groundedWorld()
    const ops = await planEdits(doc, '在庭院加一座石灯笼', {
      complete: async () => '{"ops":[{"kind":"place-object","objectType":"stone-lantern","anchor":{"x":20,"y":1,"z":20},"rotation":0}]}',
    })
    expect(ops).toHaveLength(1)
  })

  it('重试通过：首次非法（悬空/未知方块），带 issue 重试后成功', async () => {
    const doc = groundedWorld()
    const seen: string[] = []
    let call = 0
    const ops = await planEdits(doc, '放一座石灯笼', {
      complete: async (messages) => {
        call += 1
        seen.push(messages.at(-1)!.content as string)
        if (call === 1) return '{"ops":[{"kind":"place-object","objectType":"stone-lantern","anchor":{"x":20,"y":9,"z":20},"rotation":0}]}' // 悬空
        if (call === 2) return '{"ops":[{"kind":"set-block","at":{"x":2,"y":1,"z":2},"block":"ectoplasm"}]}' // 未知方块
        return '{"ops":[{"kind":"place-object","objectType":"stone-lantern","anchor":{"x":20,"y":1,"z":20},"rotation":0}]}'
      },
    })
    expect(call).toBe(3)
    expect(ops).toHaveLength(1)
    // 第二次重试的提示里带有上一次校验的 issue
    expect(seen[2]).toContain('未通过世界校验')
  })

  it('三次失败：抛出带 issue 的 EditPlannerError，不产出坏数据', async () => {
    const doc = groundedWorld()
    await expect(planEdits(doc, '乱来', {
      complete: async () => '{"ops":[{"kind":"place-object","objectType":"stone-lantern","anchor":{"x":20,"y":9,"z":20},"rotation":0}]}',
    })).rejects.toMatchObject({ name: 'EditPlannerError', issues: [expect.objectContaining({ code: 'floating-object' })] })
  })
})

describe('generateWorld（mock LLM 三态）', () => {
  const validPayload = JSON.stringify({
    size: { width: 32, height: 16, depth: 32 },
    groundBlock: 'grass',
    ops: [
      { kind: 'fill', from: { x: 12, y: 1, z: 12 }, to: { x: 16, y: 1, z: 16 }, block: 'cobble' },
      { kind: 'place-object', objectType: 'manor-main-house', anchor: { x: 4, y: 1, z: 4 }, rotation: 0, objectId: 'house', label: '主楼' },
      { kind: 'place-object', objectType: 'manor-greenhouse', anchor: { x: 22, y: 1, z: 6 }, rotation: 0, objectId: 'greenhouse', label: '温室' },
    ],
    locations: [{ name: '主楼', objectId: 'house' }, { name: '温室', objectId: 'greenhouse' }],
    spaceEntries: [{ spaceId: 'main-hall', label: '进入主楼 →', at: { x: 7, y: 1, z: 10 } }],
    lockedObjectIds: ['house'],
  })

  it('一次通过：产出合法 VoxelDocument，地点/绑定齐全', async () => {
    const doc = await generateWorld('雾影庄外景：山间庄园，有主楼、庭院和温室', 'mist-manor', {
      complete: async () => validPayload,
      id: 'gen-1',
    })
    expect(doc.size).toEqual({ width: 32, height: 16, depth: 32 })
    expect(doc.locations.map((l) => l.name).sort()).toEqual(['主楼', '温室'])
    expect(doc.lockedObjectIds).toEqual(['house'])
    expect(doc.objects).toHaveLength(2)
    expect(doc.spaceEntries).toHaveLength(1)
  })

  it('重试通过：首次悬空物体，带 issue 重试后成功', async () => {
    let call = 0
    const doc = await generateWorld('庭院加灯笼', 'mist-manor', {
      complete: async () => {
        call += 1
        if (call === 1) {
          return JSON.stringify({
            size: { width: 16, height: 16, depth: 16 },
            ops: [{ kind: 'place-object', objectType: 'stone-lantern', anchor: { x: 4, y: 9, z: 4 }, rotation: 0, objectId: 'lamp' }],
          })
        }
        return JSON.stringify({
          size: { width: 16, height: 16, depth: 16 },
          ops: [{ kind: 'place-object', objectType: 'stone-lantern', anchor: { x: 4, y: 1, z: 4 }, rotation: 0, objectId: 'lamp' }],
        })
      },
      id: 'gen-2',
    })
    expect(call).toBe(2)
    expect(doc.objects[0].anchor).toEqual({ x: 4, y: 1, z: 4 })
  })

  it('三次失败：抛出 WorldGeneratorError 而非入库坏数据（N10）', async () => {
    await expect(generateWorld('坏世界', 'mist-manor', {
      complete: async () => JSON.stringify({
        size: { width: 16, height: 16, depth: 16 },
        ops: [{ kind: 'place-object', objectType: 'stone-lantern', anchor: { x: 4, y: 9, z: 4 }, rotation: 0, objectId: 'lamp' }],
      }),
      id: 'gen-3',
    })).rejects.toMatchObject({ name: 'WorldGeneratorError' })
  })

  it('assembleWorld rejects locations bound to missing objects', () => {
    expect(() => assembleWorld({
      size: { width: 16, height: 16, depth: 16 },
      locations: [{ name: '主楼', objectId: 'ghost' }],
    }, 'mist-manor', 'x')).toThrow(/不存在的物体/)
  })
})

describe('S2b prompt 契约(F5)', () => {
  const manifest = {
    version: 2 as const,
    assets: {
      'bld-hut-a': { id: 'bld-hut-a', category: 'building' as const, url: '/x.glb', footprint: [2, 2] as [number, number], height: 2, thumbnail: '/x.png', sway: 0 },
      'veg-tree-a': { id: 'veg-tree-a', category: 'vegetation' as const, url: '/x.glb', footprint: [1, 1] as [number, number], height: 3, thumbnail: '/x.png', sway: 0.1 },
    },
  }

  it('生成 prompt 含 assetPlacements 契约与 placements 优先指引,旧字段名不再出现', () => {
    const [system] = buildWorldGeneratorMessages('山间小屋', 'mist-manor', manifest)
    expect(system.content).toContain('"assetPlacements"')
    expect(system.content).toContain('优先用 assetPlacements 摆放库内资产')
    expect(system.content).not.toContain('"placements"')
    // 资产目录注入
    expect(system.content).toContain('可用资产库')
    expect(system.content).toContain('bld-hut-a（building，占地 2×2，高 2）')
    // 无清单时省略资产库行
    const [noCatalog] = buildWorldGeneratorMessages('山间小屋', 'mist-manor')
    expect(noCatalog.content).not.toContain('可用资产库')
  })

  it('编辑规划 prompt 含三个资产 op 与资产库', () => {
    const [system] = buildEditPlannerMessages(groundedWorld(), '加一棵树', manifest)
    expect(system.content).toContain('place-asset')
    expect(system.content).toContain('move-asset')
    expect(system.content).toContain('remove-asset')
    expect(system.content).toContain('可用资产库')
  })

  it('worldSummary 列出既有资产摆放', () => {
    const doc = applyEdits(groundedWorld(), [
      { kind: 'place-asset', assetId: 'veg-tree-a', anchor: at(9, 1, 9), rotation: 2, placementId: 'ast-t', seed: 1 },
    ]).document
    const summary = worldSummary(doc)
    expect(summary).toContain('已有资产摆放')
    expect(summary).toContain('ast-t: veg-tree-a @ (9,1,9) 旋转180°')
  })
})
