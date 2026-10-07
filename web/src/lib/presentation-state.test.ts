import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CameraSnapshot, PaneTarget } from '../components/world/presentation/presentation-types'
import type { Camera } from '../native2d/projection'
import type { OrbitPose } from '../voxel/engine/camera'
import {
  cameraStorageKey,
  createPresentationStateStore,
  PRESENTATION_PREFERENCE_KEY,
  type PresentationStorage,
} from './presentation-state'

class MemoryStorage implements PresentationStorage {
  readonly entries = new Map<string, string>()
  getItem(key: string): string | null { return this.entries.get(key) ?? null }
  setItem(key: string, value: string): void { this.entries.set(key, value) }
}

const target = { worldId: 'world-a', timelineId: 'main', presentation: 'native2d' } as const
const camera: Camera = { pan: { x: -12.5, y: 40 }, zoom: 1.25 }
const pose: OrbitPose = { theta: -0.5, phi: 0.9, distance: 24, target: { x: 1, y: 2, z: -3 } }
const native = (overrides: Partial<Camera> = {}): CameraSnapshot => ({
  kind: 'native2d', version: 1, camera: { ...camera, ...overrides },
})
const voxel = (overrides: Partial<OrbitPose> = {}): CameraSnapshot => ({
  kind: 'voxel3d', version: 1, pose: { ...pose, ...overrides },
})
function cameraRecord(snapshot: unknown = native(), overrides: Record<string, unknown> = {}) {
  return { formatVersion: 1, ...target, camera: snapshot, savedAt: 123, ...overrides }
}

afterEach(() => vi.unstubAllGlobals())

