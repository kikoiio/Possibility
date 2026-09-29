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
