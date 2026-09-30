import { describe, expect, it } from 'vitest'
import {
  AIR, applyEdits, createEmptyWorld, getBlock, getObjectTemplate, rotatedOffsets,
} from '../src'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const world = () => createEmptyWorld({ width: 32, height: 32, depth: 32 }, 'mist-manor', 'test')

describe('applyEdits: set-block / fill', () => {
  it('applies set-block immutably and reports changed sections', () => {
    const doc = world()
    const result = applyEdits(doc, [{ kind: 'set-block', at: at(2, 3, 2), block: 'stone' }])
    expect(getBlock(result.document, at(2, 3, 2))).toBe('stone')
    expect(getBlock(doc, at(2, 3, 2))).toBe(AIR) // 原文档不变
    expect(result.changedSections).toEqual(['0,0,0'])
    expect(result.affectedObjectIds).toEqual([])
  })

  it('fill covers the inclusive box', () => {
    const result = applyEdits(world(), [{ kind: 'fill', from: at(1, 0, 1), to: at(3, 1, 2), block: 'grass' }])
    expect(getBlock(result.document, at(1, 0, 1))).toBe('grass')
    expect(getBlock(result.document, at(3, 1, 2))).toBe('grass')
    expect(getBlock(result.document, at(4, 1, 2))).toBe(AIR)
    expect(getBlock(result.document, at(2, 2, 1))).toBe(AIR)
  })
})

