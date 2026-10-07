import { describe, expect, it } from 'vitest'
import { applyEdits, createBlockRegistry, createEmptyWorld, getBlock, validateDocument, validateWalkability } from '../src'

describe('two-story residential carrier', () => {
  it.each([0, 90, 180, 270] as const)('has valid complete geometry at rotation %s', rotation => {
    const ground = applyEdits(createEmptyWorld({ width: 32, height: 16, depth: 32 }, 'mist-manor', 'house'), [
      { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 31, y: 0, z: 31 }, block: 'grass' },
    ]).document
    const doc = applyEdits(ground, [{ kind: 'place-object', objectId: 'home', objectType: 'manor-two-story-house', anchor: { x: 12, y: 1, z: 12 }, rotation }]).document
    expect(validateDocument(doc)).toEqual([])
    expect(validateWalkability(doc)).toEqual([])
  })

  it('allows walking from the street through the door and stairs onto the upper floor', () => {
    const doc = applyEdits(createEmptyWorld({ width: 32, height: 16, depth: 32 }, 'mist-manor', 'house'), [
      { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 31, y: 0, z: 31 }, block: 'grass' },
      { kind: 'place-object', objectId: 'home', objectType: 'manor-two-story-house', anchor: { x: 10, y: 1, z: 10 }, rotation: 0 },
    ]).document
    const route = [
      [13, 1, 17], [13, 2, 16], [13, 2, 15], [13, 2, 14],
      [12, 2, 14], [11, 2, 14], [11, 3, 13], [11, 4, 12], [11, 5, 11], [12, 5, 11],
    ]
    const registry = createBlockRegistry('mist-manor')
    const solid = (x: number, y: number, z: number) => registry.get(getBlock(doc, { x, y, z }))?.solid === true
    for (const [x, y, z] of route) {
      expect(solid(x, y - 1, z)).toBe(true)
      expect(solid(x, y, z)).toBe(false)
      expect(solid(x, y + 1, z)).toBe(false)
    }
    for (let i = 1; i < route.length; i++) {
      const [x, y, z] = route[i], [px, py, pz] = route[i - 1]
      expect(Math.abs(x - px) + Math.abs(z - pz)).toBe(1)
      expect(Math.abs(y - py)).toBeLessThanOrEqual(1)
      if (y > py) expect(solid(px, py + 2, pz)).toBe(false)
    }
  })
})
