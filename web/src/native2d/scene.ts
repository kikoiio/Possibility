/**
 * N2D1 T06：外景、大厅与地点绑定。
 *
 * 导出雾影庄 SceneDefinition（MIST_MANOR_SCENE 常量 + createMistManorScene 工厂）：
 * - 外景 exterior-grounds（16×14，含 connectivityRoot）与大厅 main-hall（6×5 内景）。
 * - 三栋建筑：main-house（interiorSpaceId 指向大厅）、greenhouse、gatehouse；
 *   entryOffset 采用 assets.ts 冻结的 BUILDING_ENTRY_OFFSETS。
 * - 外景道路网（path 视觉格）连接三个建筑入口与后山散步道锚点；树/灌木为固定阻挡，
 *   湖塘格子不在 walkableCells 内，shore 仅作装饰；包含装饰性额外植被。
 * - 地点绑定：大厅 interior / 书房·餐厅·图书室 unrepresented(主楼) /
 *   温室花房·门房小屋 unrepresented(各自建筑) / 后山散步道 outdoor。
 *
 * 场景身份与 fixtures.ts 对齐（id 'mist-manor'、version 1、sourceLocationName
 * 与 seed-demo 真实地点名一致），但本模块不导入 fixtures——只导入 ./types 类型
 * 与 ./assets 的冻结常量，不导入 PixiJS。
 */

import type {
  BuildingDefinition,
  GridPoint,
  LocationBinding,
  SceneDefinition,
  SpaceDefinition,
  StaticSceneObject,
} from './types'
import { ASSET_MANIFEST, BUILDING_ENTRY_OFFSETS, HALL_FLOOR_GRID } from './assets'

/** 场景身份（与 fixtures.ts 的 FIXTURE_SCENE_ID / FIXTURE_SCENE_VERSION 对齐）。 */
export const MIST_MANOR_SCENE_ID = 'mist-manor'
export const MIST_MANOR_SCENE_VERSION = 1

export const EXTERIOR_SPACE_ID = 'exterior-grounds'
export const HALL_SPACE_ID = 'main-hall'

/** 稳定英文地点键。 */
export const LOCATION_KEYS = {
  hall: 'hall',
  study: 'study',
  dining: 'dining',
  library: 'library',
  greenhouseRoom: 'greenhouse-room',
  gatehouseRoom: 'gatehouse-room',
  hillPath: 'hill-path',
} as const

/** 外景网格尺寸：16×14。 */
const EXTERIOR_BOUNDS = { width: 16, depth: 14 } as const

function cellKey(x: number, z: number): string {
  return `${x},${z}`
}

/**
 * 湖塘：外景中部偏东南的 2×3 水面，不属于基础可通行格子
 * （建筑不可放置其上，居民也不可站立），岸边以 shore 素材装饰。
 */
const POND_CELLS: readonly GridPoint[] = [
  { x: 10, z: 9 },
  { x: 11, z: 9 },
  { x: 10, z: 10 },
  { x: 11, z: 10 },
  { x: 10, z: 11 },
  { x: 11, z: 11 },
]

/** 外景基础可通行格子：全部界内格子减去湖塘。 */
function exteriorWalkableCells(): GridPoint[] {
  const pond = new Set(POND_CELLS.map((c) => cellKey(c.x, c.z)))
  const cells: GridPoint[] = []
  for (let x = 0; x < EXTERIOR_BOUNDS.width; x += 1) {
    for (let z = 0; z < EXTERIOR_BOUNDS.depth; z += 1) {
      if (!pond.has(cellKey(x, z))) {
        cells.push({ x, z })
      }
    }
  }
  return cells
}

/** 大厅基础可通行格子：hall-wall 外圈以内的 4×3 地面。 */
function hallWalkableCells(): GridPoint[] {
  const cells: GridPoint[] = []
  for (let x = 1; x < HALL_FLOOR_GRID.width - 1; x += 1) {
    for (let z = 1; z < HALL_FLOOR_GRID.depth - 1; z += 1) {
      cells.push({ x, z })
    }
  }
  return cells
}

/* -------------------------------------------------------------------------- */
/* 外景静态物件                                                                */
/* -------------------------------------------------------------------------- */

function tree(id: string, x: number, z: number): StaticSceneObject {
  return { id, assetId: 'tree', origin: { x, z }, blocksMovement: true }
}

function shrub(id: string, x: number, z: number, blocksMovement: boolean): StaticSceneObject {
  return { id, assetId: 'shrub', origin: { x, z }, blocksMovement }
}

function shore(id: string, x: number, z: number): StaticSceneObject {
  return { id, assetId: 'shore', origin: { x, z }, blocksMovement: false }
}

function path(id: string, x: number, z: number): StaticSceneObject {
  return { id, assetId: 'path', origin: { x, z }, blocksMovement: false }
}

/**
 * 外景静态物件：
 * - 树全部阻挡：边缘林带与主楼东侧 x=8 树墙（与主楼之间留出 x=7 窄路）；
 * - 灌木部分阻挡、部分纯装饰；湖塘 shore 为装饰（格子本身不可通行）；
 * - path 为非阻挡视觉格，标记道路网（连通三建筑入口与后山散步道锚点）。
 */
