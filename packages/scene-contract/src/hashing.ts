import type { SceneDocument, SceneDocumentAny } from './types'
import { normalizeSceneDocument } from './normalize'

export function canonicalScene(document: SceneDocumentAny): string {
  if (document.schemaVersion === 2) {
    const sorted = normalizeSceneDocument(document)
    sorted.spaces.sort((a, b) => a.id.localeCompare(b.id))
    for (const space of sorted.spaces) {
      space.surface.sort((a, b) => a.y - b.y || a.x - b.x || a.assetId.localeCompare(b.assetId))
      space.paths.sort((a, b) => a.id.localeCompare(b.id))
      space.paths.forEach(path => path.cells.sort((a, b) => a.y - b.y || a.x - b.x))
      space.structures.sort((a, b) => a.id.localeCompare(b.id))
      space.objects.sort((a, b) => a.id.localeCompare(b.id))
      space.regions.sort((a, b) => a.id.localeCompare(b.id))
      space.navigation.walkableCells.sort((a, b) => a.y - b.y || a.x - b.x)
      space.navigation.blockedCells.sort((a, b) => a.y - b.y || a.x - b.x)
      space.navigation.entrances.sort((a, b) => a.y - b.y || a.x - b.x)
    }
    sorted.portals.sort((a, b) => a.id.localeCompare(b.id))
    sorted.lockedObjectIds.sort()
    sorted.lockedAreas.sort((a, b) => a.spaceId.localeCompare(b.spaceId) || a.y - b.y || a.x - b.x)
    return JSON.stringify(sorted)
  }
  return canonicalV1(document as SceneDocument)
}

function canonicalV1(document: SceneDocument): string {
  const sorted = structuredClone(document)
  sorted.terrain.sort((a, b) => a.y - b.y || a.x - b.x || a.assetId.localeCompare(b.assetId))
  sorted.paths.sort((a, b) => a.id.localeCompare(b.id))
  sorted.paths.forEach(path => path.cells.sort((a, b) => a.y - b.y || a.x - b.x))
  sorted.objects.sort((a, b) => a.id.localeCompare(b.id))
  sorted.lockedObjectIds.sort()
  sorted.lockedAreas.sort((a, b) => a.y - b.y || a.x - b.x || a.height - b.height || a.width - b.width)
  return JSON.stringify(sorted)
}
export async function hashScene(document: SceneDocumentAny): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalScene(document))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
