import { describe, expect, it } from 'vitest'
import type {
  AssetDefinition,
  GridPoint,
  LayoutState,
  MoveReason,
  SceneDefinition,
} from '../types'
import { FIXTURE_SCOPE, PUBLIC_DEMO_SCOPE } from '../fixtures'
import { MIST_MANOR_SCENE } from '../scene'
import {
  createInitialLayout,
  validateBuildingMove,
  validateLayout,
} from '../layout-validation'

const scene = MIST_MANOR_SCENE

function key(p: GridPoint): string {
  return `${p.x},${p.z}`
}

function reasonCodes(reasons: readonly MoveReason[]): string[] {
  return reasons.map((r) => r.code)
}

function conflictKeys(cells: readonly GridPoint[]): Set<string> {
  return new Set(cells.map(key))
}

function baselineLayout(): LayoutState {
  return createInitialLayout(scene, FIXTURE_SCOPE)
}

/** 可变布局变体：供测试构造非法布局（生产类型全只读）。 */
interface MutableLayout {
  scope: LayoutState['scope']
  placements: { buildingId: string; spaceId: string; origin: GridPoint }[]
}

/** 深拷贝布局，供构造非法变体（测试专用）。 */
function cloneLayout(layout: LayoutState): MutableLayout {
  return JSON.parse(JSON.stringify(layout)) as MutableLayout
}

/* -------------------------------------------------------------------------- */
/* T11：布局结构与占地校验                                                      */
/* -------------------------------------------------------------------------- */

describe('T11 createInitialLayout', () => {
  it('按建筑定义生成完整初始布局，且与场景不共享可变的 placement/origin 引用', () => {
    const layout = baselineLayout()
    expect(layout.scope).toEqual(FIXTURE_SCOPE)
    expect(layout.placements).toHaveLength(scene.buildings.length)
    for (const building of scene.buildings) {
      const placement = layout.placements.find((p) => p.buildingId === building.id)
      expect(placement).toBeDefined()
      expect(placement?.spaceId).toBe(building.spaceId)
      expect(placement?.origin).toEqual(building.initialOrigin)
      expect(placement?.origin).not.toBe(building.initialOrigin)
    }
  })

  it('支持第二组确定 scope（来源隔离）', () => {
    const layout = createInitialLayout(scene, PUBLIC_DEMO_SCOPE)
    expect(layout.scope).toEqual(PUBLIC_DEMO_SCOPE)
    expect(validateLayout(scene, layout).valid).toBe(true)
  })
})

describe('T11 validateLayout 合法基线', () => {
  it('初始布局完整通过：valid 且无原因', () => {
    const result = validateLayout(scene, baselineLayout())
    expect(result.valid).toBe(true)
    expect(result.reasons).toEqual([])
    expect(result.conflictCells).toEqual([])
  })
})

describe('T11 validateLayout 结构错误', () => {
  it('缺失建筑被阻止（missing_building）', () => {
    const layout = cloneLayout(baselineLayout())
    layout.placements.splice(
      layout.placements.findIndex((p) => p.buildingId === 'gatehouse'),
      1,
    )
    const result = validateLayout(scene, layout)
    expect(result.valid).toBe(false)
    const missing = result.reasons.find((r) => r.code === 'missing_building')
    expect(missing?.buildingId).toBe('gatehouse')
  })

  it('重复建筑被阻止（missing_building）', () => {
    const layout = cloneLayout(baselineLayout())
    layout.placements.push({ ...layout.placements[0], origin: { x: 12, z: 12 } })
    const result = validateLayout(scene, layout)
    expect(result.valid).toBe(false)
    const dup = result.reasons.find(
      (r) => r.code === 'missing_building' && r.buildingId === layout.placements[0].buildingId,
    )
    expect(dup).toBeDefined()
  })

  it('多余未知建筑被阻止（missing_building）', () => {
    const layout = cloneLayout(baselineLayout())
    layout.placements.push({ buildingId: 'ghost-house', spaceId: 'exterior-grounds', origin: { x: 0, z: 0 } })
    const result = validateLayout(scene, layout)
    expect(result.valid).toBe(false)
    const extra = result.reasons.find(
      (r) => r.code === 'missing_building' && r.buildingId === 'ghost-house',
    )
    expect(extra).toBeDefined()
  })

  it('spaceId 与建筑定义不一致被阻止（missing_building）', () => {
    const layout = cloneLayout(baselineLayout())
    const target = layout.placements.find((p) => p.buildingId === 'main-house')
    if (!target) throw new Error('基线缺少 main-house')
    target.spaceId = 'main-hall'
    const result = validateLayout(scene, layout)
    expect(result.valid).toBe(false)
    const mismatch = result.reasons.find(
      (r) => r.code === 'missing_building' && r.buildingId === 'main-house',
    )
    expect(mismatch?.message).toContain('main-hall')
  })

  it('原点 NaN 被阻止（invalid_asset）', () => {
    const layout = cloneLayout(baselineLayout())
    const target = layout.placements.find((p) => p.buildingId === 'greenhouse')
    if (!target) throw new Error('基线缺少 greenhouse')
    target.origin = { x: Number.NaN, z: 2 }
    const result = validateLayout(scene, layout)
    expect(result.valid).toBe(false)
    const invalid = result.reasons.find(
      (r) => r.code === 'invalid_asset' && r.buildingId === 'greenhouse',
    )
    expect(invalid).toBeDefined()
  })
})

