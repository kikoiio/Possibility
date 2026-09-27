import { describe, expect, it } from 'vitest'
import { clampZoom, gridPointToCanvas, zoomAt } from './viewport'

describe('canvas viewport', () => {
  it('clamps zoom and zooms around stable center', () => { expect(clampZoom(8)).toBe(2.5); expect(clampZoom(.01)).toBe(.35); expect(zoomAt({ center: { x: 0, y: 0 }, zoom: 1 }, -100).zoom).toBeGreaterThan(1) })
  it('projects the grid center to the viewport center', () => { expect(gridPointToCanvas({ x: 8, y: 8 }, { columns: 16, rows: 16 }, 800, 600, 1)).toEqual({ x: 400, y: 300 }) })
})
