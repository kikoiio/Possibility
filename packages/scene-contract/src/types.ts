export type SceneMode = 'create' | 'life' | 'possibility'
export type AssetCategory = 'terrain' | 'road' | 'water' | 'building' | 'nature' | 'decoration' | 'person'
export interface GridSize { columns: number; rows: number }
export interface GridPoint { x: number; y: number }
export interface GridRect extends GridPoint { width: number; height: number }
export interface SceneViewport { center: GridPoint; zoom: number }
export interface SceneValidationIssue { code: string; path: string; message: string }
export interface SceneValidationResult { ok: boolean; issues: SceneValidationIssue[] }
export interface SceneAssetDefinition {
  id: string; themeId: string; category: AssetCategory; name: string
  sprite: { sheetId: string; frame: string; states?: Record<string, string> }
  thumbnail: string
  footprint: { width: number; height: number }; anchor: GridPoint; sortOffset: number; tags: string[]
  capabilities: { placeable: boolean; repeatable: boolean; semanticLocation: boolean; semanticPerson: boolean }
}
export interface SceneThemeManifest {
  id: string; name: string; schemaVersion: number; tileSize: { width: number; height: number }
  sheets: { id: string; src: string }[]; assets: SceneAssetDefinition[]
}
export type SemanticBinding =
  | { kind: 'draft_location'; draftId: string }
  | { kind: 'location'; locationName: string }
  | { kind: 'person'; personId: string }
export interface SceneTile extends GridPoint { assetId: string }
export interface ScenePath { id: string; category: 'road' | 'water'; assetId: string; cells: GridPoint[] }
export interface SceneObject {
  id: string; assetId: string; position: GridPoint; binding: SemanticBinding | null; label: string | null; purpose: string | null
}
export interface SceneDocument {
  schemaVersion: number; themeId: string; size: GridSize; version: number
  terrain: SceneTile[]; paths: ScenePath[]; objects: SceneObject[]; lockedObjectIds: string[]; lockedAreas: GridRect[]
}
/** Version 1 remains readable; new multi-space scenes use version 2. */
export interface SceneDocumentV1 extends SceneDocument { schemaVersion: 1 }
export interface ScenePixelPoint { x: number; y: number }
export interface ScenePixelRect extends ScenePixelPoint { width: number; height: number }
export type SceneSpaceKind = 'exterior' | 'interior' | 'floor'
export interface SceneNavigation {
  walkableCells: GridPoint[]
  blockedCells: GridPoint[]
  entrances: GridPoint[]
}
export interface SceneRegion {
  id: string
  locationName: string
  cells: GridPoint[]
  entryPoint: GridPoint
  interactionPoint: GridPoint
}
export interface ScenePortalEnd {
  spaceId: string
  position: GridPoint
  facing: 'north-east' | 'south-east' | 'south-west' | 'north-west'
}
export interface ScenePortal {
  id: string
  from: ScenePortalEnd
  to: ScenePortalEnd
  transition: 'camera' | 'fade'
}
export interface SceneSpace {
  id: string
  name: string
  kind: SceneSpaceKind
  size: GridSize
  surface: SceneTile[]
  paths: ScenePath[]
  structures: SceneObject[]
  objects: SceneObject[]
  regions: SceneRegion[]
  navigation: SceneNavigation
}
export interface SceneLockedAreaV2 extends GridRect { spaceId: string }
export interface SceneDocumentV2 {
  schemaVersion: 2
  themeId: string
  version: number
  defaultSpaceId: string
  spaces: SceneSpace[]
  portals: ScenePortal[]
  lockedObjectIds: string[]
  lockedAreas: SceneLockedAreaV2[]
}
export type SceneDocumentAny = SceneDocument | SceneDocumentV2
export type SceneConnectorDirection = 'north' | 'east' | 'south' | 'west'
export interface SceneConnector { edge: SceneConnectorDirection; type: string; level: number }
export interface SceneAssetGeometry {
  footprintCells: GridPoint[]
  groundContactCell: GridPoint
  groundContactPixel: ScenePixelPoint
  elevation: number
  visualBounds: ScenePixelRect
  occlusionBounds: ScenePixelRect[]
  sortBias: number
}
export interface SceneAssetNavigation { walkableCells: GridPoint[]; blockedCells: GridPoint[]; entrances: GridPoint[] }
export interface SceneAssetDefinitionV2 {
  id: string
  themeId: string
  category: 'surface' | 'path' | 'structure' | 'building' | 'furniture' | 'nature' | 'person' | 'effect'
  name: string
  sprite: { sheetId: string; frame: string; states: Record<string, string>; frameSize: { width: number; height: number } }
  thumbnail: string
  geometry: SceneAssetGeometry
  connectors: SceneConnector[]
  navigation: SceneAssetNavigation
  capabilities: { placeable: boolean; semanticLocation: boolean; semanticPerson: boolean; enterable: boolean; interactive: boolean }
}
export interface SceneThemeManifestV2 {
  id: string
  name: string
  schemaVersion: 2
  tileSize: { width: number; height: number }
  sheets: { id: string; src: string; loading?: 'critical' | 'deferred' }[]
  assets: SceneAssetDefinitionV2[]
}
export type SceneOperation =
  | { type: 'add_object'; object: SceneObject }
  | { type: 'move_object'; objectId: string; to: GridPoint; spaceId?: string }
  | { type: 'remove_object'; objectId: string }
  | { type: 'replace_asset'; objectId: string; assetId: string }
  | { type: 'update_object'; objectId: string; label?: string | null; purpose?: string | null }
  | { type: 'paint_cells'; category: 'terrain' | 'road' | 'water'; assetId: string; cells: GridPoint[] }
  | { type: 'erase_cells'; category: 'road' | 'water'; cells: GridPoint[] }
  | { type: 'lock_object'; objectId: string; locked: boolean }
  | { type: 'lock_area'; area: GridRect }
  | { type: 'unlock_area'; area: GridRect }
export interface SceneChangeSet { added: string[]; moved: string[]; updated: string[]; removed: string[] }
export interface ScenePreviewResult { document: SceneDocument; changes: SceneChangeSet }
export interface ScenePatchPreview { requestId: string; baseVersion: number; summary: string; operations: SceneOperation[]; warnings: string[] }
export interface SceneLifeOverlay {
  timelineId: string; simNow: string; weather: string | null; timeOfDay: 'day' | 'dusk' | 'night' | 'dawn'
  persons: { personId: string; locationName: string; activity: string; mood: string }[]
  locationStates: { locationName: string; visualState: string }[]
}
