import { describe, expect, it } from 'vitest'
import { createBlockRegistry, createEmptyWorld, setBlockMut } from '@possibility/voxel-contract'
import { inspectInteriorClosure, isSpawnClearOfObjects } from './interior-closure'
import { resolveSpaceContext } from './space-context'

function docWithShell({ roof = true, wallGap = false, opening = true } = {}) {
  const doc = createEmptyWorld({ width: 6, height: 5, depth: 6 }, 'mist-manor', 'main-house-interior')
  const set = (x: number, y: number, z: number, block: string) => setBlockMut(doc, { x, y, z }, block)
  for (let z = 0; z < 6; z++) for (let x = 0; x < 6; x++) set(x, 0, z, 'tatami')
  for (let y = 1; y < 4; y++) {
    for (let z = 0; z < 6; z++) {
      set(0, y, z, 'plaster-wall')
      set(5, y, z, 'plaster-wall')
    }
    for (let x = 1; x < 5; x++) {
      if (!(opening && x === 2 && (y === 1 || y === 2))) set(x, y, 0, 'plaster-wall')
      set(x, y, 5, 'plaster-wall')
    }
  }
  if (wallGap) setBlockMut(doc, { x: 0, y: 2, z: 3 }, 'air')
  if (roof) for (let z = 0; z < 6; z++) for (let x = 0; x < 6; x++) set(x, 4, z, 'roof-tile')
  return doc
}

describe('inspectInteriorClosure', () => {
  it('accepts a closed interior with a normal door opening', () => {
    const report = inspectInteriorClosure(docWithShell(), resolveSpaceContext(undefined, 'main-house-interior'), {
      allowedOpenings: [{ x: 2, y: 1, z: 0 }, { x: 2, y: 2, z: 0 }],
    })
    expect(report).toMatchObject({ hasFloor: true, hasContinuousRoof: true, hasClosedWallBoundary: true })
    expect(report.walkableSpawn).toEqual({ x: 3, y: 1, z: 3 })
    expect(report.exposedCells).toEqual([])
  })

  it('reports a missing roof', () => {
    const report = inspectInteriorClosure(docWithShell({ roof: false }), resolveSpaceContext(undefined, 'main-house-interior'))
    expect(report.hasContinuousRoof).toBe(false)
    expect(report.exposedCells.length).toBeGreaterThan(0)
  })

  it('reports a wall gap and invalid spawn separately', () => {
    const report = inspectInteriorClosure(docWithShell({ wallGap: true }), resolveSpaceContext(undefined, 'main-house-interior'), {
      spawn: { x: 0, y: 1, z: 1 },
      allowedOpenings: [{ x: 2, y: 1, z: 0 }, { x: 2, y: 2, z: 0 }],
    })
    expect(report.hasClosedWallBoundary).toBe(false)
    expect(report.walkableSpawn).toBeNull()
  })

  it('rejects a standable cell when surrounding furniture leaves no safe spawn', () => {
    const doc = docWithShell()
    doc.objects.push({ id: 'table', objectType: 'bench', anchor: { x: 3, y: 1, z: 3 }, rotation: 0 })
    const report = inspectInteriorClosure(doc, resolveSpaceContext(undefined, 'main-house-interior'))
    expect(report.walkableSpawn).toBeNull()
    expect(isSpawnClearOfObjects(doc, { x: 3, y: 1, z: 3 })).toBe(false)
  })

  it('defaults unknown/exterior contexts away from interior validation', () => {
    const doc = docWithShell()
    const report = inspectInteriorClosure(doc, resolveSpaceContext(undefined, 'exterior'))
    expect(report.exposedCells).toEqual([])
    expect(report.walkableSpawn).toBeNull()
  })

  it('uses the theme registry when checking opaque blocks', () => {
    const doc = docWithShell()
    const registry = createBlockRegistry('mist-manor')
    expect(inspectInteriorClosure(doc, undefined, { registry }).hasContinuousRoof).toBe(true)
  })

})
