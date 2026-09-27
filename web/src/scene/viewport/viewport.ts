import { gridToScreen, screenToGrid } from '@possibility/scene-contract'
import type { GridPoint, SceneViewport } from '@possibility/scene-contract'

export const MIN_ZOOM = 0.35
export const MAX_ZOOM = 2.5
export function clampZoom(zoom: number): number { return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) }
export function panViewport(viewport: SceneViewport, dx: number, dy: number, zoom = viewport.zoom): SceneViewport {
  const center = screenToGrid({ x: dx, y: dy }, { width: 64, height: 32 })
  return { center: { x: viewport.center.x - center.x, y: viewport.center.y - center.y }, zoom: clampZoom(zoom) }
}
export function zoomAt(viewport: SceneViewport, delta: number): SceneViewport { return { ...viewport, zoom: clampZoom(viewport.zoom * Math.exp(-delta * 0.001)) } }
export function gridPointToCanvas(p: GridPoint, size: { columns: number; rows: number }, width: number, height: number, zoom: number): { x: number; y: number } {
  const origin = { x: width / 2, y: height / 2 }
  const center = gridToScreen({ x: size.columns / 2, y: size.rows / 2 }, { width: 64, height: 32 })
  const point = gridToScreen(p, { width: 64, height: 32 })
  return { x: origin.x + (point.x - center.x) * zoom, y: origin.y + (point.y - center.y) * zoom }
}