describe('browser presentation persistence', () => {
  it('round-trips both preferences in a v1 record without touching camera state', () => {
    const storage = new MemoryStorage()
    const store = createPresentationStateStore(storage)
    expect(store.getPreferred()).toBeNull()
    store.setCamera(target, native())
    for (const kind of ['native2d', 'voxel3d'] as const) {
      store.setPreferred(kind)
      expect(store.getPreferred()).toBe(kind)
      expect(JSON.parse(storage.getItem(PRESENTATION_PREFERENCE_KEY)!)).toEqual({
        formatVersion: 1, preferredPresentation: kind, savedAt: expect.any(Number),
      })
      expect(store.getCamera(target)).toEqual(native())
    }
  })

  it('isolates world, timeline and presentation and restores through a fresh store', () => {
    const storage = new MemoryStorage()
    const store = createPresentationStateStore(storage)
    const targets: (PaneTarget & { timelineId: string })[] = [
      target, { ...target, worldId: 'world-b' }, { ...target, timelineId: 'fork' },
      { ...target, presentation: 'voxel3d' },
      { ...target, worldId: 'a:b', timelineId: 'c' },
      { ...target, worldId: 'a', timelineId: 'b:c' },
      { ...target, worldId: '世界/🙂', timelineId: 'branch?&=' },
    ]
    const snapshots = targets.map((item, index) => item.presentation === 'native2d'
      ? native({ zoom: index + 1 }) : voxel({ distance: index + 1 }))
    targets.forEach((item, index) => store.setCamera(item, snapshots[index]))
    expect(storage.entries.size).toBe(targets.length)
    const restored = createPresentationStateStore(storage)
    targets.forEach((item, index) => expect(restored.getCamera(item)).toEqual(snapshots[index]))
    expect(restored.getCamera({ ...target, timelineId: 'absent' })).toBeNull()
    expect(JSON.parse(storage.getItem(cameraStorageKey(target))!)).toEqual({
      ...cameraRecord(snapshots[0]), savedAt: expect.any(Number),
    })
  })

  it.each([
    'not json', 'null', '[]',
    JSON.stringify({ formatVersion: 2, preferredPresentation: 'native2d', savedAt: 123 }),
    JSON.stringify({ preferredPresentation: 'native2d', savedAt: 123 }),
    JSON.stringify({ formatVersion: 1, preferredPresentation: '2d', savedAt: 123 }),
    JSON.stringify({ formatVersion: 1, preferredPresentation: 'native2d' }),
    '{"formatVersion":1,"preferredPresentation":"native2d","savedAt":1e400}',
  ])('ignores an invalid preference without deleting its original value: %s', raw => {
    const storage = new MemoryStorage()
    storage.setItem(PRESENTATION_PREFERENCE_KEY, raw)
    expect(createPresentationStateStore(storage).getPreferred()).toBeNull()
    expect(storage.getItem(PRESENTATION_PREFERENCE_KEY)).toBe(raw)
  })

  it.each([
    ['corrupt JSON', '{'], ['null', 'null'], ['array', '[]'],
    ...[
      { formatVersion: 2 }, { formatVersion: 0 }, { formatVersion: '1' },
      { worldId: 'world-b' }, { timelineId: 'fork' }, { presentation: 'voxel3d' },
      { savedAt: null }, { savedAt: '123' }, { camera: { ...native(), version: 2 } },
      { camera: voxel() },
    ].map(overrides => [JSON.stringify(overrides), JSON.stringify(cameraRecord(native(), overrides))]),
    ['infinite timestamp', JSON.stringify(cameraRecord()).replace('"savedAt":123', '"savedAt":1e400')],
    ['infinite zoom', JSON.stringify(cameraRecord()).replace('"zoom":1.25', '"zoom":1e400')],
  ])('rejects invalid/mismatched camera records and retains bytes: %s', (_name, raw) => {
    const storage = new MemoryStorage()
    const key = cameraStorageKey(target)
    storage.setItem(key, raw)
    expect(createPresentationStateStore(storage).getCamera(target)).toBeNull()
    expect(storage.getItem(key)).toBe(raw)
  })

  const invalidSnapshots: [string, unknown][] = [
    ['zero zoom', native({ zoom: 0 })], ['negative zoom', native({ zoom: -1 })],
    ['NaN zoom', native({ zoom: NaN })], ['infinite zoom', native({ zoom: Infinity })],
    ['nonfinite pan x', native({ pan: { x: Infinity, y: 0 } })],
    ['nonfinite pan y', native({ pan: { x: 0, y: NaN } })],
    ['missing pan', { kind: 'native2d', version: 1, camera: { zoom: 1 } }],
    ['string zoom', { kind: 'native2d', version: 1, camera: { pan: camera.pan, zoom: '1' } }],
    ['zero distance', voxel({ distance: 0 })], ['negative distance', voxel({ distance: -1 })],
    ['infinite distance', voxel({ distance: Infinity })],
    ['NaN theta', voxel({ theta: NaN })], ['infinite phi', voxel({ phi: -Infinity })],
    ['nonfinite target x', voxel({ target: { x: NaN, y: 0, z: 0 } })],
    ['nonfinite target y', voxel({ target: { x: 0, y: Infinity, z: 0 } })],
    ['nonfinite target z', voxel({ target: { x: 0, y: 0, z: -Infinity } })],
    ['missing target', { kind: 'voxel3d', version: 1, pose: { theta: 0, phi: 1, distance: 1 } }],
    ['future snapshot', { ...native(), version: 2 }], ['unknown kind', { kind: '2d', version: 1 }],
  ]
  it.each(invalidSnapshots)('rejects %s on both reads and writes', (_name, snapshot) => {
    const storage = new MemoryStorage()
    const store = createPresentationStateStore(storage)
    const scope = { ...target, presentation: (snapshot as CameraSnapshot).kind === 'voxel3d'
      ? 'voxel3d' as const : 'native2d' as const }
    const key = cameraStorageKey(scope)
    const raw = JSON.stringify(cameraRecord(snapshot, scope))
    storage.setItem(key, raw)
    expect(store.getCamera(scope)).toBeNull()
    store.setCamera(scope, snapshot as CameraSnapshot)
    expect(storage.getItem(key)).toBe(raw)
  })

  it('refuses mismatched snapshot writes without overwriting the saved camera', () => {
    const storage = new MemoryStorage()
    const store = createPresentationStateStore(storage)
    store.setCamera(target, native())
    store.setCamera(target, voxel())
    expect(store.getCamera(target)).toEqual(native())
  })

  it('contains getItem and setItem exceptions, including quota failures', () => {
    const store = createPresentationStateStore({
      getItem() { throw new Error('blocked') },
      setItem() { throw new Error('quota') },
    })
    expect(store.getPreferred()).toBeNull()
    expect(store.getCamera(target)).toBeNull()
    expect(() => store.setPreferred('native2d')).not.toThrow()
    expect(() => store.setCamera(target, native())).not.toThrow()
  })

  it('contains a throwing localStorage getter and resolves storage lazily', () => {
    const getStorage = vi.fn(() => { throw new Error('SecurityError') })
    vi.stubGlobal('window', Object.defineProperty({}, 'localStorage', { get: getStorage }))
    const store = createPresentationStateStore()
    expect(getStorage).not.toHaveBeenCalled()
    expect(store.getPreferred()).toBeNull()
    expect(store.getCamera(target)).toBeNull()
    expect(() => store.setPreferred('voxel3d')).not.toThrow()
    expect(() => store.setCamera(target, native())).not.toThrow()
    expect(getStorage).toHaveBeenCalledTimes(4)
  })

  it('uses the available browser storage by default', () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('window', { localStorage: storage })
    createPresentationStateStore().setPreferred('native2d')
    expect(createPresentationStateStore().getPreferred()).toBe('native2d')
  })

  it('supports SSR and explicit null storage without accessing the browser', () => {
    vi.stubGlobal('window', undefined)
    for (const store of [createPresentationStateStore(), createPresentationStateStore(null)]) {
      expect(store.getPreferred()).toBeNull()
      expect(store.getCamera(target)).toBeNull()
      expect(() => store.setPreferred('native2d')).not.toThrow()
      expect(() => store.setCamera(target, native())).not.toThrow()
    }
    const getStorage = vi.fn(() => { throw new Error('must not access') })
    vi.stubGlobal('window', Object.defineProperty({}, 'localStorage', { get: getStorage }))
    createPresentationStateStore(null).getPreferred()
    expect(getStorage).not.toHaveBeenCalled()
  })
})