describe('T11 validateBuildingMove 结构与占地', () => {
  it('越界（正方向）被阻止（out_of_bounds）', () => {
    // main-house 占地 4×3：x=13 时最右格 x=16 超出 16 宽外景。
    const result = validateBuildingMove(scene, baselineLayout(), 'main-house', { x: 13, z: 12 })
    expect(result.valid).toBe(false)
    expect(reasonCodes(result.reasons)).toContain('out_of_bounds')
  })

  it('越界（负坐标）被阻止（out_of_bounds）', () => {
    const result = validateBuildingMove(scene, baselineLayout(), 'gatehouse', { x: -1, z: 0 })
    expect(result.valid).toBe(false)
    expect(reasonCodes(result.reasons)).toContain('out_of_bounds')
  })

  it('移动目标 NaN 被阻止（invalid_asset）', () => {
    const result = validateBuildingMove(scene, baselineLayout(), 'greenhouse', {
      x: Number.NaN,
      z: 4,
    })
    expect(result.valid).toBe(false)
    expect(reasonCodes(result.reasons)).toEqual(['invalid_asset'])
    expect(result.reasons[0].buildingId).toBe('greenhouse')
  })

  it('移动未知建筑被阻止（missing_building）', () => {
    const result = validateBuildingMove(scene, baselineLayout(), 'ghost-house', { x: 1, z: 1 })
    expect(result.valid).toBe(false)
    expect(reasonCodes(result.reasons)).toEqual(['missing_building'])
    expect(result.reasons[0].buildingId).toBe('ghost-house')
  })

  it('与其他建筑占地交叠被阻止（collision）', () => {
    // greenhouse 移到 main-house 初始位置（3,2），两者占地必然重叠。
    const result = validateBuildingMove(scene, baselineLayout(), 'greenhouse', { x: 3, z: 2 })
    expect(result.valid).toBe(false)
    const collision = result.reasons.find((r) => r.code === 'collision')
    expect(collision?.buildingId).toBe('greenhouse')
    expect(conflictKeys(collision?.cells ?? [])).toContain('3,2')
  })

  it('与静态阻挡物件交叠被阻止（collision，cells 列出冲突格）', () => {
    // gatehouse 移到 (8,4)：覆盖 x=8 树墙的 (8,4) 与 (8,5)。
    const result = validateBuildingMove(scene, baselineLayout(), 'gatehouse', { x: 8, z: 4 })
    expect(result.valid).toBe(false)
    const collision = result.reasons.find((r) => r.code === 'collision')
    expect(collision?.buildingId).toBe('gatehouse')
    const cells = conflictKeys(collision?.cells ?? [])
    expect(cells).toContain('8,4')
    expect(cells).toContain('8,5')
  })

  it('落在湖塘等不可放置地面被阻止（collision）', () => {
    // gatehouse 移到 (10,10)：四格全部位于湖塘（不在 walkableCells 内）。
    const result = validateBuildingMove(scene, baselineLayout(), 'gatehouse', { x: 10, z: 10 })
    expect(result.valid).toBe(false)
    const collision = result.reasons.find((r) => r.code === 'collision')
    expect(collision?.buildingId).toBe('gatehouse')
    expect(conflictKeys(collision?.cells ?? [])).toContain('10,10')
  })

  it('覆盖固定地点锚点/站位被阻止（collision，cells 含锚点）', () => {
    // gatehouse 移到 (13,12)：覆盖后山散步道锚点 (14,12) 与站位 (13,12)/(14,13)。
    const result = validateBuildingMove(scene, baselineLayout(), 'gatehouse', { x: 13, z: 12 })
    expect(result.valid).toBe(false)
    const collision = result.reasons.find((r) => r.code === 'collision')
    expect(collision?.buildingId).toBe('gatehouse')
    const cells = conflictKeys(collision?.cells ?? [])
    expect(cells).toContain('14,12')
    expect(conflictKeys(result.conflictCells)).toContain('14,12')
  })

  it('输入布局不被修改（纯函数）', () => {
    const layout = baselineLayout()
    const before = JSON.stringify(layout)
    validateBuildingMove(scene, layout, 'gatehouse', { x: 8, z: 4 })
    validateBuildingMove(scene, layout, 'main-house', { x: Number.NaN, z: 0 })
    validateLayout(scene, layout)
    expect(JSON.stringify(layout)).toBe(before)
  })
})