function exteriorStaticObjects(): StaticSceneObject[] {
  const objects: StaticSceneObject[] = []

  // 边缘林带（阻挡）。
  const edgeTrees: readonly GridPoint[] = [
    { x: 0, z: 0 },
    { x: 1, z: 0 },
    { x: 14, z: 0 },
    { x: 15, z: 0 },
    { x: 0, z: 1 },
    { x: 15, z: 1 },
    { x: 0, z: 7 },
    { x: 1, z: 7 },
    { x: 13, z: 7 },
    { x: 14, z: 7 },
    { x: 0, z: 8 },
    { x: 13, z: 8 },
    { x: 15, z: 10 },
    { x: 15, z: 11 },
    { x: 0, z: 12 },
    { x: 1, z: 12 },
    { x: 15, z: 12 },
  ]
  edgeTrees.forEach((c, i) => objects.push(tree(`tree-edge-${i + 1}`, c.x, c.z)))

  // 主楼东侧 x=8 树墙（阻挡）：与主楼（x 3–6）之间形成 x=7 一格窄路。
  const wallTrees: readonly GridPoint[] = [
    { x: 8, z: 2 },
    { x: 8, z: 3 },
    { x: 8, z: 4 },
    { x: 8, z: 5 },
  ]
  wallTrees.forEach((c, i) => objects.push(tree(`tree-wall-${i + 1}`, c.x, c.z)))

  // 灌木：shrub-block-* 阻挡，shrub-deco-* 纯装饰。
  objects.push(shrub('shrub-block-1', 2, 5, true))
  objects.push(shrub('shrub-block-2', 7, 9, true))
  objects.push(shrub('shrub-block-3', 13, 11, true))
  objects.push(shrub('shrub-deco-1', 1, 3, false))
  objects.push(shrub('shrub-deco-2', 6, 8, false))
  objects.push(shrub('shrub-deco-3', 12, 13, false))

  // 湖塘水岸（装饰，格子不在 walkableCells 内）。
  POND_CELLS.forEach((c, i) => objects.push(shore(`shore-pond-${i + 1}`, c.x, c.z)))

  // 道路网（非阻挡视觉格）：
  // 主楼入口 (5,5) 向南至 z=7 横路；横路 z=7 自 x=5 到温室入口 x=12；
  // 主街 x=8 自 z=7 到 z=12 横路；z=12 横路自门房入口 (4,12) 到后山锚点 (14,12)。
  const roadCells: readonly GridPoint[] = [
    { x: 5, z: 5 },
    { x: 5, z: 6 },
    { x: 5, z: 7 },
    { x: 6, z: 7 },
    { x: 7, z: 7 },
    { x: 8, z: 7 },
    { x: 9, z: 7 },
    { x: 10, z: 7 },
    { x: 11, z: 7 },
    { x: 12, z: 7 },
    { x: 12, z: 4 },
    { x: 12, z: 5 },
    { x: 12, z: 6 },
    { x: 8, z: 8 },
    { x: 8, z: 9 },
    { x: 8, z: 10 },
    { x: 8, z: 11 },
    { x: 8, z: 12 },
    { x: 4, z: 12 },
    { x: 5, z: 12 },
    { x: 6, z: 12 },
    { x: 7, z: 12 },
    { x: 9, z: 12 },
    { x: 10, z: 12 },
    { x: 11, z: 12 },
    { x: 12, z: 12 },
    { x: 13, z: 12 },
    { x: 14, z: 12 },
  ]
  roadCells.forEach((c, i) => objects.push(path(`path-road-${i + 1}`, c.x, c.z)))

  return objects
}

/* -------------------------------------------------------------------------- */
/* 大厅静态物件                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 大厅静态物件：hall-floor 地平面（非阻挡）+ hall-wall 外圈墙体（阻挡）
 * + 桌/椅/灯家具（阻挡）。内部地面留出入口与足够居民站位，不烘焙人物。
 */
function hallStaticObjects(): StaticSceneObject[] {
  return [
    { id: 'hall-floor', assetId: 'hall-floor', origin: { x: 0, z: 0 }, blocksMovement: false },
    { id: 'hall-wall', assetId: 'hall-wall', origin: { x: 0, z: 0 }, blocksMovement: true },
    { id: 'hall-table-1', assetId: 'hall-table', origin: { x: 2, z: 2 }, blocksMovement: true },
    { id: 'hall-chair-1', assetId: 'hall-chair', origin: { x: 2, z: 1 }, blocksMovement: true },
    { id: 'hall-chair-2', assetId: 'hall-chair', origin: { x: 3, z: 3 }, blocksMovement: true },
    { id: 'hall-lamp-1', assetId: 'hall-lamp', origin: { x: 1, z: 1 }, blocksMovement: true },
  ]
}

