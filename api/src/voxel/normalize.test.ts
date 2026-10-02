import { describe, expect, it } from 'vitest'
import { applyEdits, createEmptyWorld, getBlock, validateWalkability } from '@possibility/voxel-contract'
import { normalizePayloadSize, normalizeWorldDocument } from './normalize'

const at = (x: number, y: number, z: number) => ({ x, y, z })

function flatWorld() {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'normalize-test')
  return applyEdits(base, [{ kind: 'fill', from: at(0, 0, 0), to: at(15, 0, 15), block: 'grass' }]).document
}

describe('normalizePayloadSize', () => {
  it('rounds fractional dimensions and clamps dimensions to supported bounds', () => {
    const result = normalizePayloadSize({
      size: { width: 7.4, height: 70, depth: 256.6 },
      ops: [],
    })
    expect(result.payload.size).toEqual({ width: 8, height: 64, depth: 256 })
    expect(result.fixes).toHaveLength(1)
  })

  it('infers missing dimensions from operation coordinates with margin and clamping', () => {
    const result = normalizePayloadSize({
      size: undefined,
      ops: [{ kind: 'set-block', at: at(11, 5, 9) }],
    })
    expect(result.payload.size).toEqual({ width: 14, height: 8, depth: 12 })
    expect(result.fixes[0]).toContain('inferred')
  })

  it('leaves size unchanged when coordinates cannot determine it', () => {
    const payload = { ops: [{ kind: 'unknown' }] }
    const result = normalizePayloadSize(payload)
    expect(result.payload).toBe(payload)
    expect(result.fixes).toEqual([])
  })
})

describe('normalizeWorldDocument', () => {
  it('returns a valid document unchanged with no fixes', () => {
    const document = flatWorld()
    const result = normalizeWorldDocument(document)
    expect(result).toEqual({ document, fixes: [], repairable: true })
    expect(validateWalkability(result.document)).toEqual([])
  })

  it('clears the block above a reachable low passage', () => {
    const document = applyEdits(flatWorld(), [{ kind: 'set-block', at: at(8, 2, 8), block: 'stone' }]).document
    expect(validateWalkability(document).some(issue => issue.code === 'walk-clearance')).toBe(true)

    const result = normalizeWorldDocument(document)
    expect(result.repairable).toBe(true)
    expect(result.fixes).toEqual(['walk-clearance:1->0'])
    expect(getBlock(result.document, at(8, 2, 8))).toBe('air')
    expect(validateWalkability(result.document)).toEqual([])
  })

  it('hands off a document with non-clearance validation issues without changing it', () => {
    const document = {
      ...flatWorld(),
      sections: { ...flatWorld().sections, '99,0,0': { palette: ['unknown-block'], indices: new Uint16Array(4096), nonAirCount: 1 } },
    }
    const result = normalizeWorldDocument(document)
    expect(result.document).toBe(document)
    expect(result.fixes).toEqual([])
    expect(result.repairable).toBe(false)
  })
})
