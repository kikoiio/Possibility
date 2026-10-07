import { describe, expect, it, vi } from 'vitest'
import {
  createCameraLinkCoordinator,
  type CameraLinkPaneFor,
} from './CameraLinkCoordinator'
import type {
  CameraSnapshot,
  CameraSnapshotFor,
  MountedPresentation,
  PaneTarget,
  PresentationKind,
} from './presentation-types'

const native = (x = 1): CameraSnapshotFor<'native2d'> => ({
  kind: 'native2d', version: 1, camera: { pan: { x, y: 2 }, zoom: 1.5 },
})
const voxel = (theta = 1): CameraSnapshotFor<'voxel3d'> => ({
  kind: 'voxel3d', version: 1,
  pose: { theta, phi: 0.7, distance: 30, target: { x: 2, y: 3, z: 4 } },
})

/** No renderer, DOM, timers, storage, or API: delayed events are flushed explicitly. */
class FakeMounted<K extends PresentationKind> implements MountedPresentation<K> {
  readonly listeners = new Set<(camera: CameraSnapshotFor<K>) => void>()
  readonly registered: ((camera: CameraSnapshotFor<K>) => void)[] = []
  readonly deferred: CameraSnapshotFor<K>[] = []
  readonly cleanups: ReturnType<typeof vi.fn>[] = []
  echo: 'none' | 'sync' | 'async' | 'both' = 'none'
  onApply?: (camera: CameraSnapshotFor<K>) => void
  failSubscribe = false
  failUnsubscribe = false
  camera: CameraSnapshotFor<K> | null

  constructor(readonly kind: K, camera: CameraSnapshotFor<K>) { this.camera = camera }

  readonly captureCamera = vi.fn(() => this.camera)
  readonly dispose = vi.fn()
  readonly applyLinkedCamera = vi.fn((camera: CameraSnapshotFor<K>) => {
    this.camera = camera
    if (this.echo === 'sync' || this.echo === 'both') this.emit(camera)
    if (this.echo === 'async' || this.echo === 'both') this.deferred.push(camera)
    this.onApply?.(camera)
  })
  readonly subscribe = (listener: (camera: CameraSnapshotFor<K>) => void) => {
    if (this.failSubscribe) throw new Error('subscribe failed')
    this.listeners.add(listener)
    this.registered.push(listener)
    const cleanup = vi.fn(() => {
      if (this.failUnsubscribe) throw new Error('unsubscribe failed')
      this.listeners.delete(listener)
    })
    this.cleanups.push(cleanup)
    return cleanup
  }

  emit(camera: CameraSnapshotFor<K>): void {
    this.camera = camera
    for (const listener of this.listeners) listener(camera)
  }

  binding(overrides: Partial<PaneTarget> = {}): CameraLinkPaneFor<K> {
    return {
      target: { worldId: 'world-a', timelineId: 'main', ...overrides,
        presentation: this.kind },
      mounted: this, subscribe: this.subscribe,
    }
  }
}

function setupNative() {
  const coordinator = createCameraLinkCoordinator()
  const left = new FakeMounted('native2d', native())
  const right = new FakeMounted('native2d', native(10))
  coordinator.bind('left', left.binding())
  coordinator.bind('right', right.binding({ timelineId: 'fork' }))
  return { coordinator, left, right }
}