/* -------------------------------------------------------------------------- */
/* T12：入口与通路连通                                                          */
/* -------------------------------------------------------------------------- */

describe('T12 外景连通校验（真实雾影庄）', () => {
  it('移动导致其他建筑入口被占地覆盖失败（entrance_blocked）', () => {
    // gatehouse 移到 (4,4)：占地 (4,4)(5,4)(4,5)(5,5) 覆盖 main-house 入口 (5,5)。
    const result = validateBuildingMove(scene, baselineLayout(), 'gatehouse', { x: 4, z: 4 })
    expect(result.valid).toBe(false)
    const blocked = result.reasons.find((r) => r.code === 'entrance_blocked')
    expect(blocked?.buildingId).toBe('main-house')
    expect(conflictKeys(blocked?.cells ?? [])).toContain('5,5')
  })

  it('连通起点被建筑占地覆盖失败（entrance_blocked）', () => {
    // main-house 移到 (7,6)：4×3 占地 x7-10/z6-8 覆盖 connectivityRoot (8,7)。
    const result = validateBuildingMove(scene, baselineLayout(), 'main-house', { x: 7, z: 6 })
    expect(result.valid).toBe(false)
    const blocked = result.reasons.find((r) => r.code === 'entrance_blocked')
    expect(blocked).toBeDefined()
    expect(conflictKeys(blocked?.cells ?? [])).toContain('8,7')
  })

  it('绕行仍连通的合法移动通过', () => {
    // gatehouse 从 (3,10) 移到 (0,9)：入口 (1,11) 经 (0,11)/(2,11) 绕行仍可达，
    // 主街、横路与其余入口、后山锚点全部保持连通。
    const result = validateBuildingMove(scene, baselineLayout(), 'gatehouse', { x: 0, z: 9 })
    expect(result.reasons).toEqual([])
    expect(result.valid).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* T12：合成窄廊场景——断路（disconnected）与隔断后山通路                        */
/* -------------------------------------------------------------------------- */

function makeAsset(id: string, footprint: readonly GridPoint[]): AssetDefinition {
  return {
    id,
    layers: [
      {
        id: `${id}-base`,
        url: `/test/${id}.png`,
        pixelWidth: 64,
        pixelHeight: 32,
        anchorPx: { x: 0, y: 0 },
        role: 'base',
        sortOffset: 0,
        visibleAt: ['day'],
      },
    ],
    footprint,
    sortAnchor: { x: 0, z: 0 },
    hitPolygon: [],
  }
}

/**
 * 3×6 窄廊：rock 静态阻挡 (2,3)；wall-b（2×1）初始 (0,1)，入口 (0,0)；
 * hut-b（1×1）初始 (0,5)，入口 (0,4)；meadow 地点锚点 (1,5)、站位 (2,5)。
 * 初始布局经 (1,3)→(1,4) 绕行全部连通；wall-b 移到 (0,2) 后，
 * 南侧仅剩的 (2,2)→(2,3) 通道被 rock 封死，hut 入口与 meadow 全部断路。
 */
function createCorridorScene(): SceneDefinition {
  const walkableCells: GridPoint[] = []
  for (let x = 0; x < 3; x += 1) {
    for (let z = 0; z < 6; z += 1) {
      walkableCells.push({ x, z })
    }
  }
  return {
    id: 'corridor-scene',
    version: 1,
    defaultSpaceId: 'yard',
    spaces: [
      {
        id: 'yard',
        kind: 'exterior',
        bounds: { width: 3, depth: 6 },
        walkableCells,
        staticObjects: [{ id: 'rock-1', assetId: 'rock', origin: { x: 2, z: 3 }, blocksMovement: true }],
        overview: { focus: { x: 1, z: 3 }, paddingPx: 32, maxZoom: 2 },
        connectivityRoot: { x: 1, z: 0 },
      },
    ],
    buildings: [
      {
        id: 'wall-b',
        assetId: 'wall',
        spaceId: 'yard',
        initialOrigin: { x: 0, z: 1 },
        entryOffset: { x: 0, z: -1 },
        locationKeys: [],
        interiorSpaceId: null,
      },
      {
        id: 'hut-b',
        assetId: 'hut',
        spaceId: 'yard',
        initialOrigin: { x: 0, z: 5 },
        entryOffset: { x: 0, z: -1 },
        locationKeys: [],
        interiorSpaceId: null,
      },
    ],
    locationBindings: [
      {
        locationKey: 'meadow',
        sourceLocationName: '后山散步道',
        representation: {
          kind: 'outdoor',
          spaceId: 'yard',
          anchor: { x: 1, z: 5 },
          residentSlots: [{ x: 2, z: 5 }],
        },
      },
    ],
    assetManifest: {
      wall: makeAsset('wall', [
        { x: 0, z: 0 },
        { x: 1, z: 0 },
      ]),
      hut: makeAsset('hut', [{ x: 0, z: 0 }]),
      rock: makeAsset('rock', [{ x: 0, z: 0 }]),
    },
  }
}

describe('T12 合成窄廊断路', () => {
  it('初始布局绕行连通（合法基线）', () => {
    const corridor = createCorridorScene()
    const layout = createInitialLayout(corridor, FIXTURE_SCOPE)
    const result = validateLayout(corridor, layout)
    expect(result.reasons).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('移动导致其他建筑入口断路失败（disconnected）', () => {
    const corridor = createCorridorScene()
    const layout = createInitialLayout(corridor, FIXTURE_SCOPE)
    const result = validateBuildingMove(corridor, layout, 'wall-b', { x: 0, z: 2 })
    expect(result.valid).toBe(false)
    const disconnected = result.reasons.find(
      (r) => r.code === 'disconnected' && r.buildingId === 'hut-b',
    )
    expect(disconnected).toBeDefined()
    expect(conflictKeys(disconnected?.cells ?? [])).toContain('0,4')
    // 入口本身并未被覆盖：不应误报 entrance_blocked。
    expect(
      result.reasons.some((r) => r.code === 'entrance_blocked' && r.buildingId === 'hut-b'),
    ).toBe(false)
  })

  it('隔断后山散步道通路失败（disconnected，锚点与站位不可达）', () => {
    const corridor = createCorridorScene()
    const layout = createInitialLayout(corridor, FIXTURE_SCOPE)
    const result = validateBuildingMove(corridor, layout, 'wall-b', { x: 0, z: 2 })
    expect(result.valid).toBe(false)
    const cells = conflictKeys(
      result.reasons
        .filter((r) => r.code === 'disconnected' && r.buildingId === null)
        .flatMap((r) => r.cells),
    )
    expect(cells).toContain('1,5')
    expect(cells).toContain('2,5')
  })

  it('validateLayout 对完整候选布局报告同样的断路原因（恢复共用同一校验）', () => {
    const corridor = createCorridorScene()
    const layout = cloneLayout(createInitialLayout(corridor, FIXTURE_SCOPE))
    const wall = layout.placements.find((p) => p.buildingId === 'wall-b')
    if (!wall) throw new Error('基线缺少 wall-b')
    wall.origin = { x: 0, z: 2 }
    const result = validateLayout(corridor, layout)
    expect(result.valid).toBe(false)
    expect(reasonCodes(result.reasons)).toContain('disconnected')
    expect(conflictKeys(result.conflictCells)).toContain('0,4')
  })
})
