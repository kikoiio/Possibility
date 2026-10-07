/**
 * N2D1 原生 2D 庄园样板统一类型契约。
 *
 * 本文件只导出类型，不包含运行时代码；不导入 PixiJS、控制器或存储。
 * 数组与输入对象按只读使用，模块通过新值更新状态，不修改传入的世界数据。
 * 格子坐标使用 x、z，屏幕及图片坐标使用 x、y。
 * 对应已批准 plan.md「核心数据结构」与「契约约束」。
 */

export type SourceKind = 'account' | 'public' | 'fixture'

export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night' | 'unknown'

export interface GridPoint {
  readonly x: number
  readonly z: number
}

export interface PixelPoint {
  readonly x: number
  readonly y: number
}

export interface GridBounds {
  readonly width: number
  readonly depth: number
}

export interface SampleScope {
  readonly source: SourceKind
  readonly worldId: string
  readonly timelineId: string
  readonly sceneId: string
  readonly sceneVersion: number
}

export interface WorldLocation {
  readonly name: string
  readonly description: string
}

export interface WorldResident {
  readonly personId: string
  readonly name: string
  readonly locationName: string | null
  readonly activity: string | null
}

/** Environment facts are copied from the account snapshot without interpretation. */
export interface WorldEnvironmentFact {
  readonly id: string
  readonly locationName: string | null
  readonly condition: string
  readonly value: string
  readonly simTime: string
  readonly version: number
}

export type WorldRuntimeStatus = 'running' | 'paused' | 'capped' | 'archived'

export interface WorldRuntimeState {
  readonly status: WorldRuntimeStatus
  readonly pauseReason: 'manual' | 'daily_cap' | 'global_daily_cap' | 'idle' | null
  readonly callsToday: number
  readonly worldModelVersion: number | null
  readonly evidenceStatus: 'structured' | 'legacy'
}

export interface WorldReadModel {
  readonly scope: SampleScope
  readonly worldName: string
  readonly simNow: string | null
  readonly timeZone: string
  readonly stateVersion: number | null
  readonly locations: readonly WorldLocation[]
  readonly residents: readonly WorldResident[]
  /** Account backed snapshots include these fields; fixtures may omit them. */
  readonly environment?: readonly WorldEnvironmentFact[]
  readonly runtime?: WorldRuntimeState
}

export type ReadState =
  | {
      readonly status: 'loading'
      readonly lastGood: WorldReadModel | null
      readonly errorMessage: null
      readonly receivedAt: string | null
    }
  | {
      readonly status: 'ready'
      readonly lastGood: WorldReadModel
      readonly errorMessage: null
      readonly receivedAt: string
    }
  | {
      readonly status: 'stale'
      readonly lastGood: WorldReadModel
      readonly errorMessage: string
      readonly receivedAt: string
    }
  | {
      readonly status: 'error'
      readonly lastGood: null
      readonly errorMessage: string
      readonly receivedAt: null
    }

export interface CameraHome {
  readonly focus: GridPoint
  readonly paddingPx: number
  readonly maxZoom: number
}

export interface AssetLayer {
  readonly id: string
  readonly url: string
  readonly pixelWidth: number
  readonly pixelHeight: number
  readonly anchorPx: PixelPoint
  readonly role: 'base' | 'occluder' | 'accent'
  readonly sortOffset: number
  readonly visibleAt: readonly TimeOfDay[]
}

export interface AssetDefinition {
  readonly id: string
  readonly layers: readonly AssetLayer[]
  readonly footprint: readonly GridPoint[]
  readonly sortAnchor: GridPoint
  readonly hitPolygon: readonly PixelPoint[]
}

export interface StaticSceneObject {
  readonly id: string
  readonly assetId: string
  readonly origin: GridPoint
  readonly blocksMovement: boolean
}

export interface SpaceDefinition {
  readonly id: string
  readonly kind: 'exterior' | 'interior'
  readonly bounds: GridBounds
  readonly walkableCells: readonly GridPoint[]
  readonly staticObjects: readonly StaticSceneObject[]
  readonly overview: CameraHome
  readonly connectivityRoot: GridPoint | null
}

export interface BuildingDefinition {
  readonly id: string
  readonly assetId: string
  readonly spaceId: string
  readonly initialOrigin: GridPoint
  readonly entryOffset: GridPoint
  readonly locationKeys: readonly string[]
  readonly interiorSpaceId: string | null
}

export type LocationRepresentation =
  | {
      readonly kind: 'outdoor'
      readonly spaceId: string
      readonly anchor: GridPoint
      readonly residentSlots: readonly GridPoint[]
    }
  | {
      readonly kind: 'interior'
      readonly spaceId: string
      readonly entryBuildingId: string
      readonly anchor: GridPoint
      readonly residentSlots: readonly GridPoint[]
    }
  | { readonly kind: 'unrepresented'; readonly buildingId: string | null }

export interface LocationBinding {
  readonly locationKey: string
  readonly sourceLocationName: string
  readonly representation: LocationRepresentation
}

export interface SceneDefinition {
  readonly id: string
  readonly version: number
  readonly defaultSpaceId: string
  readonly spaces: readonly SpaceDefinition[]
  readonly buildings: readonly BuildingDefinition[]
  readonly locationBindings: readonly LocationBinding[]
  readonly assetManifest: Readonly<Record<string, AssetDefinition>>
}

