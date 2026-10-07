import type {
  CameraSnapshot,
  PaneTarget,
  PresentationKind,
  PresentationStateStore,
} from '../components/world/presentation/presentation-types'

/** The only storage operations needed; null explicitly disables persistence for SSR. */
export interface PresentationStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface PresentationPreferenceRecord {
  formatVersion: 1
  preferredPresentation: PresentationKind
  savedAt: number
}

export interface CameraStateRecord {
  formatVersion: 1
  worldId: string
  timelineId: string
  presentation: PresentationKind
  camera: CameraSnapshot
  savedAt: number
}

type CameraTarget = PaneTarget & { timelineId: string }

export const PRESENTATION_PREFERENCE_KEY = 'possibility:presentation:preferred'

/** A tuple avoids collisions even when IDs contain separators or Unicode. */
export function cameraStorageKey(target: CameraTarget): string {
  return `possibility:presentation:camera:${JSON.stringify([
    target.worldId, target.timelineId, target.presentation,
  ])}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKind(value: unknown): value is PresentationKind {
  return value === 'voxel3d' || value === 'native2d'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isCameraSnapshot(value: unknown): value is CameraSnapshot {
  if (!isObject(value) || value.version !== 1) return false
  if (value.kind === 'native2d') {
    const camera = value.camera
    return isObject(camera) && isObject(camera.pan)
      && isFiniteNumber(camera.pan.x) && isFiniteNumber(camera.pan.y)
      && isFiniteNumber(camera.zoom) && camera.zoom > 0
  }
  if (value.kind === 'voxel3d') {
    const pose = value.pose
    return isObject(pose) && isObject(pose.target)
      && isFiniteNumber(pose.theta) && isFiniteNumber(pose.phi)
      && isFiniteNumber(pose.distance) && pose.distance > 0
      && isFiniteNumber(pose.target.x) && isFiniteNumber(pose.target.y)
      && isFiniteNumber(pose.target.z)
  }
  return false
}

/** No storage access at import/construction time; acquisition failures are caught too. */
export function createPresentationStateStore(
  storage?: PresentationStorage | null,
): PresentationStateStore {
  function resolveStorage(): PresentationStorage | null {
    if (storage !== undefined) return storage
    return typeof window === 'undefined' ? null : window.localStorage
  }

  function read(key: string): unknown {
    try {
      const raw = resolveStorage()?.getItem(key)
      return raw == null ? null : JSON.parse(raw)
    } catch {
      return null
    }
  }

  function write(key: string, record: PresentationPreferenceRecord | CameraStateRecord): void {
    try {
      resolveStorage()?.setItem(key, JSON.stringify(record))
    } catch {
      // Persistence is optional; a blocked/quota-limited browser must remain usable.
    }
  }

  return {
    getPreferred() {
      const record = read(PRESENTATION_PREFERENCE_KEY)
      return isObject(record) && record.formatVersion === 1
        && isFiniteNumber(record.savedAt) && isKind(record.preferredPresentation)
        ? record.preferredPresentation : null
    },
    setPreferred(kind) {
      if (!isKind(kind)) return
      write(PRESENTATION_PREFERENCE_KEY, {
        formatVersion: 1, preferredPresentation: kind, savedAt: Date.now(),
      })
    },
    getCamera(target) {
      const record = read(cameraStorageKey(target))
      if (!isObject(record) || record.formatVersion !== 1
        || !isFiniteNumber(record.savedAt)
        || record.worldId !== target.worldId || record.timelineId !== target.timelineId
        || record.presentation !== target.presentation || !isCameraSnapshot(record.camera)
        || record.camera.kind !== target.presentation) return null
      return record.camera
    },
    setCamera(target, camera) {
      if (!isCameraSnapshot(camera) || camera.kind !== target.presentation) return
      write(cameraStorageKey(target), {
        formatVersion: 1, worldId: target.worldId, timelineId: target.timelineId,
        presentation: target.presentation, camera, savedAt: Date.now(),
      })
    },
  }
}
