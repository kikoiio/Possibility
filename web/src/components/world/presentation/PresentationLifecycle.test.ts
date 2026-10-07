import { describe, expect, it, vi } from 'vitest'
import type {
  CameraSnapshotFor,
  MountedPresentation,
  PresentationAdapter,
  PresentationKind,
  PresentationStateStore,
} from './presentation-types'
import {
  createPresentationLifecycle,
  type PresentationContext,
} from './PresentationLifecycle'

const nativeContext: PresentationContext = {
  paneId: 'single', worldId: 'world-a', timelineId: 'main', presentation: 'native2d',
  identity: 'owner', capabilities: {}, stateVersion: 1, simNow: '2026-10-07T00:00:00Z',
}
const voxelContext: PresentationContext = { ...nativeContext, presentation: 'voxel3d' }
const nativeCamera: CameraSnapshotFor<'native2d'> = {
  kind: 'native2d', version: 1, camera: { pan: { x: 3, y: -4 }, zoom: 1.5 },
}
const voxelCamera: CameraSnapshotFor<'voxel3d'> = {
  kind: 'voxel3d', version: 1,
  pose: { theta: 0.4, phi: 1.1, distance: 12, target: { x: 1, y: 2, z: 3 } },
}
const host = {} as HTMLElement

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function mounted<K extends PresentationKind>(
  kind: K,
  overrides: Partial<MountedPresentation<K>> = {},
): MountedPresentation<K> {
  const camera = (kind === 'native2d' ? nativeCamera : voxelCamera) as CameraSnapshotFor<K>
  return {
    captureCamera: () => camera,
    applyLinkedCamera: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  }
}

function adapter<K extends PresentationKind>(
  kind: K,
  mount: PresentationAdapter<K>['mount'],
): PresentationAdapter<K> {
  return { kind, mount }
}

function store(overrides: Partial<PresentationStateStore> = {}): PresentationStateStore {
  return {
    getPreferred: () => null,
    setPreferred: vi.fn(),
    getCamera: () => null,
    setCamera: vi.fn(),
    ...overrides,
  }
}