describe('applyEdits: objects', () => {
  it('place-object brands template cells and registers objectCells', () => {
    const template = getObjectTemplate('stone-lantern')!
    const result = applyEdits(world(), [{ kind: 'place-object', objectType: 'stone-lantern', anchor: at(5, 1, 5), rotation: 0 }])
    const doc = result.document
    expect(doc.objects).toHaveLength(1)
    expect(doc.objectCells).toHaveLength(1)
    expect(doc.objectCells[0].cells).toHaveLength(template.cells.length)
    expect(getBlock(doc, at(5, 1, 5))).toBe('stone')
    expect(getBlock(doc, at(5, 2, 5))).toBe('lantern')
    expect(result.affectedObjectIds).toEqual([doc.objects[0].id])
  })

  it('rotatedOffsets rotates in the horizontal plane and normalizes to origin', () => {
    const offsets = rotatedOffsets([{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }], 90)
    expect(offsets).toContainEqual({ x: 0, y: 0, z: 0 })
    expect(offsets).toContainEqual({ x: 0, y: 0, z: 2 })
  })

  it('move-object clears old cells and brands new ones', () => {
    const placed = applyEdits(world(), [{ kind: 'place-object', objectType: 'stone-lantern', anchor: at(5, 1, 5), rotation: 0, objectId: 'obj-a' }])
    const moved = applyEdits(placed.document, [{ kind: 'move-object', objectId: 'obj-a', anchor: at(10, 1, 10) }])
    expect(getBlock(moved.document, at(5, 1, 5))).toBe(AIR)
    expect(getBlock(moved.document, at(10, 1, 10))).toBe('stone')
    expect(moved.document.objects[0].anchor).toEqual(at(10, 1, 10))
    expect(moved.document.objectCells[0].cells).toContainEqual(at(10, 2, 10))
  })

  it('remove-object clears cells and cascades bindings/locks', () => {
    const placed = applyEdits(world(), [{ kind: 'place-object', objectType: 'stone-lantern', anchor: at(5, 1, 5), rotation: 0, objectId: 'obj-a' }])
    const withMeta = {
      ...placed.document,
      locations: [{ name: '庭院', objectId: 'obj-a' }],
      lockedObjectIds: ['obj-a'],
    }
    const removed = applyEdits(withMeta, [{ kind: 'remove-object', objectId: 'obj-a' }])
    expect(removed.document.objects).toHaveLength(0)
    expect(removed.document.objectCells).toHaveLength(0)
    expect(removed.document.locations).toHaveLength(0)
    expect(removed.document.lockedObjectIds).toHaveLength(0)
    expect(getBlock(removed.document, at(5, 1, 5))).toBe(AIR)
  })

  it('unknown object type throws', () => {
    expect(() => applyEdits(world(), [{ kind: 'place-object', objectType: 'nope', anchor: at(0, 0, 0), rotation: 0 }])).toThrow(/unknown object type/)
  })

  it('collects changed sections across mixed ops without duplicates', () => {
    const doc = world()
    const result = applyEdits(doc, [
      { kind: 'set-block', at: at(1, 1, 1), block: 'stone' },
      { kind: 'set-block', at: at(2, 1, 1), block: 'stone' },
      { kind: 'set-block', at: at(20, 1, 1), block: 'stone' },
    ])
    expect(result.changedSections.sort()).toEqual(['0,0,0', '1,0,0'])
  })

  it('place-asset appends a placement, deriving id and seed when omitted', () => {
    const doc = world()
    const result = applyEdits(doc, [{ kind: 'place-asset', assetId: 'bld-hut-a', anchor: at(4, 1, 4), rotation: 1 }])
    const placement = result.document.assetPlacements![0]
    expect(placement.assetId).toBe('bld-hut-a')
    expect(placement.anchor).toEqual([4, 1, 4])
    expect(placement.rotation).toBe(1)
    expect(placement.id).toMatch(/^ast-/)
    expect(Number.isInteger(placement.seed)).toBe(true)
    // 缺省 seed 由 anchor 确定性派生
    const again = applyEdits(doc, [{ kind: 'place-asset', assetId: 'bld-hut-a', anchor: at(4, 1, 4), rotation: 1 }])
    expect(again.document.assetPlacements![0].seed).toBe(placement.seed)
    // 原文档不可变
    expect(doc.assetPlacements).toBeUndefined()
  })

  it('place-asset honors explicit placementId and seed', () => {
    const result = applyEdits(world(), [{ kind: 'place-asset', assetId: 'veg-tree-a', anchor: at(1, 1, 1), rotation: 0, placementId: 'ast-x', seed: 7 }])
    expect(result.document.assetPlacements![0]).toMatchObject({ id: 'ast-x', seed: 7 })
  })

  it('move-asset updates anchor and rotation, leaving others untouched', () => {
    const base = applyEdits(world(), [
      { kind: 'place-asset', assetId: 'bld-hut-a', anchor: at(4, 1, 4), rotation: 0, placementId: 'ast-a' },
      { kind: 'place-asset', assetId: 'veg-tree-a', anchor: at(8, 1, 8), rotation: 2, placementId: 'ast-b' },
    ]).document
    const moved = applyEdits(base, [{ kind: 'move-asset', placementId: 'ast-a', anchor: at(10, 1, 10), rotation: 3 }])
    const a = moved.document.assetPlacements!.find((p) => p.id === 'ast-a')!
    const b = moved.document.assetPlacements!.find((p) => p.id === 'ast-b')!
    expect(a.anchor).toEqual([10, 1, 10])
    expect(a.rotation).toBe(3)
    expect(b.anchor).toEqual([8, 1, 8])
    expect(b.rotation).toBe(2)
    // 原地旋转:同 anchor 只改 rotation
    const rotated = applyEdits(base, [{ kind: 'move-asset', placementId: 'ast-a', anchor: at(4, 1, 4), rotation: 1 }])
    expect(rotated.document.assetPlacements!.find((p) => p.id === 'ast-a')!.rotation).toBe(1)
    // 不带 rotation 时保持原朝向
    const anchorOnly = applyEdits(base, [{ kind: 'move-asset', placementId: 'ast-a', anchor: at(5, 1, 5) }])
    expect(anchorOnly.document.assetPlacements!.find((p) => p.id === 'ast-a')!.rotation).toBe(0)
  })

  it('remove-asset removes by placementId', () => {
    const base = applyEdits(world(), [
      { kind: 'place-asset', assetId: 'bld-hut-a', anchor: at(4, 1, 4), rotation: 0, placementId: 'ast-a' },
      { kind: 'place-asset', assetId: 'veg-tree-a', anchor: at(8, 1, 8), rotation: 0, placementId: 'ast-b' },
    ]).document
    const removed = applyEdits(base, [{ kind: 'remove-asset', placementId: 'ast-a' }])
    expect(removed.document.assetPlacements!.map((p) => p.id)).toEqual(['ast-b'])
  })

  it('move-asset / remove-asset throw on unknown placementId', () => {
    const doc = world()
    expect(() => applyEdits(doc, [{ kind: 'move-asset', placementId: 'nope', anchor: at(0, 0, 0) }])).toThrow(/not found/)
    expect(() => applyEdits(doc, [{ kind: 'remove-asset', placementId: 'nope' }])).toThrow(/not found/)
  })
})