export interface BuildingPlacement {
  readonly buildingId: string
  readonly spaceId: string
  readonly origin: GridPoint
}

export interface LayoutState {
  readonly scope: SampleScope
  readonly placements: readonly BuildingPlacement[]
}

export type MoveReasonCode =
  | 'out_of_bounds'
  | 'collision'
  | 'entrance_blocked'
  | 'disconnected'
  | 'missing_building'
  | 'invalid_asset'

export interface MoveReason {
  readonly code: MoveReasonCode
  readonly message: string
  readonly buildingId: string | null
  readonly cells: readonly GridPoint[]
}

export interface MoveValidation {
  readonly valid: boolean
  readonly conflictCells: readonly GridPoint[]
  readonly reasons: readonly MoveReason[]
}

export interface MoveCommand {
  readonly buildingId: string
  readonly from: GridPoint
  readonly to: GridPoint
}

export interface MovePreview {
  readonly buildingId: string
  readonly target: GridPoint
  readonly validation: MoveValidation
}

export type EditResult =
  | { readonly ok: true; readonly layout: LayoutState }
  | {
      readonly ok: false
      readonly reason: 'no_preview' | 'nothing_to_undo' | 'invalid_move'
      readonly message: string
      readonly validation: MoveValidation | null
    }

export interface LocalLayoutRecord {
  readonly formatVersion: 1
  readonly scope: SampleScope
  readonly placements: readonly BuildingPlacement[]
  readonly savedAt: string
}

export type StorageFailure = 'storage_unavailable' | 'quota_exceeded' | 'storage_error'

export type SaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: StorageFailure; readonly message: string }

export type RestoreResult =
  | { readonly status: 'none' }
  | { readonly status: 'ready'; readonly layout: LayoutState }
  | { readonly status: 'damaged'; readonly message: string }
  | { readonly status: 'incompatible'; readonly message: string }
  | { readonly status: 'error'; readonly reason: StorageFailure; readonly message: string }

export type Selection =
  | { readonly kind: 'resident'; readonly personId: string }
  | { readonly kind: 'location'; readonly locationKey: string }
  | { readonly kind: 'building'; readonly buildingId: string }

export interface ResidentPlacement {
  readonly personId: string
  readonly status: 'visible' | 'unrepresented' | 'unknown'
  readonly spaceId: string | null
  readonly point: GridPoint | null
  readonly reason: string | null
}

export interface PresentedObject {
  readonly id: string
  readonly kind: 'building' | 'decoration' | 'resident' | 'location'
  readonly assetId: string | null
  readonly origin: GridPoint
  readonly selection: Selection | null
}

export interface PresentedLocation {
  readonly locationKey: string | null
  readonly name: string
  readonly description: string
  readonly residentIds: readonly string[]
  readonly representation: 'outdoor' | 'interior' | 'unrepresented' | 'unknown'
}

export interface ScenePresentation {
  readonly scope: SampleScope
  readonly spaceId: string
  readonly simNow: string | null
  readonly timeZone: string
  readonly timeOfDay: TimeOfDay
  readonly objects: readonly PresentedObject[]
  readonly residents: readonly WorldResident[]
  readonly residentPlacements: readonly ResidentPlacement[]
  readonly locations: readonly PresentedLocation[]
  /** Optional D3 environment projection consumed by 2D visuals. */
  readonly environment?: import('./projection').Native2dEnvironmentPresentation
}

export type ViewportEvent =
  | { readonly type: 'select'; readonly selection: Selection | null }
  | { readonly type: 'free-pan' }
  | { readonly type: 'move-target'; readonly buildingId: string; readonly target: GridPoint }
  | { readonly type: 'error'; readonly message: string }

export interface ViewportDiagnostics {
  readonly width: number
  readonly height: number
  readonly resolution: number
  readonly renderer: string
  readonly drawCount: number
  readonly lastRenderMs: number
  readonly objectBounds: Readonly<
    Record<
      string,
      { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    >
  >
}

export type SourceConfig =
  | { readonly kind: 'account'; readonly worldId: string; readonly timelineId?: string }
  | { readonly kind: 'public'; readonly worldId?: string; readonly timelineId?: string }
  | { readonly kind: 'fixture'; readonly fixtureId: string }

export interface WorldSource {
  load(signal: AbortSignal): Promise<WorldReadModel>
}

export interface LayoutEditor {
  preview(buildingId: string, target: GridPoint): MoveValidation
  applyPreview(): EditResult
  cancelPreview(): void
  undo(): EditResult
  getLayout(): LayoutState
}

export interface LayoutRepository {
  load(scope: SampleScope): RestoreResult | Promise<RestoreResult>
  save(layout: LayoutState): SaveResult | Promise<SaveResult>
  reset(scope: SampleScope): SaveResult | Promise<SaveResult>
}

export interface Native2dViewport {
  setPresentation(value: ScenePresentation): void
  setSelection(value: Selection | null): void
  setFollow(personId: string | null): void
  setMovePreview(value: MovePreview | null): void
  setMoveMode?(buildingId: string | null): void
  showOverview(): void
  retryAssets?(): void
  dispose(): void
}
