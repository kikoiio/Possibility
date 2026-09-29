import { describe, expect, it } from 'vitest'
import {
  AIR, createEmptyWorld, createSection, getBlock, getBlockInSection, inBounds,
  keyOfSection, localIndexOf, parseSectionKey, sectionKeyOf, setBlockInSection, setBlockMut,
} from '../src'

const at = (x: number, y: number, z: number) => ({ x, y, z })

describe('section addressing', () => {
  it('encodes and parses section keys', () => {
    expect(keyOfSection(1, 2, 3)).toBe('1,2,3')
    expect(parseSectionKey('1,2,3')).toEqual({ cx: 1, cy: 2, cz: 3 })
  })

  it('maps world coords to section key and local index round-trip', () => {
    expect(sectionKeyOf(at(0, 0, 0))).toBe('0,0,0')
    expect(sectionKeyOf(at(15, 15, 15))).toBe('0,0,0')
    expect(sectionKeyOf(at(16, 0, 0))).toBe('1,0,0')
    expect(sectionKeyOf(at(17, 33, 5))).toBe('1,2,0')
    expect(localIndexOf(at(0, 0, 0))).toBe(0)
    expect(localIndexOf(at(16, 0, 0))).toBe(0) // same local slot, next section
  })
})

describe('in-section palette read/write', () => {
  it('set/get are cell-accurate and palette stays deduplicated', () => {
    const s = createSection()
    setBlockInSection(s, 0, 'grass')
    setBlockInSection(s, 1, 'grass')
    setBlockInSection(s, 2, 'stone')
    expect(getBlockInSection(s, 0)).toBe('grass')
    expect(getBlockInSection(s, 1)).toBe('grass')
    expect(getBlockInSection(s, 2)).toBe('stone')
    expect(s.palette).toEqual([AIR, 'grass', 'stone'])
  })

  it('maintains nonAirCount across set and clear', () => {
    const s = createSection()
    setBlockInSection(s, 5, 'grass')
    setBlockInSection(s, 6, 'stone')
    expect(s.nonAirCount).toBe(2)
    setBlockInSection(s, 5, 'stone') // swap non-air → non-air
    expect(s.nonAirCount).toBe(2)
    setBlockInSection(s, 5, AIR)
    setBlockInSection(s, 6, AIR)
    expect(s.nonAirCount).toBe(0)
  })
})

describe('world-level get/set', () => {
  it('out-of-bounds reads return air', () => {
    const doc = createEmptyWorld({ width: 32, height: 32, depth: 32 }, 'mist-manor')
    expect(getBlock(doc, at(-1, 0, 0))).toBe(AIR)
    expect(getBlock(doc, at(0, 32, 0))).toBe(AIR)
    expect(getBlock(doc, at(31, 31, 31))).toBe(AIR)
    expect(inBounds(doc.size, at(31, 31, 31))).toBe(true)
    expect(inBounds(doc.size, at(32, 0, 0))).toBe(false)
  })

  it('set/get round-trips per cell', () => {
    const doc = createEmptyWorld({ width: 32, height: 32, depth: 32 }, 'mist-manor')
    setBlockMut(doc, at(3, 4, 5), 'grass')
    setBlockMut(doc, at(16, 0, 0), 'stone')
    expect(getBlock(doc, at(3, 4, 5))).toBe('grass')
    expect(getBlock(doc, at(16, 0, 0))).toBe('stone')
    expect(getBlock(doc, at(3, 4, 6))).toBe(AIR)
  })

  it('clearing the last block drops the empty section', () => {
    const doc = createEmptyWorld({ width: 32, height: 32, depth: 32 }, 'mist-manor')
    setBlockMut(doc, at(1, 1, 1), 'grass')
    expect(Object.keys(doc.sections)).toHaveLength(1)
    setBlockMut(doc, at(1, 1, 1), AIR)
    expect(Object.keys(doc.sections)).toHaveLength(0)
  })

  it('border edits report neighbor sections as affected', () => {
    const doc = createEmptyWorld({ width: 64, height: 32, depth: 32 }, 'mist-manor')
    // 内部格：只影响本節
    expect(setBlockMut(doc, at(5, 5, 5), 'grass')).toEqual(['0,0,0'])
    // x 边界格：影响左右两节
    const keys = setBlockMut(doc, at(16, 5, 5), 'grass')
    expect(keys.sort()).toEqual(['0,0,0', '1,0,0'])
    // 角落格：影响三節
    const corner = setBlockMut(doc, at(0, 0, 16), 'grass')
    expect(corner.sort()).toEqual(['0,0,0', '0,0,1'])
  })
})
