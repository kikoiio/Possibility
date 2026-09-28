import type { SceneDocumentAny, SceneDocumentV1, SceneDocumentV2 } from './types'

/** Return an immutable v2 view. This does not persist or mutate a legacy scene. */
export function normalizeSceneDocument(document: SceneDocumentAny): SceneDocumentV2 {
  if (document.schemaVersion === 2) return structuredClone(document as SceneDocumentV2)
  const legacy = document as SceneDocumentV1
  return {
    schemaVersion: 2,
    themeId: legacy.themeId,
    version: legacy.version,
    defaultSpaceId: 'exterior',
    spaces: [{
      id: 'exterior', name: '外景', kind: 'exterior', size: structuredClone(legacy.size),
      surface: structuredClone(legacy.terrain), paths: structuredClone(legacy.paths), structures: [],
      objects: structuredClone(legacy.objects), regions: [],
      navigation: { walkableCells: [], blockedCells: [], entrances: [] },
    }],
    portals: [],
    lockedObjectIds: [...legacy.lockedObjectIds],
    lockedAreas: legacy.lockedAreas.map(area => ({ ...area, spaceId: 'exterior' })),
  }
}

export function isSceneDocumentV2(document: SceneDocumentAny): document is SceneDocumentV2 {
  return document.schemaVersion === 2
}
