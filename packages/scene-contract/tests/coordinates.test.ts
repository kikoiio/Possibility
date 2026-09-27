import { describe, expect, it } from 'vitest'
import { gridToScreen, rectWithin, screenToGrid, snapToGrid } from '../src/coordinates'

describe('isometric coordinates', () => {
  it('round trips integer points around the origin', () => {
    for (let x = -10; x <= 10; x++) for (let y = -10; y <= 10; y++) expect(screenToGrid(gridToScreen({ x, y }, { width: 64, height: 32 }), { width: 64, height: 32 })).toEqual({ x, y })
  })
  it('accounts for origin and zoom and snaps to integer cells', () => {
    const p = { x: 4, y: 7 }; expect(screenToGrid(gridToScreen(p, { width: 64, height: 32 }, { x: 20, y: 40 }, 2), { width: 64, height: 32 }, { x: 20, y: 40 }, 2)).toEqual(p)
    expect(snapToGrid({ x: 1.5, y: 2.4 })).toEqual({ x: 2, y: 2 })
  })
  it('checks rectangle boundary exactly', () => { expect(rectWithin({ x: 0, y: 0, width: 3, height: 2 }, { columns: 3, rows: 2 })).toBe(true); expect(rectWithin({ x: 1, y: 0, width: 3, height: 2 }, { columns: 3, rows: 2 })).toBe(false) })
})