describe('PresentationLifecycle', () => {
  it('aborts a superseded mount and disposes it immediately when its promise resolves late', async () => {
    const pending = deferred<MountedPresentation<'native2d'>>()
    let signal: AbortSignal | undefined
    let reportCamera: ((camera: CameraSnapshotFor<'native2d'>) => void) | undefined
    const onCameraChange = vi.fn()
    const lateHandle = mounted('native2d')
    const state = store()
    const lifecycle = createPresentationLifecycle({
      store: state,
      adapters: {
        native2d: adapter('native2d', (_host, _context, options) => {
          signal = options.signal
          reportCamera = options.onCameraChange
          return pending.promise
        }),
        voxel3d: adapter('voxel3d', async () => mounted('voxel3d')),
      },
    })

    const staleMount = lifecycle.transition(nativeContext, host, { onCameraChange })
    const activeTransition = await lifecycle.transition(voxelContext, host)
    expect(activeTransition).toEqual({ kind: 'mounted', presentation: 'voxel3d' })
    expect(signal?.aborted).toBe(true)

    reportCamera?.(nativeCamera)
    expect(onCameraChange).not.toHaveBeenCalled()
    expect(state.setCamera).not.toHaveBeenCalled()

    pending.resolve(lateHandle)
    expect(await staleMount).toEqual({ kind: 'stale' })
    expect(lateHandle.dispose).toHaveBeenCalledTimes(1)
  })

  it('captures and saves the old camera before disposing on transition', async () => {
    const events: string[] = []
    const oldHandle = mounted('native2d', {
      captureCamera: () => { events.push('capture'); return nativeCamera },
      dispose: () => { events.push('dispose') },
    })
    const state = store({
      setCamera: vi.fn((_target, snapshot) => { events.push(`save:${snapshot.kind}`) }),
    })
    const lifecycle = createPresentationLifecycle({
      store: state,
      adapters: {
        native2d: adapter('native2d', async () => oldHandle),
        voxel3d: adapter('voxel3d', async () => mounted('voxel3d')),
      },
    })

    expect(await lifecycle.transition(nativeContext, host))
      .toEqual({ kind: 'mounted', presentation: 'native2d' })
    await lifecycle.transition(voxelContext, host)
    expect(events).toEqual(['capture', 'save:native2d', 'dispose'])
    expect(state.setCamera).toHaveBeenCalledWith({
      worldId: 'world-a', timelineId: 'main', presentation: 'native2d',
    }, nativeCamera)
  })

  it('restores the matching discriminated camera snapshot for the selected adapter', async () => {
    const state = store({ getCamera: vi.fn(() => voxelCamera) })
    let restoredCamera: CameraSnapshotFor<'voxel3d'> | undefined
    const lifecycle = createPresentationLifecycle({
      store: state,
      adapters: {
        native2d: adapter('native2d', async () => mounted('native2d')),
        voxel3d: adapter('voxel3d', async (_host, _context, options) => {
          restoredCamera = options.camera
          return mounted('voxel3d')
        }),
      },
    })

    expect(await lifecycle.transition(voxelContext, host))
      .toEqual({ kind: 'mounted', presentation: 'voxel3d' })
    expect(state.getCamera).toHaveBeenCalledWith({
      worldId: 'world-a', timelineId: 'main', presentation: 'voxel3d',
    })
    expect(restoredCamera).toEqual(voxelCamera)
    lifecycle.destroy()
  })

  it('uses a context snapshot after the caller mutates its original object', async () => {
    const pending = deferred<MountedPresentation<'native2d'>>()
    const originalContext: PresentationContext = {
      ...nativeContext, capabilities: { canEdit: true },
    }
    let mountedContext: PresentationContext | undefined
    let reportCamera: ((camera: CameraSnapshotFor<'native2d'>) => void) | undefined
    const state = store()
    const lifecycle = createPresentationLifecycle({
      store: state,
      adapters: {
        native2d: adapter('native2d', (_host, context, options) => {
          mountedContext = context
          reportCamera = options.onCameraChange
          return pending.promise
        }),
        voxel3d: adapter('voxel3d', async () => mounted('voxel3d')),
      },
    })

    const pendingMount = lifecycle.transition(originalContext, host)
    originalContext.worldId = 'world-mutated'
    originalContext.timelineId = 'timeline-mutated'
    const mutableCapabilities = originalContext.capabilities as Record<string, boolean>
    mutableCapabilities.canEdit = false
    expect(mountedContext?.worldId).toBe('world-a')
    expect(mountedContext?.timelineId).toBe('main')
    expect(mountedContext?.capabilities.canEdit).toBe(true)

    reportCamera?.(nativeCamera)
    expect(state.setCamera).toHaveBeenCalledWith({
      worldId: 'world-a', timelineId: 'main', presentation: 'native2d',
    }, nativeCamera)
    pending.resolve(mounted('native2d'))
    expect(await pendingMount).toEqual({ kind: 'mounted', presentation: 'native2d' })
    lifecycle.destroy()
  })

  it('does not let a reentrant transition get replaced by the transition being cleaned up', async () => {
    let lifecycle: ReturnType<typeof createPresentationLifecycle> | undefined
    let nestedTransition: Promise<unknown> | undefined
    let reenter = false
    const nestedHandle = mounted('native2d')
    const oldHandle = mounted('native2d', {
      captureCamera: () => {
        if (reenter) {
          reenter = false
          nestedTransition = lifecycle?.transition(nativeContext, host)
        }
        return nativeCamera
      },
    })
    const nativeMount = vi.fn<PresentationAdapter<'native2d'>['mount']>()
      .mockResolvedValueOnce(oldHandle)
      .mockResolvedValueOnce(nestedHandle)
    lifecycle = createPresentationLifecycle({
      store: store(),
      adapters: {
        native2d: adapter('native2d', nativeMount),
        voxel3d: adapter('voxel3d', async () => mounted('voxel3d')),
      },
    })

    await lifecycle!.transition(nativeContext, host)
    reenter = true
    expect(await lifecycle!.transition(voxelContext, host)).toEqual({ kind: 'stale' })
    expect(nestedTransition).toBeDefined()
    expect(await nestedTransition).toEqual({ kind: 'mounted', presentation: 'native2d' })
    lifecycle!.destroy()
    expect(nestedHandle.dispose).toHaveBeenCalledTimes(1)
  })

  it('returns mount failures as retryable and allows a later transition to mount', async () => {
    const failure = new Error('adapter unavailable')
    const handle = mounted('native2d')
    const mount = vi.fn<PresentationAdapter<'native2d'>['mount']>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(handle)
    const lifecycle = createPresentationLifecycle({
      store: store(),
      adapters: {
        native2d: adapter('native2d', mount),
        voxel3d: adapter('voxel3d', async () => mounted('voxel3d')),
      },
    })

    expect(await lifecycle.transition(nativeContext, host))
      .toEqual({ kind: 'error', error: failure, retryable: true })
    expect(await lifecycle.transition(nativeContext, host))
      .toEqual({ kind: 'mounted', presentation: 'native2d' })
    expect(mount).toHaveBeenCalledTimes(2)
  })

  async function assertDestroyCleansUp(
    captureCamera: MountedPresentation<'native2d'>['captureCamera'],
    setCamera: PresentationStateStore['setCamera'],
  ) {
    const handle = mounted('native2d', { captureCamera })
    const lifecycle = createPresentationLifecycle({
      store: store({ setCamera }),
      adapters: {
        native2d: adapter('native2d', async () => handle),
        voxel3d: adapter('voxel3d', async () => mounted('voxel3d')),
      },
    })

    await lifecycle.transition(nativeContext, host)
    expect(() => lifecycle.destroy()).not.toThrow()
    expect(() => lifecycle.destroy()).not.toThrow()
    expect(handle.dispose).toHaveBeenCalledTimes(1)
    expect(await lifecycle.transition(nativeContext, host))
      .toEqual({ kind: 'disposed' })
  }

  it('releases a mount when camera capture fails, and destroy is idempotent', async () => {
    await assertDestroyCleansUp(() => { throw new Error('capture failed') }, vi.fn())
  })

  it('releases a mount when camera storage fails, and destroy is idempotent', async () => {
    await assertDestroyCleansUp(() => nativeCamera, vi.fn(() => { throw new Error('storage failed') }))
  })

  it('does not call camera consumers after destroy and disposes a late mount', async () => {
    const pending = deferred<MountedPresentation<'voxel3d'>>()
    let reportCamera: ((camera: CameraSnapshotFor<'voxel3d'>) => void) | undefined
    const onCameraChange = vi.fn()
    const handle = mounted('voxel3d')
    const lifecycle = createPresentationLifecycle({
      store: store(),
      adapters: {
        native2d: adapter('native2d', async () => mounted('native2d')),
        voxel3d: adapter('voxel3d', (_host, _context, options) => {
          reportCamera = options.onCameraChange
          return pending.promise
        }),
      },
    })

    const lateMount = lifecycle.transition(voxelContext, host, { onCameraChange })
    lifecycle.destroy()
    reportCamera?.(voxelCamera)
    expect(onCameraChange).not.toHaveBeenCalled()
    pending.resolve(handle)
    expect(await lateMount).toEqual({ kind: 'stale' })
    expect(handle.dispose).toHaveBeenCalledTimes(1)
  })
})
