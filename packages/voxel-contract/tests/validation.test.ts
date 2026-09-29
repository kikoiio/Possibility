import { describe, expect, it } from 'vitest'
import {
  applyEdits, createBlockRegistry, createEmptyWorld, setBlockMut, validateDocument, validateEdit,
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
