import { gridToScreen } from './coordinates'
import type { GridPoint, SceneAssetGeometry, ScenePixelPoint } from './types'

export interface SceneScreenPoint { x: number; y: number }
export interface SceneGeometryContext {
  tileSize: { width: number; height: number }
  origin?: SceneScreenPoint
  zoom?: number
}

/** Screen position of an asset's explicit ground contact point. */
export function projectGroundContact(cell: GridPoint, geometry: SceneAssetGeometry, context: SceneGeometryContext): SceneScreenPoint {
  return gridToScreen({ x: cell.x + geometry.groundContactCell.x, y: cell.y + geometry.groundContactCell.y }, context.tileSize, context.origin, context.zoom)
}

/** Top-left sprite point in screen coordinates; source pixel dimensions are never resized here. */
export function projectSpriteOrigin(cell: GridPoint, geometry: SceneAssetGeometry, context: SceneGeometryContext): SceneScreenPoint {
  const contact = projectGroundContact(cell, geometry, context)
  const zoom = context.zoom ?? 1
  return { x: contact.x - geometry.groundContactPixel.x * zoom, y: contact.y - geometry.groundContactPixel.y * zoom }
}

export function computeDepthKey(cell: GridPoint, elevation: number, sortBias = 0): number {
  return (cell.x + cell.y) * 1_000_000 + elevation * 1_000 + sortBias
}

export function projectPixelOffset(origin: SceneScreenPoint, offset: ScenePixelPoint, zoom = 1): SceneScreenPoint {
  return { x: origin.x + offset.x * zoom, y: origin.y + offset.y * zoom }
}
