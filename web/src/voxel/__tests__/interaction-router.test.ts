import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { applyEdits, createEmptyWorld, type VoxelCoord, type VoxelDocument } from '@possibility/voxel-contract'
import { Picker, WorldModel, type VoxelEngine } from '../engine'
import { InteractionRouter, type InteractionHandlers } from '../bridge/interaction-router'

const fakeCanvas = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
} as HTMLCanvasElement

function aimCamera(cell: VoxelCoord): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(35, 800 / 600, 0.1, 2000)
  camera.position.set(cell.x + 0.5, cell.y + 12, cell.z + 18)
  camera.lookAt(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5)
  camera.updateMatrixWorld(true)
  return camera
}

function buildDoc(): VoxelDocument {
  const base = createEmptyWorld({ width: 32, height: 16, depth: 32 }, 'mist-manor', 'w')
  const edited = applyEdits(base, [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 31, y: 0, z: 31 }, block: 'stone' },
    { kind: 'place-object', objectType: 'stone-lantern', anchor: { x: 4, y: 1, z: 4 }, rotation: 0, objectId: 'obj-loc' },
    { kind: 'place-object', objectType: 'bench', anchor: { x: 10, y: 1, z: 4 }, rotation: 0, objectId: 'obj-person' },
    { kind: 'place-object', objectType: 'bench', anchor: { x: 16, y: 1, z: 4 }, rotation: 0, objectId: 'obj-plain' },
    { kind: 'fill', from: { x: 24, y: 1, z: 24 }, to: { x: 24, y: 1, z: 24 }, block: 'wood-plank' },
  ]).document
  return {
    ...edited,
    objects: edited.objects.map((o) =>
      o.id === 'obj-person' ? { ...o, binding: { kind: 'person' as const, personId: 'p-9' } } : o),
    // 地点绑定走文档 locations 表（与 fixture / 产品数据结构一致）
    locations: [{ name: '主楼', objectId: 'obj-loc' }],
    spaceEntries: [{ spaceId: 'main-hall', label: '进入主楼 →', at: { x: 24, y: 1, z: 24 } }],
  }
}

const doc = buildDoc()
const world = new WorldModel(doc)

function makeEngine(camera: THREE.Camera, personPick: string | null = null): VoxelEngine {
  return {
    renderer: { canvas: fakeCanvas },
    world,
    picker: new Picker(world),
    residents: { pick: () => personPick },
    cameraRig: { camera },
  } as unknown as VoxelEngine
}

function makeHandlers() {
  return {
    onPerson: vi.fn(), onLocation: vi.fn(), onObjectPerson: vi.fn(),
    onObject: vi.fn(), onEnterSpace: vi.fn(),
  } satisfies InteractionHandlers
}

const CENTER = [400, 300] as const

describe('InteractionRouter', () => {
  it('点击居民 → onPerson，且优先于体素命中', () => {
    const handlers = makeHandlers()
    const router = new InteractionRouter(makeEngine(aimCamera({ x: 16, y: 1, z: 4 }), 'p-1'), handlers)
    expect(router.handleClick(...CENTER)).toBe(true)
    expect(handlers.onPerson).toHaveBeenCalledWith('p-1')
    expect(handlers.onObject).not.toHaveBeenCalled()
  })

  it('点击绑定地点的物体 → onLocation（AC16 地点详情）', () => {
    const handlers = makeHandlers()
    const router = new InteractionRouter(makeEngine(aimCamera({ x: 4, y: 2, z: 4 })), handlers)
    expect(router.handleClick(...CENTER)).toBe(true)
    expect(handlers.onLocation).toHaveBeenCalledWith('obj-loc', '主楼')
  })

  it('物体自带 location binding 同样生效', () => {
    const handlers = makeHandlers()
    const ownBinding: VoxelDocument = {
      ...doc,
      objects: doc.objects.map((o) => o.id === 'obj-plain' ? { ...o, binding: { kind: 'location' as const, locationName: '门廊' } } : o),
    }
    const ownWorld = new WorldModel(ownBinding)
    const engine = {
      renderer: { canvas: fakeCanvas }, world: ownWorld, picker: new Picker(ownWorld),
      residents: { pick: () => null }, cameraRig: { camera: aimCamera({ x: 16, y: 1, z: 4 }) },
    } as unknown as VoxelEngine
    expect(new InteractionRouter(engine, handlers).handleClick(...CENTER)).toBe(true)
    expect(handlers.onLocation).toHaveBeenCalledWith('obj-plain', '门廊')
  })

  it('点击绑定人物的物体 → onObjectPerson', () => {
    const handlers = makeHandlers()
    const router = new InteractionRouter(makeEngine(aimCamera({ x: 10, y: 1, z: 4 })), handlers)
    expect(router.handleClick(...CENTER)).toBe(true)
    expect(handlers.onObjectPerson).toHaveBeenCalledWith('obj-person', 'p-9')
  })

  it('点击普通物体 → onObject', () => {
    const handlers = makeHandlers()
    const router = new InteractionRouter(makeEngine(aimCamera({ x: 16, y: 1, z: 4 })), handlers)
    expect(router.handleClick(...CENTER)).toBe(true)
    expect(handlers.onObject).toHaveBeenCalledWith('obj-plain')
  })

  it('点击空间入口 → onEnterSpace（AC9 外景↔主楼切换）', () => {
    const handlers = makeHandlers()
    const router = new InteractionRouter(makeEngine(aimCamera({ x: 24, y: 1, z: 24 })), handlers)
    expect(router.handleClick(...CENTER)).toBe(true)
    expect(handlers.onEnterSpace).toHaveBeenCalledWith('main-hall')
    expect(handlers.onObject).not.toHaveBeenCalled()
  })

  it('点击空地 → 不消费', () => {
    const handlers = makeHandlers()
    const router = new InteractionRouter(makeEngine(aimCamera({ x: 28, y: 0, z: 28 })), handlers)
    expect(router.handleClick(...CENTER)).toBe(false)
    expect(handlers.onObject).not.toHaveBeenCalled()
  })

  it('未挂载画布 / 无世界 → 不消费', () => {
    const handlers = makeHandlers()
    const bare = { renderer: { canvas: null }, world: null, picker: null, residents: null, cameraRig: { camera: aimCamera({ x: 0, y: 0, z: 0 }) } } as unknown as VoxelEngine
    expect(new InteractionRouter(bare, handlers).handleClick(...CENTER)).toBe(false)
  })
})
