import type { GridPoint, GridRect } from './types'

export interface ScreenPoint { x: number; y: number }
export function gridToScreen(point: GridPoint, tile: { width: number; height: number }, origin: ScreenPoint = { x: 0, y: 0 }, zoom = 1): ScreenPoint {
  return { x: origin.x + (point.x - point.y) * tile.width / 2 * zoom, y: origin.y + (point.x + point.y) * tile.height / 2 * zoom }
}
export function screenToGrid(point: ScreenPoint, tile: { width: number; height: number }, origin: ScreenPoint = { x: 0, y: 0 }, zoom = 1): GridPoint {
  const x = (point.x - origin.x) / zoom * 2 / tile.width
  const y = (point.y - origin.y) / zoom * 2 / tile.height
  return { x: Math.round((x + y) / 2), y: Math.round((y - x) / 2) }
}
export function rectCells(rect: GridRect): GridPoint[] {
  return Array.from({ length: rect.width * rect.height }, (_, i) => ({ x: rect.x + i % rect.width, y: rect.y + Math.floor(i / rect.width) }))
}
export function snapToGrid(point: GridPoint): GridPoint { return { x: Math.round(point.x), y: Math.round(point.y) } }
export function rectWithin(rect: GridRect, size: { columns: number; rows: number }): boolean {
  return rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= size.columns && rect.y + rect.height <= size.rows
}
