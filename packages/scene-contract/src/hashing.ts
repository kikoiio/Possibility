import type { SceneDocument } from './types'

export function canonicalScene(document: SceneDocument): string {
  const sorted = structuredClone(document)
  sorted.terrain.sort((a, b) => a.y - b.y || a.x - b.x || a.assetId.localeCompare(b.assetId))
  sorted.paths.sort((a, b) => a.id.localeCompare(b.id))
  sorted.paths.forEach(path => path.cells.sort((a, b) => a.y - b.y || a.x - b.x))
  sorted.objects.sort((a, b) => a.id.localeCompare(b.id))
  sorted.lockedObjectIds.sort()
  sorted.lockedAreas.sort((a, b) => a.y - b.y || a.x - b.x || a.height - b.height || a.width - b.width)
  return JSON.stringify(sorted)
}
export async function hashScene(document: SceneDocument): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalScene(document))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
