import { describe, expect, it } from 'vitest'
import { EditPlannerError, parseEditOperations } from './edit-planner'

describe('parseEditOperations model aliases', () => {
  it('normalizes op discriminator and scalar block coordinates', () => {
    expect(parseEditOperations(JSON.stringify({ ops: [
      { op: 'place-block', block: 'cobble', x: 2, y: 0, z: 4 },
    ] }))).toEqual([{ kind: 'set-block', block: 'cobble', at: { x: 2, y: 0, z: 4 } }])
  })

  it('normalizes tuple coordinates and flattened bounded ranges', () => {
    expect(parseEditOperations(JSON.stringify({ ops: [
      { type: 'set-block', block: 'stone', at: [1, 2, 3] },
      { type: 'set-block', block: 'cobble', x1: 4, y: 0, z1: 5, x2: 7, y2: 0, z2: 5 },
    ] }))).toEqual([
      { kind: 'set-block', block: 'stone', at: { x: 1, y: 2, z: 3 } },
      { kind: 'fill', block: 'cobble', from: { x: 4, y: 0, z: 5 }, to: { x: 7, y: 0, z: 5 } },
    ])
  })

  it('normalizes block range operations mislabeled as place-object or place-block', () => {
    expect(parseEditOperations(JSON.stringify({ ops: [
      { type: 'place-object', objectId: 'road-area', block: 'cobble', from: { x: 0, y: 0, z: 1 }, to: { x: 9, y: 0, z: 1 } },
      { type: 'place-block', block: 'cobble', anchor: { x: 2, y: 1, z: 3 }, size: { width: 2, height: 1, depth: 4 } },
    ] }))).toEqual([
      { kind: 'fill', block: 'cobble', from: { x: 0, y: 0, z: 1 }, to: { x: 9, y: 0, z: 1 } },
      { kind: 'fill', block: 'cobble', from: { x: 2, y: 1, z: 3 }, to: { x: 3, y: 1, z: 6 } },
    ])
  })

  it('expands straight place-line aliases and rejects diagonal or unbounded operations', () => {
    expect(parseEditOperations(JSON.stringify({ ops: [
      { op: 'place-line', block: 'cobble', from: { x: 0, y: 0, z: 2 }, to: { x: 2, y: 0, z: 2 } },
    ] }))).toEqual([0, 1, 2].map(x => ({ kind: 'set-block', at: { x, y: 0, z: 2 }, block: 'cobble' })))
    expect(() => parseEditOperations(JSON.stringify({ ops: [
      { op: 'place-line', block: 'cobble', from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 0, z: 2 } },
    ] }))).toThrow(EditPlannerError)
    expect(() => parseEditOperations(JSON.stringify({ ops: [
      { op: 'fill', block: 'stone', from: { x: 0, y: 0, z: 0 }, to: { x: 255, y: 63, z: 255 } },
    ] }))).toThrow('范围过大')
  })

  it('bounds total voxel work across multiple individually valid fills', () => {
    const fill = { kind: 'fill', block: 'stone', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 } }
    expect(() => parseEditOperations(JSON.stringify({ ops: Array(257).fill(fill) }))).toThrow('编辑展开范围过大')
  })
})
