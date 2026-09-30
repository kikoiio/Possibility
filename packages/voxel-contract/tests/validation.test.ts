import { describe, expect, it } from 'vitest'
import {
  applyEdits, createBlockRegistry, createEmptyWorld, setBlockMut, validateDocument, validateEdit,
  type AssetManifest,
} from '../src'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const registry = createBlockRegistry('mist-manor')

function groundedWorld() {
  const doc = createEmptyWorld({ width: 32, height: 32, depth: 32 }, 'mist-manor', 'test')
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) setBlockMut(doc, at(x, 0, z), 'grass')
  return doc
}

describe('validateDocument', () => {
  it('accepts a sound world', () => {
    const doc = groundedWorld()
    const placed = applyEdits(doc, [{ kind: 'place-object', objectType: 'stone-lantern', anchor: at(5, 1, 5), rotation: 0 }])
    expect(validateDocument(placed.document, registry)).toEqual([])
  })

  it('flags out-of-bounds sections', () => {
    const doc = groundedWorld()
    setBlockMut(doc, at(0, 0, 0), 'grass')
    doc.sections['9,9,9'] = doc.sections['0,0,0']
    const issues = validateDocument(doc, registry)
    expect(issues.some((i) => i.code === 'out-of-bounds')).toBe(true)
  })

  it('flags unknown blocks in palettes', () => {
    const doc = groundedWorld()
    doc.sections['0,0,0'] = { palette: ['air', 'ectoplasm'], indices: new Uint16Array(4096), nonAirCount: 1 }
    const issues = validateDocument(doc, registry)
    expect(issues.some((i) => i.code === 'unknown-block' && i.message.includes('ectoplasm'))).toBe(true)
  })

  it('flags floating objects', () => {
    const doc = groundedWorld()
    const placed = applyEdits(doc, [{ kind: 'place-object', objectType: 'stone-lantern', anchor: at(5, 8, 5), rotation: 0 }])
    const issues = validateDocument(placed.document, registry)
    expect(issues.some((i) => i.code === 'floating-object')).toBe(true)
  })

  it('flags overlapping objects', () => {
    const doc = groundedWorld()
    const placed = applyEdits(doc, [
      { kind: 'place-object', objectType: 'stone-lantern', anchor: at(5, 1, 5), rotation: 0, objectId: 'a' },
      { kind: 'place-object', objectType: 'stone-lantern', anchor: at(5, 1, 5), rotation: 0, objectId: 'b' },
    ])
    const issues = validateDocument(placed.document, registry)
    expect(issues.some((i) => i.code === 'object-overlap')).toBe(true)
  })

  it('flags unbound locations', () => {
    const doc = { ...groundedWorld(), locations: [{ name: '主楼', objectId: 'ghost' }] }
    const issues = validateDocument(doc, registry)
    expect(issues.some((i) => i.code === 'location-unbound' && i.message.includes('主楼'))).toBe(true)
  })
})

