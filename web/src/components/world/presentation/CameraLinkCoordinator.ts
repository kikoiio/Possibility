import {
  canLinkCameras,
  type CameraSnapshot,
  type CameraSnapshotFor,
  type MountedPresentation,
  type PaneId,
  type PaneTarget,
  type PresentationKind,
} from './presentation-types'

export type CameraLinkPaneId = Extract<PaneId, 'left' | 'right'>

export interface CameraLinkPaneFor<K extends PresentationKind> {
  target: PaneTarget & { presentation: K }
  mounted: MountedPresentation<K>
  /** Optional host event bridge. The returned function cancels only this listener. */
  subscribe?: (listener: (camera: CameraSnapshotFor<K>) => void) => () => void
}

export type CameraLinkPane = {
  [K in PresentationKind]: CameraLinkPaneFor<K>
}[PresentationKind]

export interface CameraLinkCoordinator {
  /** Replaces this pane's target/handle and subscription; null detaches it. */
  bind(paneId: CameraLinkPaneId, pane: CameraLinkPane | null): void
  /** Defaults to false. Enabling does not jump either camera to the other side. */
  setEnabled(enabled: boolean): void
  /** True only when enabled with two compatible, bound panes. */
  isLinkActive(): boolean
  /** Host onCameraChange bridge; omit camera to capture from the source handle. */
  notifyCameraChange(paneId: PaneId, camera?: CameraSnapshot): void
  /** Cancels owned subscriptions, never disposes caller-owned mounted viewports. */
  dispose(): void
}

interface Binding {
  target: PaneTarget
  mounted: CameraLinkPane['mounted']
  apply(camera: CameraSnapshot): void
  unsubscribe?: () => void
  applying: boolean
  pendingEchoes: Map<string, number>
}

function isNativePane(pane: CameraLinkPane): pane is CameraLinkPaneFor<'native2d'> {
  return pane.target.presentation === 'native2d'
}

function copyCamera(camera: CameraSnapshot): CameraSnapshot {
  return camera.kind === 'native2d'
    ? { kind: camera.kind, version: camera.version,
        camera: { pan: { ...camera.camera.pan }, zoom: camera.camera.zoom } }
    : { kind: camera.kind, version: camera.version,
        pose: { ...camera.pose, target: { ...camera.pose.target } } }
}

/** Uses only contract fields, so property order and extra adapter metadata cannot hide echoes. */
function cameraKey(camera: CameraSnapshot): string {
  return JSON.stringify(camera.kind === 'native2d'
    ? [camera.kind, camera.version, camera.camera.pan.x, camera.camera.pan.y, camera.camera.zoom]
    : [camera.kind, camera.version, camera.pose.theta, camera.pose.phi, camera.pose.distance,
        camera.pose.target.x, camera.pose.target.y, camera.pose.target.z])
}

/** Pure coordination; persistence and mounted viewport ownership stay with the host. */
export function createCameraLinkCoordinator(): CameraLinkCoordinator {
  const bindings: Partial<Record<CameraLinkPaneId, Binding>> = {}
  let enabled = false
  let disposed = false

  function isLinkActive(): boolean {
    return !disposed && enabled && !!bindings.left && !!bindings.right
      && canLinkCameras(bindings.left.target, bindings.right.target)
  }

  function detach(paneId: CameraLinkPaneId): void {
    const old = bindings[paneId]
    // Invalidate before unsubscribe: even a throwing cleanup or queued callback is stale.
    delete bindings[paneId]
    if (!old) return
    old.pendingEchoes.clear()
    try { old.unsubscribe?.() } catch { /* A broken pane cannot block sibling cleanup. */ }
  }

  function notify(paneId: CameraLinkPaneId, source: Binding, camera?: CameraSnapshot): void {
    if (disposed || bindings[paneId] !== source || source.applying) return
    try {
      const snapshot = camera ?? source.mounted.captureCamera()
      if (disposed || bindings[paneId] !== source) return
      if (!snapshot || snapshot.version !== 1 || snapshot.kind !== source.target.presentation) return
      const key = cameraKey(snapshot)
      // Synchronous echoes do not consume this entry, allowing a deferred echo of the
      // same apply to be ignored too. Distinct user poses never match an outstanding apply.
      const pending = source.pendingEchoes.get(key) ?? 0
      if (pending > 0) {
        if (pending === 1) source.pendingEchoes.delete(key)
        else source.pendingEchoes.set(key, pending - 1)
        return
      }
      if (!isLinkActive()) return
      const other = bindings[paneId === 'left' ? 'right' : 'left']!
      other.pendingEchoes.set(key, (other.pendingEchoes.get(key) ?? 0) + 1)
      other.applying = true
      try {
        // Adapter mutations cannot change the source snapshot or the recorded echo key.
        other.apply(copyCamera(snapshot))
      } catch {
        const remaining = other.pendingEchoes.get(key) ?? 0
        if (remaining <= 1) other.pendingEchoes.delete(key)
        else other.pendingEchoes.set(key, remaining - 1)
        // The host owns error reporting/recovery; keep the usable pane subscribed.
      } finally {
        other.applying = false
      }
    } catch { /* captureCamera failures remain local to the source pane. */ }
  }

  return {
    bind(paneId, pane) {
      if (disposed) return
      detach(paneId)
      // Changing either target/handle starts a new comparison, including its echo history.
      bindings.left?.pendingEchoes.clear()
      bindings.right?.pendingEchoes.clear()
      if (!pane) return
      let apply: Binding['apply']
      if (isNativePane(pane)) {
        const mounted = pane.mounted
        apply = camera => {
          if (camera.kind === 'native2d') mounted.applyLinkedCamera(camera)
        }
      } else {
        const mounted = pane.mounted
        apply = camera => {
          if (camera.kind === 'voxel3d') mounted.applyLinkedCamera(camera)
        }
      }
      const binding: Binding = {
        target: { ...pane.target }, mounted: pane.mounted, apply,
        applying: false, pendingEchoes: new Map(),
      }
      bindings[paneId] = binding
      try {
        const unsubscribe = pane.subscribe?.((camera: CameraSnapshot) => notify(paneId, binding, camera))
        if (disposed || bindings[paneId] !== binding) unsubscribe?.()
        else binding.unsubscribe = unsubscribe
      } catch { /* Direct host notifications still work if subscription setup fails. */ }
    },
    setEnabled(value) {
      if (!disposed) enabled = value
    },
    isLinkActive,
    notifyCameraChange(paneId, camera) {
      if (paneId === 'single') return
      const source = bindings[paneId]
      if (source) notify(paneId, source, camera)
    },
    dispose() {
      if (disposed) return
      disposed = true
      enabled = false
      detach('left')
      detach('right')
    },
  }
}
