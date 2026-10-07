import type {
  CameraSnapshot,
  CameraSnapshotFor,
  MountedPresentation,
  PaneTarget,
  PresentationAdapter,
  PresentationKind,
  PresentationStateStore,
  WorldPresentationContext,
} from './presentation-types'

export type PresentationContext = {
  [K in PresentationKind]: WorldPresentationContext & { presentation: K }
}[PresentationKind]

export type MountedPresentationForKind = {
  [K in PresentationKind]: {
    target: PaneTarget & { presentation: K }
    mounted: MountedPresentation<K>
  }
}[PresentationKind]

export interface PresentationLifecycleAdapters {
  native2d: PresentationAdapter<'native2d'>
  voxel3d: PresentationAdapter<'voxel3d'>
}

export type PresentationTransitionResult =
  | { kind: 'mounted'; presentation: PresentationKind }
  | { kind: 'stale' }
  | { kind: 'disposed' }
  | { kind: 'error'; error: unknown; retryable: true }

export interface PresentationLifecycle {
  transition(
    context: PresentationContext,
    host: HTMLElement,
    options?: {
      onCameraChange?: (camera: CameraSnapshot) => void
      onMounted?: (entry: MountedPresentationForKind) => void
    },
  ): Promise<PresentationTransitionResult>
  destroy(): void
}

type MountedEntry = {
  context: WorldPresentationContext
  mounted: Pick<MountedPresentation<PresentationKind>, 'dispose'> & {
    captureCamera(): CameraSnapshot | null
  }
}

interface MountRequest {
  generation: number
  controller: AbortController
}

export function createPresentationLifecycle(dependencies: {
  adapters: PresentationLifecycleAdapters
  store: PresentationStateStore
}): PresentationLifecycle {
  let generation = 0
  let request: MountRequest | undefined
  let mounted: MountedEntry | undefined
  let destroyed = false

  function isCurrent(candidate: MountRequest): boolean {
    return !destroyed && generation === candidate.generation
      && request === candidate && !candidate.controller.signal.aborted
  }

  function snapshotContext(context: PresentationContext): PresentationContext {
    if (context.presentation === 'native2d') {
      return { ...context, capabilities: { ...context.capabilities } }
    }
    return { ...context, capabilities: { ...context.capabilities } }
  }

  function isCameraFor<K extends PresentationKind>(
    camera: CameraSnapshot | null,
    kind: K,
  ): camera is CameraSnapshotFor<K> {
    return camera !== null && camera.kind === kind && camera.version === 1
  }

  function targetFor(context: WorldPresentationContext): PaneTarget & { timelineId: string } {
    return {
      worldId: context.worldId,
      timelineId: context.timelineId,
      presentation: context.presentation,
    }
  }

  function persistCamera(entry: MountedEntry): void {
    try {
      const camera = entry.mounted.captureCamera()
      if (!isCameraFor(camera, entry.context.presentation)) return
      dependencies.store.setCamera(targetFor(entry.context), camera)
    } catch {
      // A failed capture or storage write cannot prevent viewport disposal.
    }
  }

  function releaseMounted(): void {
    const previous = mounted
    mounted = undefined
    if (!previous) return
    persistCamera(previous)
    try { previous.mounted.dispose() } catch { /* Keep lifecycle cleanup local to this pane. */ }
  }

  function invalidateCurrent(): void {
    const previous = request
    request = undefined
    if (previous) previous.controller.abort()
  }

  async function mount<K extends PresentationKind>(
    adapter: PresentationAdapter<K>,
    context: WorldPresentationContext & { presentation: K },
    host: HTMLElement,
    candidate: MountRequest,
    options?: {
      onCameraChange?: (camera: CameraSnapshot) => void
      onMounted?: (entry: MountedPresentationForKind) => void
    },
  ): Promise<PresentationTransitionResult> {
    let camera: CameraSnapshotFor<K> | undefined
    try {
      const saved = dependencies.store.getCamera(targetFor(context))
      if (isCameraFor(saved, context.presentation)) camera = saved
    } catch {
      // A failed restore is equivalent to having no saved camera.
    }
    if (!isCurrent(candidate)) return { kind: 'stale' }

    try {
      const handle = await adapter.mount(host, context, {
        signal: candidate.controller.signal,
        camera,
        onCameraChange: snapshot => {
          if (!isCurrent(candidate) || !isCameraFor(snapshot, context.presentation)) return
          try { dependencies.store.setCamera(targetFor(context), snapshot) } catch { /* Persistence is optional. */ }
          if (!isCurrent(candidate)) return
          try { options?.onCameraChange?.(snapshot) } catch { /* Consumer callbacks cannot break a pane. */ }
        },
      })

      if (!isCurrent(candidate)) {
        try { handle.dispose() } catch { /* Late mounts are still released when cleanup throws. */ }
        return { kind: 'stale' }
      }

      mounted = { context, mounted: handle }
      options?.onMounted?.({ target: targetFor(context), mounted: handle } as MountedPresentationForKind)
      return { kind: 'mounted', presentation: context.presentation }
    } catch (error) {
      if (!isCurrent(candidate)) return { kind: 'stale' }
      request = undefined
      candidate.controller.abort()
      return { kind: 'error', error, retryable: true }
    }
  }

  return {
    transition(context, host, options) {
      if (destroyed) return Promise.resolve({ kind: 'disposed' })
      const transitionGeneration = ++generation
      const contextSnapshot = snapshotContext(context)
      invalidateCurrent()
      releaseMounted()
      if (destroyed) return Promise.resolve({ kind: 'disposed' })
      if (generation !== transitionGeneration) return Promise.resolve({ kind: 'stale' })
      const candidate: MountRequest = {
        generation: transitionGeneration,
        controller: new AbortController(),
      }
      request = candidate
      if (contextSnapshot.presentation === 'native2d') {
        return mount(dependencies.adapters.native2d, contextSnapshot, host, candidate, options)
      }
      return mount(dependencies.adapters.voxel3d, contextSnapshot, host, candidate, options)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      generation += 1
      invalidateCurrent()
      releaseMounted()
    },
  }
}
