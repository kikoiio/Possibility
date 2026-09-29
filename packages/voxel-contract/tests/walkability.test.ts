import { describe, expect, it } from 'vitest'
import {
  applyEdits, createBlockRegistry, createEmptyWorld, setBlockMut, validateWalkability,
} from '../src'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const registry = createBlockRegistry('mist-manor')

/** 32×32 平地(草方块地面),边界开放 */
function flatWorld(width = 32, depth = 32) {
  const doc = createEmptyWorld({ width, height: 32, depth }, 'mist-manor', 'test')
  for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) setBlockMut(doc, at(x, 0, z), 'grass')
  return doc
}

/** 用实心墙把以 (cx,cz) 为中心的 3×3 区域围起来(高 3 格) */
function wallOff(doc: ReturnType<typeof flatWorld>, cx: number, cz: number) {
  for (let y = 1; y <= 3; y++) {
    for (let d = -1; d <= 1; d++) {
      setBlockMut(doc, at(cx + d, y, cz - 2), 'stone')
      setBlockMut(doc, at(cx + d, y, cz + 2), 'stone')
      setBlockMut(doc, at(cx - 2, y, cz + d), 'stone')
      setBlockMut(doc, at(cx + 2, y, cz + d), 'stone')
    }
  }
}

/** 5×5 结构墙房间(plaster 墙+瓦顶),西墙留 1×2 门洞;withLantern 时屋内放灯笼 */
function room(withLantern: boolean) {
  const doc = flatWorld()
  for (let y = 1; y <= 3; y++) {
    for (let i = 12; i <= 16; i++) {
      setBlockMut(doc, at(i, y, 12), 'plaster-wall')
      setBlockMut(doc, at(i, y, 16), 'plaster-wall')
      setBlockMut(doc, at(12, y, i), 'plaster-wall')
      setBlockMut(doc, at(16, y, i), 'plaster-wall')
    }
  }
  for (let x = 12; x <= 16; x++) for (let z = 12; z <= 16; z++) setBlockMut(doc, at(x, 4, z), 'roof-tile')
  // 门洞:西墙中段 1 宽 2 高
  setBlockMut(doc, at(12, 1, 14), 'air')
  setBlockMut(doc, at(12, 2, 14), 'air')
  if (withLantern) setBlockMut(doc, at(14, 1, 14), 'lantern')
  return doc
}

describe('validateWalkability R1 净高', () => {
  it('净高 1 格的门洞(紧邻可行走地面)→ 报 walk-clearance 且定位门洞', () => {
    const doc = flatWorld()
    // 门洞:通道格 (16,1,10) 可走,但 (16,2,10) 压了过梁 → 净高 1
    setBlockMut(doc, at(16, 2, 10), 'stone')
    const issues = validateWalkability(doc, registry)
    const hit = issues.find((i) => i.code === 'walk-clearance')
    expect(hit).toBeDefined()
    expect(hit!.at).toEqual(at(16, 1, 10))
  })

  it('净高 2 格的通道 → 不报', () => {
    const doc = flatWorld()
    setBlockMut(doc, at(16, 3, 10), 'stone') // 净高 2(1、2 层空)
    const issues = validateWalkability(doc, registry)
    expect(issues.filter((i) => i.code === 'walk-clearance')).toEqual([])
  })
})

describe('validateWalkability R5 地面完整性', () => {
  /** 挖一圈 1 格宽护城河,把中心 4×4 区域围成孤岛(孤岛不触世界边界) */
  function digMoat(doc: ReturnType<typeof flatWorld>, cx: number, cz: number) {
    for (let d = -3; d <= 3; d++) {
      setBlockMut(doc, at(cx + d, 0, cz - 3), 'air')
      setBlockMut(doc, at(cx + d, 0, cz + 3), 'air')
      setBlockMut(doc, at(cx - 3, 0, cz + d), 'air')
      setBlockMut(doc, at(cx + 3, 0, cz + d), 'air')
    }
  }

  it('孤岛仅可跳入(无步行绕行)→ 报 walk-gap,at 为缺口前格', () => {
    const doc = flatWorld()
    digMoat(doc, 16, 16)
    const issues = validateWalkability(doc, registry)
    const hit = issues.find((i) => i.code === 'walk-gap')
    expect(hit).toBeDefined()
    // 缺口前格在护城河外圈(距岛 2 格处)
    expect(Math.abs(hit!.at!.x - 16) === 2 || Math.abs(hit!.at!.z - 16) === 2).toBe(true)
  })

  it('护城河上架桥(存在步行绕行)→ 不报', () => {
    const doc = flatWorld()
    digMoat(doc, 16, 16)
    setBlockMut(doc, at(16 - 3, 0, 16), 'wood-plank')
    const issues = validateWalkability(doc, registry)
    expect(issues.filter((i) => i.code === 'walk-gap')).toEqual([])
  })
})

