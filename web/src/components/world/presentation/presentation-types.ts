import type { SerializedVoxelDocument, SerializedVoxelSpaces, VoxelDocument } from '@wispiva/voxel-contract'
import type { WorldSnapshot } from '../../../api/types'
import type { Camera } from '../../../native2d/projection'
import type { WorldReadModel } from '../../../native2d/types'
import type { OrbitPose } from '../../../voxel/engine/camera'

/** Contract version for independently implemented pane adapters and state stores. */
export const PRESENTATION_CONTRACT_VERSION = 2 as const

export type PresentationKind = 'voxel3d' | 'native2d'
export type PaneId = 'single' | 'left' | 'right'

/**
 * One pane's read target. Timeline/space may be omitted to mean "the reader
 * resolves the default once"; they become concrete only in the read result.
 */
export interface PaneTarget {
  worldId: string
  timelineId?: string
  spaceId?: string
  presentation: PresentationKind
}

/** One API-readable space of the selected scene document; never client-invented. */
export interface SpaceDescriptor {
  id: string
  label: string
  kind: 'exterior' | 'interior' | 'unknown'
  supportedPresentations: readonly PresentationKind[]
}

/** Identity and capabilities must come from the pane's authorized API session. */
export interface WorldPresentationContext {
  paneId: PaneId
  worldId: string
  timelineId: string
  spaceId: string
  presentation: PresentationKind
  identity: 'owner' | 'guest' | 'readonly'
  capabilities: Readonly<Record<string, boolean>>
  sceneId: string
  sceneVersion: number
  stateVersion: number | null
  simNow: string
  timeZone: string
  availableSpaces: readonly SpaceDescriptor[]
}

export interface ComparisonTarget {
  left: PaneTarget
  right: PaneTarget
}

/**
 * One pane's read result: the API-confirmed context plus every projection
 * input (snapshot, scene envelope, selected space document, read model) from
 * the same read. Adapters consume this instead of re-reading the world.
 */
export interface PaneWorldData {
  context: WorldPresentationContext
  snapshot: WorldSnapshot
  sceneDocument: SerializedVoxelDocument | SerializedVoxelSpaces
  selectedSpaceDocument: VoxelDocument
  worldReadModel: WorldReadModel
}

/** A readable but unpresentable target: stable reason code plus business copy. */
export interface PaneUnsupported {
  kind: 'unsupported'
  code: string
  reason: string
  alternatives?: readonly SpaceDescriptor[]
}

export type PaneSessionLoader = (
  target: PaneTarget,
  signal: AbortSignal,
) => Promise<PaneWorldData | PaneUnsupported>

export type PaneLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: PaneWorldData }
  | { kind: 'unsupported'; code: string; reason: string; alternatives?: readonly SpaceDescriptor[] }
  | { kind: 'error'; message: string; retryable: boolean }

export type CameraSnapshot =
  | { kind: 'voxel3d'; version: 1; pose: OrbitPose }
  | { kind: 'native2d'; version: 1; camera: Camera }

export type CameraSnapshotFor<K extends PresentationKind> = Extract<CameraSnapshot, { kind: K }>

/** A read result specialized to one presentation kind; adapters never re-read. */
export type PanePresentationData<K extends PresentationKind = PresentationKind> = PaneWorldData & {
  context: WorldPresentationContext & { presentation: K }
}

export interface PresentationAdapter<K extends PresentationKind> {
  readonly kind: K
  /** Cheap pre-mount guard; resource failures and cancellation stay in mount. */
  supports(data: PanePresentationData<K>): boolean
  mount(
    host: HTMLElement,
    data: PanePresentationData<K>,
    options: {
      signal: AbortSignal
      camera?: CameraSnapshotFor<K>
      onCameraChange?: (camera: CameraSnapshotFor<K>) => void
    },
  ): Promise<MountedPresentation<K>>
}

export interface MountedPresentation<K extends PresentationKind> {
  captureCamera(): CameraSnapshotFor<K> | null
  applyLinkedCamera(camera: CameraSnapshotFor<K>): void
  dispose(): void
}

export type CameraStateTarget = PaneTarget & { timelineId: string; spaceId: string }

export interface PresentationStateStore {
  getPreferred(): PresentationKind | null
  setPreferred(kind: PresentationKind): void
  getCamera(target: CameraStateTarget): CameraSnapshot | null
  setCamera(target: CameraStateTarget, camera: CameraSnapshot): void
}

/** Camera linking needs the same world, representation, and concrete space. */
export type CameraLinkScope = Pick<PaneTarget, 'worldId' | 'presentation' | 'spaceId'>

export function canLinkCameras(left: CameraLinkScope, right: CameraLinkScope): boolean {
  return left.worldId === right.worldId
    && left.presentation === right.presentation
    && (left.spaceId ?? undefined) === (right.spaceId ?? undefined)
}
