import { describe, expect, it } from 'vitest'
import {
  applyEdits, createEmptyWorld, deserialize, getBlock, serialize, setBlockMut, VoxelDeserializeError,
} from '../src'

const at = (x: number, y: number, z: number) => ({ x, y, z })

function sampleWorld() {
  let doc = createEmptyWorld({ width: 48, height: 32, depth: 48 }, 'mist-manor', 'sample')
  for (let z = 0; z < 48; z++) for (let x = 0; x < 48; x++) setBlockMut(doc, at(x, 0, z), 'grass')
  const placed = applyEdits(doc, [
    { kind: 'set-block', at: at(17, 5, 33), block: 'lantern' },
    { kind: 'place-object', objectType: 'manor-main-house', anchor: at(4, 1, 4), rotation: 90, objectId: 'house' },
    { kind: 'place-object', objectType: 'stone-lantern', anchor: at(20, 1, 20), rotation: 0, objectId: 'lamp' },
  ])
  doc = {
    ...placed.document,
    locations: [{ name: '主楼', objectId: 'house' }],
    spaceEntries: [{ spaceId: 'main-hall', label: '进入主楼 →', at: at(7, 1, 9) }],
    lockedObjectIds: ['house'],
  }
  return doc
}

describe('serialize / deserialize', () => {
  it('round-trips cell-for-cell and preserves bindings (AC1)', () => {
    const doc = sampleWorld()
    const restored = deserialize(serialize(doc))
    expect(restored.id).toBe(doc.id)
    expect(restored.theme).toBe(doc.theme)
    expect(restored.size).toEqual(doc.size)
    expect(restored.objects).toEqual(doc.objects)
    expect(restored.objectCells).toEqual(doc.objectCells)
    expect(restored.locations).toEqual(doc.locations)
    expect(restored.spaceEntries).toEqual(doc.spaceEntries)
    expect(restored.lockedObjectIds).toEqual(doc.lockedObjectIds)
    for (const probe of [at(0, 0, 0), at(17, 5, 33), at(4, 1, 4), at(20, 2, 20), at(47, 31, 47)]) {
      expect(getBlock(restored, probe)).toBe(getBlock(doc, probe))
    }
  })

  it('rejects tampered payloads with a diagnosable reason', () => {
    const good = serialize(sampleWorld())
    const parsed = JSON.parse(good)

    expect(() => deserialize('not json')).toThrow(VoxelDeserializeError)
    expect(() => deserialize(JSON.stringify({ ...parsed, format: 'other' }))).toThrow(/unknown format/)
    expect(() => deserialize(JSON.stringify({ ...parsed, version: 2 }))).toThrow(/unsupported version/)

    const badIndices = JSON.parse(good)
    badIndices.sections[Object.keys(parsed.sections)[0]].indices = 'AAAA'
    expect(() => deserialize(JSON.stringify(badIndices))).toThrow(/indices must be/)

    const badKey = JSON.parse(good)
    badKey.sections['bogus'] = badKey.sections[Object.keys(parsed.sections)[0]]
    expect(() => deserialize(JSON.stringify(badKey))).toThrow(/malformed section key/)
  })
})