describe('validateEdit', () => {
  it('rejects out-of-bounds block edits', () => {
    const issues = validateEdit(groundedWorld(), [{ kind: 'set-block', at: at(40, 0, 0), block: 'stone' }], registry)
    expect(issues.some((i) => i.code === 'out-of-bounds')).toBe(true)
  })

  it('rejects unknown blocks and object types', () => {
    const doc = groundedWorld()
    expect(validateEdit(doc, [{ kind: 'set-block', at: at(1, 1, 1), block: 'ectoplasm' }], registry).some((i) => i.code === 'unknown-block')).toBe(true)
    expect(validateEdit(doc, [{ kind: 'place-object', objectType: 'nope', anchor: at(1, 1, 1), rotation: 0 }], registry).some((i) => i.code === 'unknown-block')).toBe(true)
  })

  it('rejects edits touching locked object cells (AC15)', () => {
    const placed = applyEdits(groundedWorld(), [{ kind: 'place-object', objectType: 'stone-lantern', anchor: at(5, 1, 5), rotation: 0, objectId: 'a' }])
    const doc = { ...placed.document, lockedObjectIds: ['a'] }
    expect(validateEdit(doc, [{ kind: 'set-block', at: at(5, 1, 5), block: 'air' }], registry).some((i) => i.code === 'locked-violation')).toBe(true)
    expect(validateEdit(doc, [{ kind: 'move-object', objectId: 'a', anchor: at(8, 1, 8) }], registry).some((i) => i.code === 'locked-violation')).toBe(true)
    expect(validateEdit(doc, [{ kind: 'remove-object', objectId: 'a' }], registry).some((i) => i.code === 'locked-violation')).toBe(true)
  })

  it('rejects overlapping and floating placements before apply', () => {
    const placed = applyEdits(groundedWorld(), [{ kind: 'place-object', objectType: 'stone-lantern', anchor: at(5, 1, 5), rotation: 0, objectId: 'a' }])
    const doc = placed.document
    expect(validateEdit(doc, [{ kind: 'place-object', objectType: 'stone-lantern', anchor: at(5, 1, 5), rotation: 0 }], registry).some((i) => i.code === 'object-overlap')).toBe(true)
    expect(validateEdit(doc, [{ kind: 'place-object', objectType: 'stone-lantern', anchor: at(9, 9, 9), rotation: 0 }], registry).some((i) => i.code === 'floating-object')).toBe(true)
  })

  it('accepts legal edits', () => {
    const doc = groundedWorld()
    expect(validateEdit(doc, [
      { kind: 'set-block', at: at(1, 1, 1), block: 'cobble' },
      { kind: 'place-object', objectType: 'stone-lantern', anchor: at(5, 1, 5), rotation: 0 },
    ], registry)).toEqual([])
  })
})

// ── S2b 资产摆放校验(F4)─────────────────────────
const testManifest: AssetManifest = {
  version: 2,
  assets: {
    'bld-hut-a': { id: 'bld-hut-a', category: 'building', url: '/x.glb', footprint: [2, 2], height: 2, thumbnail: '/x.png', sway: 0 },
    'veg-tree-a': { id: 'veg-tree-a', category: 'vegetation', url: '/x.glb', footprint: [1, 1], height: 3, thumbnail: '/x.png', sway: 0.1 },
  },
}

function worldWithHut(id = 'ast-a') {
  return applyEdits(groundedWorld(), [
    { kind: 'place-asset', assetId: 'bld-hut-a', anchor: at(10, 1, 10), rotation: 0, placementId: id },
  ]).document
}

