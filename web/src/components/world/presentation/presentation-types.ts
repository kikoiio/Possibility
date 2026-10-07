import type { Camera } from '../../../native2d/projection'
import type { OrbitPose } from '../../../voxel/engine/camera'

/** Contract version for independently implemented pane adapters and state stores. */
export const PRESENTATION_CONTRACT_VERSION = 1 as const

export type PresentationKind = 'voxel3d' | 'native2d'
export type PaneId = 'single' | 'left' | 'right'

export interface PaneTarget {
  worldId: string
  timelineId?: string
  presentation: PresentationKind
}

/** Identity and capabilities must come from the pane's authorized API session. */
export interface WorldPresentationContext {
  paneId: PaneId
  worldId: string
  timelineId: string
  presentation: PresentationKind
  identity: 'owner' | 'guest' | 'readonly'
  capabilities: Readonly<Record<string, boolean>>
  stateVersion: number
  simNow: string
}

export interface ComparisonTarget {
  left: PaneTarget
  right: PaneTarget
}

export type PaneLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; context: WorldPresentationContext }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'error'; message: string; retryable: boolean }

export type CameraSnapshot =
  | { kind: 'voxel3d'; version: 1; pose: OrbitPose }
  | { kind: 'native2d'; version: 1; camera: Camera }

export type CameraSnapshotFor<K extends PresentationKind> = Extract<CameraSnapshot, { kind: K }>

export interface PresentationAdapter<K extends PresentationKind> {
  readonly kind: K
  mount(
    host: HTMLElement,
    context: WorldPresentationContext & { presentation: K },
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

export interface PresentationStateStore {
  getPreferred(): PresentationKind | null
  setPreferred(kind: PresentationKind): void
  getCamera(target: PaneTarget & { timelineId: string }): CameraSnapshot | null
  setCamera(target: PaneTarget & { timelineId: string }, camera: CameraSnapshot): void
}

/** Timeline differences allow comparison; world and representation must match. */
export function canLinkCameras(
  left: Pick<PaneTarget, 'worldId' | 'presentation'>,
  right: Pick<PaneTarget, 'worldId' | 'presentation'>,
): boolean {
  return left.worldId === right.worldId && left.presentation === right.presentation
}
