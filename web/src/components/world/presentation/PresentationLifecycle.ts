import type {
  CameraSnapshot,
  CameraSnapshotFor,
  CameraStateTarget,
  MountedPresentation,
  PanePresentationData,
  PresentationAdapter,
  PresentationKind,
  PresentationStateStore,
  WorldPresentationContext,
} from './presentation-types'

export type PresentationContext = {
  [K in PresentationKind]: PanePresentationData<K>
}[PresentationKind]

export type MountedPresentationForKind = {
  [K in PresentationKind]: {
    target: CameraStateTarget
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

  function isCameraFor<K extends PresentationKind>(
    camera: CameraSnapshot | null,
    kind: K,
  ): camera is CameraSnapshotFor<K> {
    return camera !== null && camera.kind === kind && camera.version === 1
  }

  function targetFor(context: WorldPresentationContext): CameraStateTarget {
    return {
      worldId: context.worldId,
      timelineId: context.timelineId,
      spaceId: context.spaceId,
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
    data: PanePresentationData<K>,
    host: HTMLElement,
    candidate: MountRequest,
    options?: {
      onCameraChange?: (camera: CameraSnapshot) => void
      onMounted?: (entry: MountedPresentationForKind) => void
    },
  ): Promise<PresentationTransitionResult> {
    const context = data.context
    let camera: CameraSnapshotFor<K> | undefined
    try {
      const saved = dependencies.store.getCamera(targetFor(context))
      if (isCameraFor(saved, context.presentation)) camera = saved
    } catch {
      // A failed restore is equivalent to having no saved camera.
    }
    if (!isCurrent(candidate)) return { kind: 'stale' }
    if (!adapter.supports(data)) {
      request = undefined
      candidate.controller.abort()
      return { kind: 'error', error: new Error('这种表现无法呈现当前上下文，请改用其他表现。'), retryable: true }
    }

    try {
      const handle = await adapter.mount(host, data, {
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
      options?.onMounted?.({ target: targetFor(context), mounted: handle } as unknown as MountedPresentationForKind)
      return { kind: 'mounted', presentation: context.presentation }
    } catch (error) {
      if (!isCurrent(candidate)) return { kind: 'stale' }
      request = undefined
      candidate.controller.abort()
      return { kind: 'error', error, retryable: true }
    }
  }

  return {
    transition(data, host, options) {
      if (destroyed) return Promise.resolve({ kind: 'disposed' })
      const transitionGeneration = ++generation
      // 浅拷贝并 detach context/capabilities：调用方随后修改原对象不影响本次挂载。
      const dataSnapshot = {
        ...data,
        context: { ...data.context, capabilities: { ...data.context.capabilities } },
      } as PresentationContext
      invalidateCurrent()
      releaseMounted()
      if (destroyed) return Promise.resolve({ kind: 'disposed' })
      if (generation !== transitionGeneration) return Promise.resolve({ kind: 'stale' })
      const candidate: MountRequest = {
        generation: transitionGeneration,
        controller: new AbortController(),
      }
      request = candidate
      if (dataSnapshot.context.presentation === 'native2d') {
        return mount(dependencies.adapters.native2d, dataSnapshot as PanePresentationData<'native2d'>, host, candidate, options)
      }
      return mount(dependencies.adapters.voxel3d, dataSnapshot as PanePresentationData<'voxel3d'>, host, candidate, options)
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
