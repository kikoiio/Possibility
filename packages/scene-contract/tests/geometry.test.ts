import { describe, expect, it } from 'vitest'
import { computeDepthKey, projectGroundContact, projectSpriteOrigin } from '../src/geometry'

describe('explicit ground contact geometry', () => {
  const context = { tileSize: { width: 64, height: 32 }, origin: { x: 100, y: 30 }, zoom: 2 }
  const geometry = { footprintCells: [{ x: 0, y: 0 }], groundContactCell: { x: 1, y: 1 }, groundContactPixel: { x: 48, y: 96 }, elevation: 0, visualBounds: { x: 0, y: 0, width: 96, height: 112 }, occlusionBounds: [], sortBias: 0 }
  it('aligns sprite contact pixels to projected map contact', () => {
    const contact = projectGroundContact({ x: 2, y: 3 }, geometry, context)
    const origin = projectSpriteOrigin({ x: 2, y: 3 }, geometry, context)
    expect(contact).toEqual({ x: 36, y: 254 })
    expect(origin.x + geometry.groundContactPixel.x * context.zoom).toBe(contact.x)
    expect(origin.y + geometry.groundContactPixel.y * context.zoom).toBe(contact.y)
  })
  it('orders equal-ground assets by elevation and stable bias', () => {
    expect(computeDepthKey({ x: 1, y: 2 }, 1)).toBeGreaterThan(computeDepthKey({ x: 1, y: 2 }, 0))
    expect(computeDepthKey({ x: 2, y: 2 }, 0, 1)).toBeGreaterThan(computeDepthKey({ x: 1, y: 2 }, 0, 999))
  })
})