describe('validateEdit asset placements', () => {
  it('accepts a legal place-asset', () => {
    expect(validateEdit(groundedWorld(), [
      { kind: 'place-asset', assetId: 'bld-hut-a', anchor: at(4, 1, 4), rotation: 1 },
    ], registry, testManifest)).toEqual([])
  })

  it('rejects unknown assetId', () => {
    const issues = validateEdit(groundedWorld(), [
      { kind: 'place-asset', assetId: 'bld-nope', anchor: at(4, 1, 4), rotation: 0 },
    ], registry, testManifest)
    expect(issues.some((i) => i.code === 'unknown-asset')).toBe(true)
  })

  it('rejects non-integer anchor and out-of-domain rotation', () => {
    const bad1 = validateEdit(groundedWorld(), [
      { kind: 'place-asset', assetId: 'bld-hut-a', anchor: at(4.5, 1, 4), rotation: 0 },
    ], registry, testManifest)
    expect(bad1.some((i) => i.code === 'invalid-meta' && i.message.includes('anchor'))).toBe(true)
    const bad2 = validateEdit(groundedWorld(), [
      { kind: 'place-asset', assetId: 'bld-hut-a', anchor: at(4, 1, 4), rotation: 4 as 0 },
    ], registry, testManifest)
    expect(bad2.some((i) => i.code === 'invalid-meta' && i.message.includes('rotation'))).toBe(true)
  })

  it('rejects footprint out of bounds', () => {
    const issues = validateEdit(groundedWorld(), [
      { kind: 'place-asset', assetId: 'bld-hut-a', anchor: at(31, 1, 31), rotation: 0 },
    ], registry, testManifest)
    expect(issues.some((i) => i.code === 'out-of-bounds')).toBe(true)
  })

  it('rejects overlap with another placement and with an object', () => {
    const doc = worldWithHut()
    const dup = validateEdit(doc, [
      { kind: 'place-asset', assetId: 'veg-tree-a', anchor: at(10, 1, 10), rotation: 0 },
    ], registry, testManifest)
    expect(dup.some((i) => i.code === 'asset-overlap' && i.message.includes('placement'))).toBe(true)

    const withObject = applyEdits(groundedWorld(), [
      { kind: 'place-object', objectType: 'stone-lantern', anchor: at(6, 1, 6), rotation: 0, objectId: 'obj-a' },
    ]).document
    const onObject = validateEdit(withObject, [
      { kind: 'place-asset', assetId: 'bld-hut-a', anchor: at(5, 1, 5), rotation: 0 },
    ], registry, testManifest)
    expect(onObject.some((i) => i.code === 'asset-overlap' && i.message.includes('object'))).toBe(true)
  })

  it('rejects floating placement', () => {
    const issues = validateEdit(groundedWorld(), [
      { kind: 'place-asset', assetId: 'bld-hut-a', anchor: at(4, 8, 4), rotation: 0 },
    ], registry, testManifest)
    expect(issues.some((i) => i.code === 'asset-overlap' && i.message.includes('support'))).toBe(true)
  })

  it('move-asset rejects unknown placementId, exempts self overlap', () => {
    const doc = worldWithHut()
    const missing = validateEdit(doc, [{ kind: 'move-asset', placementId: 'nope', anchor: at(1, 1, 1) }], registry, testManifest)
    expect(missing.some((i) => i.code === 'unknown-asset')).toBe(true)
    // 原地旋转(同 anchor)不算与自身冲突
    expect(validateEdit(doc, [{ kind: 'move-asset', placementId: 'ast-a', anchor: at(10, 1, 10), rotation: 2 }], registry, testManifest)).toEqual([])
    // 合法新位置
    expect(validateEdit(doc, [{ kind: 'move-asset', placementId: 'ast-a', anchor: at(20, 1, 20) }], registry, testManifest)).toEqual([])
  })

  it('remove-asset rejects unknown placementId', () => {
    const issues = validateEdit(worldWithHut(), [{ kind: 'remove-asset', placementId: 'nope' }], registry, testManifest)
    expect(issues.some((i) => i.code === 'unknown-asset')).toBe(true)
    expect(validateEdit(worldWithHut(), [{ kind: 'remove-asset', placementId: 'ast-a' }], registry, testManifest)).toEqual([])
  })

  it('falls back to shape-only checks without a manifest', () => {
    expect(validateEdit(groundedWorld(), [
      { kind: 'place-asset', assetId: 'bld-nope', anchor: at(4, 1, 4), rotation: 0 },
    ], registry)).toEqual([])
    const bad = validateEdit(groundedWorld(), [
      { kind: 'place-asset', assetId: 'x', anchor: at(4.5, 1, 4), rotation: 0 },
    ], registry)
    expect(bad.some((i) => i.code === 'invalid-meta')).toBe(true)
  })
})

describe('validateDocument asset placements', () => {
  it('accepts sound placements', () => {
    expect(validateDocument(worldWithHut(), registry, testManifest)).toEqual([])
  })

  it('flags overlapping existing placements once', () => {
    const doc = applyEdits(groundedWorld(), [
      { kind: 'place-asset', assetId: 'bld-hut-a', anchor: at(10, 1, 10), rotation: 0, placementId: 'ast-a' },
      { kind: 'place-asset', assetId: 'veg-tree-a', anchor: at(10, 1, 10), rotation: 0, placementId: 'ast-b' },
    ]).document
    const issues = validateDocument(doc, registry, testManifest).filter((i) => i.code === 'asset-overlap')
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('ast-a')
  })

  it('flags unknown asset in existing placements', () => {
    const doc = applyEdits(groundedWorld(), [
      { kind: 'place-asset', assetId: 'bld-ghost', anchor: at(4, 1, 4), rotation: 0, placementId: 'ast-g' },
    ]).document
    const issues = validateDocument(doc, registry, testManifest)
    expect(issues.some((i) => i.code === 'unknown-asset' && i.message.includes('ast-g'))).toBe(true)
  })

  it('flags malformed placement shape without a manifest', () => {
    const doc = worldWithHut()
    doc.assetPlacements![0].anchor = [1, 1.5, 1]
    const issues = validateDocument(doc, registry)
    expect(issues.some((i) => i.code === 'invalid-meta' && i.message.includes('anchor'))).toBe(true)
  })
})
