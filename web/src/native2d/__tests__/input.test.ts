import { describe, expect, it } from 'vitest'
import type { Camera } from '../projection'
import {
  CLICK_MOVE_THRESHOLD_PX,
  CLICK_TIME_LIMIT_MS,
  PointerInputMachine,
  pointInPolygon,
  resolvePick,
  type PickTarget,
  type PointerInputHandlers,
  type PointerSample,
} from '../input'
import type { AssetDefinition, Selection, ViewportEvent } from '../types'

/** 测试素材：以脚点为中心的 64×32 方形点击区。 */
const TEST_ASSET: AssetDefinition = {
  id: 'test-asset',
  layers: [],
  footprint: [],
  sortAnchor: { x: 0, z: 0 },
  hitPolygon: [
    { x: -32, y: -16 },
    { x: 32, y: -16 },
    { x: 32, y: 16 },
    { x: -32, y: 16 },
  ],
}

/** 深度更靠前的测试素材（sortAnchor 更深）。 */
const FRONT_ASSET: AssetDefinition = { ...TEST_ASSET, id: 'front-asset', sortAnchor: { x: 1, z: 1 } }

const IDENTITY: Camera = { pan: { x: 0, y: 0 }, zoom: 1 }

function sample(pointerId: number, x: number, y: number, timeStamp: number): PointerSample {
  return { pointerId, x, y, timeStamp }
}

interface Harness {
  machine: PointerInputMachine
  events: ViewportEvent[]
  pans: { x: number; y: number }[]
  zooms: { factor: number; center: { x: number; y: number } }[]
  setCamera(camera: Camera): void
  setMoveMode(value: boolean): void
  setTargets(targets: readonly PickTarget[]): void
}

function createHarness(): Harness {
  let camera: Camera = IDENTITY
  let moveMode = false
  let targets: readonly PickTarget[] = []
  const events: ViewportEvent[] = []
  const pans: { x: number; y: number }[] = []
  const zooms: { factor: number; center: { x: number; y: number } }[] = []
  const assets: Readonly<Record<string, AssetDefinition>> = {
    'test-asset': TEST_ASSET,
    'front-asset': FRONT_ASSET,
  }
  const handlers: PointerInputHandlers = {
    getCamera: () => camera,
    getPickTargets: () => targets,
    getAssetDefinition: (assetId) => assets[assetId] ?? null,
    isMoveMode: () => moveMode,
    getMoveBuildingId: () => (moveMode ? 'building-1' : null),
    onEvent: (event) => events.push(event),
    onPan: (delta) => pans.push(delta),
    onZoom: (factor, center) => zooms.push({ factor, center }),
  }
  return {
    machine: new PointerInputMachine(handlers),
    events,
    pans,
    zooms,
    setCamera: (value) => {
      camera = value
    },
    setMoveMode: (value) => {
      moveMode = value
    },
    setTargets: (value) => {
      targets = value
    },
  }
}

const BUILDING_SELECTION: Selection = { kind: 'building', buildingId: 'building-1' }
const LOCATION_SELECTION: Selection = { kind: 'location', locationKey: 'hall' }

