/** Native 2D persistence contract.
 *
 * Native 2D layouts are user presentation data. They are versioned separately
 * from voxel documents and never carry a voxel document or world-state event.
 */

export const NATIVE2D_SCHEMA = 'native2d-layout'
export const NATIVE2D_SCHEMA_VERSION = 1 as const
export const NATIVE2D_LAYOUT_VERSION = 1 as const

export interface Native2dScope {
  readonly worldId: string
  readonly timelineId: string
  readonly sceneId: string
}

export interface Native2dGridPoint {
  readonly x: number
  readonly z: number
}

export interface Native2dSpaceBinding {
  readonly spaceId: string
  readonly kind: 'exterior' | 'interior'
  readonly width: number
  readonly depth: number
  readonly walkable: readonly Native2dGridPoint[]
  readonly blocked?: readonly Native2dGridPoint[]
  readonly connectivityRoot?: Native2dGridPoint | null
}

export interface Native2dBuildingBinding {
  readonly buildingId: string
  readonly spaceId: string
  readonly footprint: readonly Native2dGridPoint[]
  readonly entry?: Native2dGridPoint | null
  readonly locationKey?: string | null
  readonly interiorSpaceId?: string | null
}

export interface Native2dMetadata extends Native2dScope {
  readonly schema: typeof NATIVE2D_SCHEMA
  readonly schemaVersion: typeof NATIVE2D_SCHEMA_VERSION
  readonly sceneVersion: number
  readonly layoutVersion: typeof NATIVE2D_LAYOUT_VERSION
  readonly spaces: readonly Native2dSpaceBinding[]
  readonly buildings: readonly Native2dBuildingBinding[]
}

export interface Native2dPlacement {
  readonly buildingId: string
  readonly spaceId: string
  readonly origin: Native2dGridPoint
}

export interface Native2dLayout {
  readonly metadata: Native2dMetadata
  readonly placements: readonly Native2dPlacement[]
}

export interface Native2dLayoutRevision extends Native2dScope {
  readonly version: number
  readonly parentVersion: number | null
  readonly requestId: string
  readonly contentHash: string
  readonly layout: Native2dLayout
  readonly createdAt: string
}

export interface Native2dLayoutHead extends Native2dScope {
  readonly currentVersion: number
  readonly updatedAt: string
}

export interface Native2dLayoutRequest extends Native2dScope {
  readonly requestId: string
  readonly contentHash: string
  readonly expectedVersion: number
  readonly resultVersion: number
}

export type Native2dValidationCode =
  | 'invalid_metadata'
  | 'invalid_scope'
  | 'invalid_space'
  | 'invalid_binding'
  | 'invalid_placement'
  | 'out_of_bounds'
  | 'blocked'
  | 'collision'
  | 'entry_blocked'
  | 'disconnected'

export interface Native2dValidationIssue {
  readonly code: Native2dValidationCode
  readonly message: string
  readonly buildingId?: string
  readonly spaceId?: string
  readonly cells?: readonly Native2dGridPoint[]
}

export interface Native2dValidationResult {
  readonly valid: boolean
  readonly issues: readonly Native2dValidationIssue[]
}

export type Native2dSaveResult =
  | { readonly ok: true; readonly kind: 'created' | 'replayed'; readonly revision: Native2dLayoutRevision; readonly head: Native2dLayoutHead }
  | { readonly ok: false; readonly kind: 'conflict'; readonly code: 'request_conflict' | 'version_conflict'; readonly head: Native2dLayoutHead | null; readonly message: string }
  | { readonly ok: false; readonly kind: 'invalid'; readonly validation: Native2dValidationResult; readonly message: string }

export interface Native2dSaveInput extends Native2dScope {
  readonly expectedVersion: number
  readonly requestId: string
  readonly layout: Native2dLayout
  readonly now?: string
}

export function scopeKey(scope: Native2dScope): string {
  return JSON.stringify([scope.worldId, scope.timelineId, scope.sceneId])
}

export function isNative2dScope(value: unknown): value is Native2dScope {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return [candidate.worldId, candidate.timelineId, candidate.sceneId].every(
    (item) => typeof item === 'string' && item.trim().length > 0,
  )
}