describe('pure camera link coordinator', () => {
  it('keeps both panes independent by default, and enabling does not move them', () => {
    const { coordinator, left, right } = setupNative()
    expect(coordinator.isLinkActive()).toBe(false)
    left.emit(native(3))
    right.emit(native(4))
    coordinator.setEnabled(true)
    expect(coordinator.isLinkActive()).toBe(true)
    expect(left.applyLinkedCamera).not.toHaveBeenCalled()
    expect(right.applyLinkedCamera).not.toHaveBeenCalled()
    expect(left.captureCamera).not.toHaveBeenCalled()
    expect(right.captureCamera).not.toHaveBeenCalled()
  })

  it('links same-world native cameras across different timelines in both directions by paneId', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    left.emit(native(3))
    expect(right.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(3))
    expect(left.applyLinkedCamera).not.toHaveBeenCalled()
    right.emit(native(7))
    expect(left.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(7))
    expect(right.applyLinkedCamera).toHaveBeenCalledTimes(1)
  })

  it('links same-world voxel poses and copies nested targets', () => {
    const coordinator = createCameraLinkCoordinator()
    const left = new FakeMounted('voxel3d', voxel())
    const right = new FakeMounted('voxel3d', voxel(2))
    coordinator.bind('left', left.binding())
    coordinator.bind('right', right.binding({ timelineId: 'fork' }))
    coordinator.setEnabled(true)
    const snapshot = voxel(4)
    left.emit(snapshot)
    const received = right.applyLinkedCamera.mock.calls[0][0]
    expect(received).toEqual(snapshot)
    expect(received).not.toBe(snapshot)
    expect(received.pose).not.toBe(snapshot.pose)
    expect(received.pose.target).not.toBe(snapshot.pose.target)
    received.pose.target.x = 99
    expect(snapshot.pose.target.x).toBe(2)
    right.emit(voxel(8))
    expect(left.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(voxel(8))
  })

  it('copies native camera snapshots so neither source nor receiver shares nested pan', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    const snapshot = native(3)
    left.emit(snapshot)
    const received = right.applyLinkedCamera.mock.calls[0][0]
    expect(received).toEqual(snapshot)
    expect(received).not.toBe(snapshot)
    expect(received.camera).not.toBe(snapshot.camera)
    expect(received.camera.pan).not.toBe(snapshot.camera.pan)
    Object.assign(received.camera.pan, { x: 99 })
    expect(snapshot.camera.pan.x).toBe(3)
  })

  it.each(['left', 'right'] as const)('rejects cross-world native linking when %s differs', paneId => {
    const { coordinator, left, right } = setupNative()
    coordinator.bind(paneId, (paneId === 'left' ? left : right).binding({ worldId: 'world-b' }))
    coordinator.setEnabled(true)
    expect(coordinator.isLinkActive()).toBe(false)
    left.emit(native(3))
    right.emit(native(4))
    expect(left.applyLinkedCamera).not.toHaveBeenCalled()
    expect(right.applyLinkedCamera).not.toHaveBeenCalled()
  })

  it('rejects cross-world voxel linking', () => {
    const coordinator = createCameraLinkCoordinator()
    const left = new FakeMounted('voxel3d', voxel())
    const right = new FakeMounted('voxel3d', voxel(2))
    coordinator.bind('left', left.binding())
    coordinator.bind('right', right.binding({ worldId: 'world-b' }))
    coordinator.setEnabled(true)
    expect(coordinator.isLinkActive()).toBe(false)
    left.emit(voxel(3))
    right.emit(voxel(4))
    expect(left.applyLinkedCamera).not.toHaveBeenCalled()
    expect(right.applyLinkedCamera).not.toHaveBeenCalled()
  })

  it.each(['left', 'right'] as const)('rejects mixed presentations with native on %s', nativeSide => {
    const coordinator = createCameraLinkCoordinator()
    const nativeHandle = new FakeMounted('native2d', native())
    const voxelHandle = new FakeMounted('voxel3d', voxel())
    coordinator.bind(nativeSide, nativeHandle.binding())
    coordinator.bind(nativeSide === 'left' ? 'right' : 'left', voxelHandle.binding())
    coordinator.setEnabled(true)
    expect(coordinator.isLinkActive()).toBe(false)
    nativeHandle.emit(native(3))
    voxelHandle.emit(voxel(4))
    expect(nativeHandle.applyLinkedCamera).not.toHaveBeenCalled()
    expect(voxelHandle.applyLinkedCamera).not.toHaveBeenCalled()
  })

  it('stops linking on disable and waits for a new event after re-enabling', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    left.emit(native(3))
    coordinator.setEnabled(false)
    left.emit(native(4))
    right.emit(native(5))
    expect(coordinator.isLinkActive()).toBe(false)
    expect(right.camera).toEqual(native(5))
    expect(left.camera).toEqual(native(4))
    expect(right.applyLinkedCamera).toHaveBeenCalledTimes(1)
    expect(left.applyLinkedCamera).not.toHaveBeenCalled()
    coordinator.setEnabled(true)
    expect(right.applyLinkedCamera).toHaveBeenCalledTimes(1)
    left.emit(native(6))
    expect(right.applyLinkedCamera).toHaveBeenLastCalledWith(native(6))
  })

  it('suppresses synchronous and corresponding asynchronous echoes without hiding new poses', () => {
    const { coordinator, left, right } = setupNative()
    left.echo = 'both'
    right.echo = 'both'
    coordinator.setEnabled(true)
    left.emit(native(3))
    expect(right.applyLinkedCamera).toHaveBeenCalledTimes(1)
    expect(left.applyLinkedCamera).not.toHaveBeenCalled()
    right.emit(right.deferred.shift()!)
    expect(left.applyLinkedCamera).not.toHaveBeenCalled()
    right.emit(native(4))
    expect(left.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(4))
    left.emit(left.deferred.shift()!)
    expect(right.applyLinkedCamera).toHaveBeenCalledTimes(1)
    left.emit(native(5))
    expect(right.applyLinkedCamera).toHaveBeenCalledTimes(2)
  })

  it('filters outstanding asynchronous echoes out of order even after a different user pose', () => {
    const { coordinator, left, right } = setupNative()
    right.echo = 'async'
    coordinator.setEnabled(true)
    left.emit(native(3))
    left.emit(native(4))
    right.emit(native(5))
    expect(left.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(5))
    right.emit(right.deferred.pop()!)
    right.emit(right.deferred.pop()!)
    expect(left.applyLinkedCamera).toHaveBeenCalledTimes(1)
    right.emit(native(6))
    expect(left.applyLinkedCamera).toHaveBeenLastCalledWith(native(6))
  })

  it('accounts for repeated applications of the same pose', () => {
    const { coordinator, left, right } = setupNative()
    right.echo = 'async'
    coordinator.setEnabled(true)
    left.emit(native(3))
    left.emit(native(3))
    right.emit(right.deferred.shift()!)
    right.emit(right.deferred.shift()!)
    expect(left.applyLinkedCamera).not.toHaveBeenCalled()
    right.emit(native(4))
    expect(left.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(4))
  })

  it('retains only the latest 64 different poses after thousands of unacknowledged applies', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    for (let x = 1; x <= 4096; x++) coordinator.notifyCameraChange('left', native(x))
    expect(right.applyLinkedCamera).toHaveBeenCalledTimes(4096)

    // Probe the entire applied history through public events. Only the retained
    // window is suppressed; every evicted pose can be a new user move again.
    for (let x = 1; x <= 4096; x++) right.emit(native(x))
    expect(left.applyLinkedCamera).toHaveBeenCalledTimes(4096 - 64)
    expect(left.applyLinkedCamera).toHaveBeenLastCalledWith(native(4096 - 64))
    right.emit(native(5000))
    expect(left.applyLinkedCamera).toHaveBeenLastCalledWith(native(5000))
  })

  it('refreshes a repeated pose before evicting the least recently applied pose', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    for (let x = 1; x <= 64; x++) left.emit(native(x))
    left.emit(native(1))
    left.emit(native(65))
    right.emit(native(2))
    expect(left.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(2))
    // Both applications of the refreshed pose are still represented.
    right.emit(native(1))
    right.emit(native(1))
    right.emit(native(65))
    expect(left.applyLinkedCamera).toHaveBeenCalledTimes(1)
  })

  it('compares contract values, independent of property order or receiver mutations', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    right.onApply = camera => { Object.assign(camera.camera.pan, { x: 99 }) }
    left.emit(native(3))
    right.emit({ version: 1, camera: { zoom: 1.5, pan: { y: 2, x: 3 } }, kind: 'native2d' })
    expect(left.applyLinkedCamera).not.toHaveBeenCalled()
    right.emit(native(99))
    expect(left.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(99))
  })

  it('treats a change in any voxel contract field as a new user pose', () => {
    const coordinator = createCameraLinkCoordinator()
    const left = new FakeMounted('voxel3d', voxel())
    const right = new FakeMounted('voxel3d', voxel())
    coordinator.bind('left', left.binding())
    coordinator.bind('right', right.binding())
    coordinator.setEnabled(true)
    const changes: CameraSnapshotFor<'voxel3d'>[] = [
      { ...voxel(), pose: { ...voxel().pose, theta: 9 } },
      { ...voxel(), pose: { ...voxel().pose, phi: 9 } },
      { ...voxel(), pose: { ...voxel().pose, distance: 9 } },
      ...(['x', 'y', 'z'] as const).map(axis => ({
        ...voxel(), pose: { ...voxel().pose, target: { ...voxel().pose.target, [axis]: 9 } },
      })),
    ]
    for (const changed of changes) {
      left.emit(voxel())
      right.emit(changed)
      expect(left.applyLinkedCamera).toHaveBeenLastCalledWith(changed)
    }
    expect(left.applyLinkedCamera).toHaveBeenCalledTimes(changes.length)
  })

  it('passes native pan and zoom changes while suppressing an equal-valued echo', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    const changes: CameraSnapshotFor<'native2d'>[] = [
      native(9),
      { ...native(), camera: { pan: { x: 1, y: 9 }, zoom: 1.5 } },
      { ...native(), camera: { pan: { x: 1, y: 2 }, zoom: 9 } },
    ]
    for (const changed of changes) {
      left.emit(native())
      right.emit(changed)
      expect(left.applyLinkedCamera).toHaveBeenLastCalledWith(changed)
      right.emit(native())
    }
    expect(left.applyLinkedCamera).toHaveBeenCalledTimes(changes.length)
  })

  it('suppresses voxel echoes by value and propagates a different voxel pose', () => {
    const coordinator = createCameraLinkCoordinator()
    const left = new FakeMounted('voxel3d', voxel())
    const right = new FakeMounted('voxel3d', voxel(2))
    left.echo = 'sync'
    right.echo = 'both'
    coordinator.bind('left', left.binding())
    coordinator.bind('right', right.binding())
    coordinator.setEnabled(true)
    left.emit(voxel(3))
    right.emit(voxel(3))
    expect(left.applyLinkedCamera).not.toHaveBeenCalled()
    right.emit(voxel(4))
    expect(left.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(voxel(4))
    expect(right.applyLinkedCamera).toHaveBeenCalledTimes(1)
  })

  it('supports direct host notifications, capture, single-pane rejection and snapshot type checks', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.bind('left', { target: left.binding().target, mounted: left })
    coordinator.setEnabled(true)
    coordinator.notifyCameraChange('single', native(3))
    coordinator.notifyCameraChange('left', voxel())
    coordinator.notifyCameraChange('left', { ...native(), version: 2 } as unknown as CameraSnapshot)
    expect(right.applyLinkedCamera).not.toHaveBeenCalled()
    coordinator.notifyCameraChange('left', native(4))
    expect(right.applyLinkedCamera).toHaveBeenLastCalledWith(native(4))
    left.camera = native(5)
    coordinator.notifyCameraChange('left')
    expect(left.captureCamera).toHaveBeenCalledTimes(1)
    expect(right.applyLinkedCamera).toHaveBeenLastCalledWith(native(5))
    left.camera = null
    coordinator.notifyCameraChange('left')
    expect(right.applyLinkedCamera).toHaveBeenCalledTimes(2)
  })

  it('cancels old subscriptions on handle/timeline replacement and ignores queued old callbacks', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    const oldCallback = right.registered[0]
    const replacement = new FakeMounted('native2d', native(20))
    coordinator.bind('right', replacement.binding({ timelineId: 'fork-2' }))
    expect(right.cleanups[0]).toHaveBeenCalledTimes(1)
    expect(right.listeners.size).toBe(0)
    oldCallback(native(30))
    expect(left.applyLinkedCamera).not.toHaveBeenCalled()
    left.emit(native(4))
    expect(replacement.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(4))
    expect(right.applyLinkedCamera).not.toHaveBeenCalled()
    replacement.emit(native(5))
    expect(left.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(5))
    expect(right.dispose).not.toHaveBeenCalled()
  })

  it('clears both panes echo history when either target is rebound', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    left.emit(native(3))
    right.emit(native(4))
    coordinator.bind('left', left.binding({ timelineId: 'another' }))
    right.emit(native(3))
    expect(left.applyLinkedCamera).toHaveBeenLastCalledWith(native(3))
    left.emit(native(4))
    expect(right.applyLinkedCamera).toHaveBeenLastCalledWith(native(4))
    expect(left.cleanups[0]).toHaveBeenCalledTimes(1)
  })

  it('reevaluates world/presentation replacements and detachment without disposing viewports', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    coordinator.bind('right', right.binding({ worldId: 'world-b' }))
    expect(coordinator.isLinkActive()).toBe(false)
    left.emit(native(3))
    const replacement = new FakeMounted('voxel3d', voxel())
    coordinator.bind('right', replacement.binding())
    expect(coordinator.isLinkActive()).toBe(false)
    left.emit(native(4))
    coordinator.bind('right', null)
    expect(coordinator.isLinkActive()).toBe(false)
    left.emit(native(5))
    coordinator.bind('right', right.binding())
    expect(coordinator.isLinkActive()).toBe(true)
    left.emit(native(6))
    expect(right.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(6))
    expect(replacement.cleanups[0]).toHaveBeenCalledTimes(1)
    expect(left.dispose).not.toHaveBeenCalled()
    expect(right.dispose).not.toHaveBeenCalled()
    expect(replacement.dispose).not.toHaveBeenCalled()
  })

  it('copies targets so callers cannot silently change a bound comparison', () => {
    const { coordinator, left, right } = setupNative()
    const binding = right.binding()
    coordinator.bind('right', binding)
    binding.target.worldId = 'world-b'
    const replacement = new FakeMounted('native2d', native(30))
    binding.mounted = replacement
    coordinator.setEnabled(true)
    expect(coordinator.isLinkActive()).toBe(true)
    left.emit(native(4))
    expect(right.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(4))
    expect(replacement.applyLinkedCamera).not.toHaveBeenCalled()
  })

  it('contains apply failures, removes their echo tokens and keeps the reverse direction available', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    right.onApply = () => { throw new Error('apply failed') }
    expect(() => left.emit(native(3))).not.toThrow()
    right.emit(native(3))
    expect(left.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(3))
    right.onApply = undefined
    left.emit(native(4))
    expect(right.applyLinkedCamera).toHaveBeenLastCalledWith(native(4))
    expect(left.dispose).not.toHaveBeenCalled()
  })

  it('contains capture failures while keeping the handle available to receive a linked pose', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    left.captureCamera.mockImplementation(() => { throw new Error('capture failed') })
    expect(() => coordinator.notifyCameraChange('left')).not.toThrow()
    expect(right.applyLinkedCamera).not.toHaveBeenCalled()
    right.emit(native(4))
    expect(left.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(4))
  })

  it('allows direct events after subscription setup failure', () => {
    const { coordinator, left, right } = setupNative()
    left.failSubscribe = true
    expect(() => coordinator.bind('left', left.binding())).not.toThrow()
    coordinator.setEnabled(true)
    coordinator.notifyCameraChange('left', native(4))
    expect(right.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(4))
    right.emit(native(5))
    expect(left.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(5))
  })

  it('contains unsubscribe failures and still invalidates old listeners', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    right.failUnsubscribe = true
    const replacement = new FakeMounted('native2d', native(20))
    expect(() => coordinator.bind('right', replacement.binding())).not.toThrow()
    right.emit(native(3))
    expect(left.applyLinkedCamera).not.toHaveBeenCalled()
    replacement.emit(native(4))
    expect(left.applyLinkedCamera).toHaveBeenCalledExactlyOnceWith(native(4))
  })

  it('clears both echo histories on disable so old poses propagate after re-enabling', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    left.emit(native(3))
    right.emit(native(4))
    coordinator.setEnabled(false)
    expect(coordinator.isLinkActive()).toBe(false)
    left.emit(native(5))
    right.emit(native(6))
    expect(left.applyLinkedCamera).toHaveBeenCalledTimes(1)
    expect(right.applyLinkedCamera).toHaveBeenCalledTimes(1)
    coordinator.setEnabled(true)
    right.emit(native(3))
    expect(left.applyLinkedCamera).toHaveBeenLastCalledWith(native(3))
    left.emit(native(4))
    expect(right.applyLinkedCamera).toHaveBeenLastCalledWith(native(4))
    expect(left.applyLinkedCamera).toHaveBeenCalledTimes(2)
    expect(right.applyLinkedCamera).toHaveBeenCalledTimes(2)
  })

  it('disposes idempotently, cancels both listeners despite errors, and never owns viewport disposal', () => {
    const { coordinator, left, right } = setupNative()
    coordinator.setEnabled(true)
    left.failUnsubscribe = true
    expect(() => coordinator.dispose()).not.toThrow()
    coordinator.dispose()
    expect(left.cleanups[0]).toHaveBeenCalledTimes(1)
    expect(right.cleanups[0]).toHaveBeenCalledTimes(1)
    left.emit(native(3))
    right.registered[0](native(4))
    coordinator.notifyCameraChange('left', native(5))
    coordinator.setEnabled(true)
    coordinator.bind('right', right.binding())
    expect(coordinator.isLinkActive()).toBe(false)
    expect(left.applyLinkedCamera).not.toHaveBeenCalled()
    expect(right.applyLinkedCamera).not.toHaveBeenCalled()
    expect(right.registered).toHaveLength(1)
    expect(left.dispose).not.toHaveBeenCalled()
    expect(right.dispose).not.toHaveBeenCalled()
  })
})