describe('pointInPolygon', () => {
  const square = [
    { x: -10, y: -10 },
    { x: 10, y: -10 },
    { x: 10, y: 10 },
    { x: -10, y: 10 },
  ]

  it('命中内部点，拒绝外部点', () => {
    expect(pointInPolygon({ x: 0, y: 0 }, square)).toBe(true)
    expect(pointInPolygon({ x: -9, y: 9 }, square)).toBe(true)
    expect(pointInPolygon({ x: 11, y: 0 }, square)).toBe(false)
    expect(pointInPolygon({ x: 0, y: -11 }, square)).toBe(false)
  })

  it('凹多边形与三角形按射线法判定', () => {
    const triangle = [
      { x: 0, y: -10 },
      { x: 10, y: 10 },
      { x: -10, y: 10 },
    ]
    expect(pointInPolygon({ x: 0, y: 5 }, triangle)).toBe(true)
    expect(pointInPolygon({ x: -8, y: -5 }, triangle)).toBe(false)
  })

  it('顶点不足或非有限输入恒为 false', () => {
    expect(pointInPolygon({ x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(false)
    expect(pointInPolygon({ x: Number.NaN, y: 0 }, square)).toBe(false)
  })
})

describe('resolvePick', () => {
  const targetA: PickTarget = {
    id: 'a',
    selection: BUILDING_SELECTION,
    origin: { x: 0, z: 0 },
    assetId: 'test-asset',
  }
  const getAsset = (assetId: string): AssetDefinition | null =>
    assetId === 'test-asset' ? TEST_ASSET : assetId === 'front-asset' ? FRONT_ASSET : null

  it('屏幕点移除相机后命中对象 hitPolygon', () => {
    expect(resolvePick({ x: 5, y: 3 }, IDENTITY, [targetA], getAsset)).toEqual(BUILDING_SELECTION)
    expect(resolvePick({ x: 200, y: 200 }, IDENTITY, [targetA], getAsset)).toBeNull()
  })

  it('带平移缩放的相机下拾取一致', () => {
    const camera: Camera = { pan: { x: 100, y: 50 }, zoom: 2 }
    // 投影点 (10, 5) 经相机后为 (120, 60)。
    expect(resolvePick({ x: 120, y: 60 }, camera, [targetA], getAsset)).toEqual(BUILDING_SELECTION)
    expect(resolvePick({ x: 300, y: 60 }, camera, [targetA], getAsset)).toBeNull()
  })

  it('对象脚点投影点偏移后才作为局部原点', () => {
    const shifted: PickTarget = { ...targetA, origin: { x: 4, z: 0 } }
    // origin (4,0) 投影到 (128, 64)，点击其中心命中。
    expect(resolvePick({ x: 128, y: 64 }, IDENTITY, [shifted], getAsset)).toEqual(
      BUILDING_SELECTION,
    )
    expect(resolvePick({ x: 0, y: 0 }, IDENTITY, [shifted], getAsset)).toBeNull()
  })

  it('多对象重叠时按绘制深度取最前者', () => {
    const back: PickTarget = {
      id: 'back',
      selection: BUILDING_SELECTION,
      origin: { x: 0, z: 0 },
      assetId: 'test-asset',
    }
    const front: PickTarget = {
      id: 'front',
      selection: LOCATION_SELECTION,
      origin: { x: 0, z: 0 },
      assetId: 'front-asset',
    }
    expect(resolvePick({ x: 0, y: 0 }, IDENTITY, [back, front], getAsset)).toEqual(
      LOCATION_SELECTION,
    )
    // 顺序无关：深度决定胜负。
    expect(resolvePick({ x: 0, y: 0 }, IDENTITY, [front, back], getAsset)).toEqual(
      LOCATION_SELECTION,
    )
  })

  it('非有限输入返回 null', () => {
    expect(resolvePick({ x: Number.NaN, y: 0 }, IDENTITY, [targetA], getAsset)).toBeNull()
    const zeroZoom: Camera = { pan: { x: 0, y: 0 }, zoom: 0 }
    expect(resolvePick({ x: 5, y: 3 }, zeroZoom, [targetA], getAsset)).toBeNull()
  })
})

describe('T32 点击与拾取', () => {
  it('阈值内短按时长判为点击并发出 select', () => {
    const h = createHarness()
    h.setTargets([
      { id: 'a', selection: BUILDING_SELECTION, origin: { x: 0, z: 0 }, assetId: 'test-asset' },
    ])
    h.machine.pointerDown(sample(1, 5, 3, 100))
    h.machine.pointerMove(sample(1, 5 + CLICK_MOVE_THRESHOLD_PX, 3, 150))
    h.machine.pointerUp(sample(1, 5 + CLICK_MOVE_THRESHOLD_PX, 3, 200))
    expect(h.events).toEqual([{ type: 'select', selection: BUILDING_SELECTION }])
    expect(h.machine.getPhase()).toBe('idle')
  })

  it('点击空处发出 selection 为 null 的 select', () => {
    const h = createHarness()
    h.machine.pointerDown(sample(1, 400, 300, 0))
    h.machine.pointerUp(sample(1, 400, 300, 100))
    expect(h.events).toEqual([{ type: 'select', selection: null }])
  })

  it('超过时长上限的长按不触发选中', () => {
    const h = createHarness()
    h.setTargets([
      { id: 'a', selection: BUILDING_SELECTION, origin: { x: 0, z: 0 }, assetId: 'test-asset' },
    ])
    h.machine.pointerDown(sample(1, 5, 3, 100))
    h.machine.pointerUp(sample(1, 5, 3, 100 + CLICK_TIME_LIMIT_MS + 1))
    expect(h.events).toEqual([])
  })
})

describe('T32 普通模式拖图', () => {
  it('超过阈值转为拖动：发一次 free-pan 并按增量回调 onPan', () => {
    const h = createHarness()
    h.machine.pointerDown(sample(1, 100, 100, 0))
    h.machine.pointerMove(sample(1, 100 + CLICK_MOVE_THRESHOLD_PX + 1, 100, 10))
    h.machine.pointerMove(sample(1, 130, 120, 20))
    h.machine.pointerUp(sample(1, 130, 120, 30))
    expect(h.events).toEqual([{ type: 'free-pan' }])
    expect(h.pans).toEqual([
      { x: CLICK_MOVE_THRESHOLD_PX + 1, y: 0 },
      { x: 23, y: 20 },
    ])
    // 拖动结束不补发 select。
    expect(h.events.filter((e) => e.type === 'select')).toEqual([])
  })

  it('阈值内的移动保持 pending，不产生平移', () => {
    const h = createHarness()
    h.machine.pointerDown(sample(1, 100, 100, 0))
    h.machine.pointerMove(sample(1, 102, 101, 10))
    expect(h.machine.getPhase()).toBe('pending')
    expect(h.pans).toEqual([])
    h.machine.pointerUp(sample(1, 102, 101, 20))
    expect(h.events).toEqual([{ type: 'select', selection: null }])
  })
})

describe('T32 建筑移动模式拖动', () => {
  it('拖动发出吸附整数格的 move-target，不平移不选中', () => {
    const h = createHarness()
    h.setMoveMode(true)
    h.machine.pointerDown(sample(1, 0, 0, 0))
    // 屏幕 (64, 32) 逆投影恰为格子 (2, 0)。
    h.machine.pointerMove(sample(1, 64, 32, 10))
    h.machine.pointerUp(sample(1, 64, 32, 20))
    expect(h.events).toEqual([{ type: 'move-target', buildingId: 'building-1', target: { x: 2, z: 0 } }])
    expect(h.pans).toEqual([])
  })

  it('非有限被吸附拒绝时不发 move-target', () => {
    const h = createHarness()
    h.setMoveMode(true)
    h.setCamera({ pan: { x: 0, y: 0 }, zoom: 0 })
    h.machine.pointerDown(sample(1, 0, 0, 0))
    h.machine.pointerMove(sample(1, 50, 50, 10))
    h.machine.pointerUp(sample(1, 50, 50, 20))
    expect(h.events).toEqual([])
    expect(h.machine.getPhase()).toBe('idle')
  })

  it('移动模式下点击不发任何事件（不选中、不应用）', () => {
    const h = createHarness()
    h.setMoveMode(true)
    h.setTargets([
      { id: 'a', selection: BUILDING_SELECTION, origin: { x: 0, z: 0 }, assetId: 'test-asset' },
    ])
    h.machine.pointerDown(sample(1, 5, 3, 0))
    h.machine.pointerUp(sample(1, 5, 3, 100))
    expect(h.events).toEqual([])
  })
})

describe('T32 取消与清理', () => {
  it('pointercancel 清理状态，后续 up 不产出事件', () => {
    const h = createHarness()
    h.machine.pointerDown(sample(1, 10, 10, 0))
    h.machine.pointerCancel(sample(1, 10, 10, 10))
    expect(h.machine.getPhase()).toBe('idle')
    h.machine.pointerUp(sample(1, 10, 10, 20))
    expect(h.events).toEqual([])
    expect(h.pans).toEqual([])
  })

  it('非有限采样被忽略', () => {
    const h = createHarness()
    h.machine.pointerDown(sample(1, Number.NaN, 0, 0))
    expect(h.machine.getPhase()).toBe('idle')
  })
})

describe('T33 双指缩放与手势转换', () => {
  it('双指中心平移回调 onPan、距离比例回调 onZoom', () => {
    const h = createHarness()
    h.machine.pointerDown(sample(1, 100, 100, 0))
    h.machine.pointerDown(sample(2, 200, 100, 0))
    expect(h.machine.getPhase()).toBe('pinch')
    h.machine.pointerMove(sample(2, 250, 100, 10))
    // 中心 (150,100) → (175,100)，距离 100 → 150。
    expect(h.pans).toEqual([{ x: 25, y: 0 }])
    expect(h.zooms).toHaveLength(1)
    expect(h.zooms[0].factor).toBeCloseTo(1.5, 10)
    expect(h.zooms[0].center).toEqual({ x: 175, y: 100 })
  })

  it('单指已按下后再加一指：取消点击判定，双指期间不选中不应用', () => {
    const h = createHarness()
    h.setTargets([
      { id: 'a', selection: BUILDING_SELECTION, origin: { x: 0, z: 0 }, assetId: 'test-asset' },
    ])
    h.machine.pointerDown(sample(1, 5, 3, 0))
    h.machine.pointerDown(sample(2, 8, 3, 10))
    h.machine.pointerUp(sample(2, 8, 3, 20))
    h.machine.pointerUp(sample(1, 5, 3, 30))
    expect(h.events.filter((e) => e.type === 'select')).toEqual([])
    expect(h.events.filter((e) => e.type === 'move-target')).toEqual([])
  })

  it('双指中心累计平移超阈值补发一次 free-pan', () => {
    const h = createHarness()
    h.machine.pointerDown(sample(1, 0, 0, 0))
    h.machine.pointerDown(sample(2, 100, 0, 0))
    // 中心从 (50,0) 起算：第一次中心仅移 2px 不超阈值，第二次累计 8px 触发一次。
    h.machine.pointerMove(sample(1, 4, 0, 10))
    h.machine.pointerMove(sample(1, 16, 0, 20))
    h.machine.pointerMove(sample(1, 30, 0, 30))
    expect(h.events.filter((e) => e.type === 'free-pan')).toHaveLength(1)
  })

  it('双指变单指：重置为拖动而非点击，继续移动只平移不选中', () => {
    const h = createHarness()
    h.setTargets([
      { id: 'a', selection: BUILDING_SELECTION, origin: { x: 0, z: 0 }, assetId: 'test-asset' },
    ])
    h.machine.pointerDown(sample(1, 100, 100, 0))
    h.machine.pointerDown(sample(2, 200, 100, 0))
    h.machine.pointerUp(sample(2, 200, 100, 10))
    expect(h.machine.getPhase()).toBe('dragging')
    // 剩余指针从当前位置重新起算：无跳动，增量为本次移动量。
    h.machine.pointerMove(sample(1, 108, 104, 20))
    expect(h.pans).toEqual([{ x: 8, y: 4 }])
    h.machine.pointerUp(sample(1, 108, 104, 30))
    expect(h.events.filter((e) => e.type === 'select')).toEqual([])
  })

  it('pinch 中一指 cancel 同样降级为单指拖动', () => {
    const h = createHarness()
    h.machine.pointerDown(sample(1, 0, 0, 0))
    h.machine.pointerDown(sample(2, 100, 0, 0))
    h.machine.pointerCancel(sample(1, 0, 0, 10))
    expect(h.machine.getPhase()).toBe('dragging')
    expect(h.machine.hasPointer(1)).toBe(false)
    expect(h.machine.hasPointer(2)).toBe(true)
  })

  it('第三指被忽略，不进入状态机', () => {
    const h = createHarness()
    h.machine.pointerDown(sample(1, 0, 0, 0))
    h.machine.pointerDown(sample(2, 100, 0, 0))
    h.machine.pointerDown(sample(3, 50, 50, 0))
    expect(h.machine.getPhase()).toBe('pinch')
    expect(h.machine.hasPointer(3)).toBe(false)
    h.machine.pointerMove(sample(3, 999, 999, 10))
    expect(h.pans).toEqual([])
    expect(h.zooms).toEqual([])
  })

  it('编辑模式下双指手势同样不触发 move-target 或选中', () => {
    const h = createHarness()
    h.setMoveMode(true)
    h.machine.pointerDown(sample(1, 0, 0, 0))
    h.machine.pointerDown(sample(2, 100, 0, 0))
    h.machine.pointerMove(sample(2, 200, 0, 10))
    h.machine.pointerUp(sample(2, 200, 0, 20))
    h.machine.pointerUp(sample(1, 0, 0, 30))
    expect(h.events.filter((e) => e.type === 'move-target')).toEqual([])
    expect(h.events.filter((e) => e.type === 'select')).toEqual([])
  })
})