/* -------------------------------------------------------------------------- */
/* 场景装配                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 构造一份全新的雾影庄场景定义。每次调用返回新对象与新数组，
 * 调用方（违规）修改不会污染 MIST_MANOR_SCENE 或后续构造结果。
 */
export function createMistManorScene(): SceneDefinition {
  const exterior: SpaceDefinition = {
    id: EXTERIOR_SPACE_ID,
    kind: 'exterior',
    bounds: { width: EXTERIOR_BOUNDS.width, depth: EXTERIOR_BOUNDS.depth },
    walkableCells: exteriorWalkableCells(),
    staticObjects: exteriorStaticObjects(),
    overview: { focus: { x: 8, z: 7 }, paddingPx: 96, maxZoom: 2 },
    // 主街与 z=7 横路交口：初始布局下可通行，连通全部入口与后山锚点。
    connectivityRoot: { x: 8, z: 7 },
  }

  const hall: SpaceDefinition = {
    id: HALL_SPACE_ID,
    kind: 'interior',
    bounds: { width: HALL_FLOOR_GRID.width, depth: HALL_FLOOR_GRID.depth },
    walkableCells: hallWalkableCells(),
    staticObjects: hallStaticObjects(),
    overview: { focus: { x: 3, z: 2 }, paddingPx: 64, maxZoom: 3 },
    connectivityRoot: null,
  }

  const mainHouse: BuildingDefinition = {
    id: 'main-house',
    assetId: 'main-house',
    spaceId: EXTERIOR_SPACE_ID,
    initialOrigin: { x: 3, z: 2 },
    entryOffset: BUILDING_ENTRY_OFFSETS['main-house'],
    locationKeys: [
      LOCATION_KEYS.hall,
      LOCATION_KEYS.study,
      LOCATION_KEYS.dining,
      LOCATION_KEYS.library,
    ],
    interiorSpaceId: HALL_SPACE_ID,
  }

  const greenhouse: BuildingDefinition = {
    id: 'greenhouse',
    assetId: 'greenhouse',
    spaceId: EXTERIOR_SPACE_ID,
    initialOrigin: { x: 11, z: 2 },
    entryOffset: BUILDING_ENTRY_OFFSETS.greenhouse,
    locationKeys: [LOCATION_KEYS.greenhouseRoom],
    interiorSpaceId: null,
  }

  const gatehouse: BuildingDefinition = {
    id: 'gatehouse',
    assetId: 'gatehouse',
    spaceId: EXTERIOR_SPACE_ID,
    initialOrigin: { x: 3, z: 10 },
    entryOffset: BUILDING_ENTRY_OFFSETS.gatehouse,
    locationKeys: [LOCATION_KEYS.gatehouseRoom],
    interiorSpaceId: null,
  }

  const locationBindings: LocationBinding[] = [
    {
      locationKey: LOCATION_KEYS.hall,
      sourceLocationName: '大厅',
      representation: {
        kind: 'interior',
        spaceId: HALL_SPACE_ID,
        entryBuildingId: mainHouse.id,
        anchor: { x: 3, z: 1 },
        residentSlots: [
          { x: 4, z: 1 },
          { x: 1, z: 2 },
          { x: 4, z: 2 },
          { x: 2, z: 3 },
        ],
      },
    },
    {
      locationKey: LOCATION_KEYS.study,
      sourceLocationName: '书房',
      representation: { kind: 'unrepresented', buildingId: mainHouse.id },
    },
    {
      locationKey: LOCATION_KEYS.dining,
      sourceLocationName: '餐厅',
      representation: { kind: 'unrepresented', buildingId: mainHouse.id },
    },
    {
      locationKey: LOCATION_KEYS.library,
      sourceLocationName: '图书室',
      representation: { kind: 'unrepresented', buildingId: mainHouse.id },
    },
    {
      locationKey: LOCATION_KEYS.greenhouseRoom,
      sourceLocationName: '温室花房',
      representation: { kind: 'unrepresented', buildingId: greenhouse.id },
    },
    {
      locationKey: LOCATION_KEYS.gatehouseRoom,
      sourceLocationName: '门房小屋',
      representation: { kind: 'unrepresented', buildingId: gatehouse.id },
    },
    {
      locationKey: LOCATION_KEYS.hillPath,
      sourceLocationName: '后山散步道',
      representation: {
        kind: 'outdoor',
        spaceId: EXTERIOR_SPACE_ID,
        anchor: { x: 14, z: 12 },
        residentSlots: [
          { x: 13, z: 12 },
          { x: 14, z: 13 },
        ],
      },
    },
  ]

  return {
    id: MIST_MANOR_SCENE_ID,
    version: MIST_MANOR_SCENE_VERSION,
    defaultSpaceId: EXTERIOR_SPACE_ID,
    spaces: [exterior, hall],
    buildings: [mainHouse, greenhouse, gatehouse],
    locationBindings,
    assetManifest: ASSET_MANIFEST,
  }
}

/** 冻结场景常量：结构与 createMistManorScene() 的每次返回一致。 */
export const MIST_MANOR_SCENE: SceneDefinition = createMistManorScene()