describe('validateWalkability R4 高差突变', () => {
  /** 2 格高石台(顶面 y=3 可站),台上放石灯笼(人工结构) */
  function platformWithLantern(doc: ReturnType<typeof flatWorld>, withStep: boolean) {
    for (const x of [18, 19]) for (const y of [1, 2]) setBlockMut(doc, at(x, y, 16), 'stone')
    if (withStep) setBlockMut(doc, at(20, 1, 16), 'stone') // 东侧台阶:y1→(20,2)→台面 y3(避开灯笼占位)
    const placed = applyEdits(doc, [
      { kind: 'place-object', objectType: 'stone-lantern', anchor: at(18, 3, 16), rotation: 0 },
    ]).document
    return { ...placed, locations: [{ name: '庭院', objectId: placed.objects[0].id }] }
  }

  it('台面缺一级(高差 2,属人工结构)→ 报 walk-stairs,at 为高处面', () => {
    const doc = platformWithLantern(flatWorld(), false)
    // 石灯笼在台上,但地面到台面高差 2 → 断级
    const issues = validateWalkability(doc, registry)
    const hit = issues.find((i) => i.code === 'walk-stairs')
    expect(hit).toBeDefined()
    expect(hit!.at!.y).toBe(3)
    expect([18, 19]).toContain(hit!.at!.x)
    expect(hit!.at!.z).toBe(16)
  })

  it('连续 1 格台阶上台面 → 不报 walk-stairs', () => {
    const doc = platformWithLantern(flatWorld(), true)
    const issues = validateWalkability(doc, registry)
    expect(issues.filter((i) => i.code === 'walk-stairs')).toEqual([])
  })

  it('远离任何物体的自然 2 格高差 → 不报', () => {
    const doc = flatWorld()
    for (const y of [1, 2]) setBlockMut(doc, at(24, y, 24), 'stone') // 荒野石柱
    const issues = validateWalkability(doc, registry)
    expect(issues.filter((i) => i.code === 'walk-stairs')).toEqual([])
  })

  it('主楼屋顶(支撑面是物体占据格)→ 豁免,不报 walk-stairs', () => {
    // 回归:屋顶是可站立的人工面,但它不是「该走上去的台面」——支撑它的瓦片属物体占据格
    const placed = applyEdits(flatWorld(40, 40), [
      { kind: 'place-object', objectType: 'manor-main-house', anchor: at(12, 1, 12), rotation: 0 },
    ]).document
    const doc = { ...placed, locations: [{ name: '主楼', objectId: placed.objects[0].id }] }
    const issues = validateWalkability(doc, registry)
    expect(issues.filter((i) => i.code === 'walk-stairs')).toEqual([])
  })
})

describe('validateWalkability R3 室内照明', () => {
  it('全封闭无灯房间(门可进)→ 报 walk-lighting,at 为最暗格', () => {
    const issues = validateWalkability(room(false), registry)
    const hit = issues.find((i) => i.code === 'walk-lighting')
    expect(hit).toBeDefined()
    expect(hit!.message).toContain('照明不足')
    expect(hit!.at!.x).toBeGreaterThanOrEqual(12)
    expect(hit!.at!.x).toBeLessThanOrEqual(16)
  })

  it('房间内有灯笼 → 不报', () => {
    const issues = validateWalkability(room(true), registry)
    expect(issues.filter((i) => i.code === 'walk-lighting')).toEqual([])
  })

  it('露天世界与树叶顶棚 → 都不算室内,不报', () => {
    const open = validateWalkability(flatWorld(), registry)
    expect(open.filter((i) => i.code === 'walk-lighting')).toEqual([])
    const doc = flatWorld()
    setBlockMut(doc, at(16, 3, 16), 'leaves') // 树冠遮顶,非人造屋顶
    const underTree = validateWalkability(doc, registry)
    expect(underTree.filter((i) => i.code === 'walk-lighting')).toEqual([])
  })
})

describe('validateWalkability 总装(AC5)', () => {
  it('合规小世界(有门、有灯、绑定物体可达)→ 零 issue', () => {
    // 带灯房间 + 屋内长凳绑定地点 + 室外石灯笼绑定人物
    const base = room(true)
    const placed = applyEdits(base, [
      { kind: 'place-object', objectType: 'bench', anchor: at(14, 1, 13), rotation: 0 },
      { kind: 'place-object', objectType: 'stone-lantern', anchor: at(6, 1, 6), rotation: 0 },
    ]).document
    const doc = {
      ...placed,
      objects: placed.objects.map((o, i) =>
        i === 1 ? { ...o, binding: { kind: 'person' as const, personId: 'p1' } } : o),
      locations: [{ name: '内室', objectId: placed.objects[0].id }],
    }
    expect(validateWalkability(doc, registry)).toEqual([])
  })
})

describe('validateWalkability R2 连通性', () => {
  it('开放世界中绑定物体可达 → 无 walk-connectivity', () => {
    const doc = flatWorld()
    const placed = applyEdits(doc, [
      { kind: 'place-object', objectType: 'stone-lantern', anchor: at(8, 1, 8), rotation: 0 },
    ]).document
    const withBinding = {
      ...placed,
      locations: [{ name: '庭院', objectId: placed.objects[0].id }],
    }
    const issues = validateWalkability(withBinding, registry)
    expect(issues.filter((i) => i.code === 'walk-connectivity')).toEqual([])
  })

  it('物体被实心墙围死 → 报 walk-connectivity 且 at 为锚点', () => {
    let doc = flatWorld()
    doc = applyEdits(doc, [
      { kind: 'place-object', objectType: 'stone-lantern', anchor: at(16, 1, 16), rotation: 0 },
    ]).document
    wallOff(doc, 16, 16)
    const withBinding = {
      ...doc,
      locations: [{ name: '石灯', objectId: doc.objects[0].id }],
    }
    const issues = validateWalkability(withBinding, registry)
    const hit = issues.find((i) => i.code === 'walk-connectivity')
    expect(hit).toBeDefined()
    expect(hit!.at).toEqual(at(16, 1, 16))
  })
})
