/**
 * N2D1 T05：素材几何契约。
 *
 * 冻结雾影庄全部素材的 AssetDefinition 清单：素材 ID、生产文件 URL、
 * 目标像素尺寸、脚点 anchorPx、占地 footprint、点击多边形 hitPolygon、
 * 图层 role/sortOffset/visibleAt，以及供 T06 冻结的入口偏移建议。
 *
 * 约定（与 plan.md「契约约束」一致）：
 * - 投影 2:1，基础格子 64×32 逻辑像素：gridToProjected(x, z) = ((x - z) * 32, (x + z) * 16)，
 *   即格子菱形的顶角。素材脚点 = 素材原点格子顶角的投影点，图片内以 anchorPx 对齐该点。
 * - footprint / sortAnchor / entryOffset 全部为相对原点的有限整数格子偏移。
 * - hitPolygon 以素材脚点为原点（图片坐标，允许小数），独立于碰撞占地。
 * - 同一素材各图层的 pixelWidth/pixelHeight/anchorPx 完全一致，保证分层合成无错位。
 * - 参考图 cold-mystery-reference-v1.png 仅作美术方向，不登记为任何素材或背景。
 * - 图片文件由 T20–T27 按本契约的 URL/尺寸/脚点交付，T28 汇合核对实际像素。
 */

import type {
  AssetDefinition,
  AssetLayer,
  GridPoint,
  PixelPoint,
  TimeOfDay,
} from './types'

/** 生产素材 URL 根路径（对应 web/public/native2d/mist-manor）。 */
export const ASSET_URL_ROOT = '/native2d/mist-manor'

/** 图层全时段可见。 */
const ALL_TIMES: readonly TimeOfDay[] = ['dawn', 'day', 'dusk', 'night', 'unknown']

/** 局部暖光（accent 层）仅黄昏与夜晚可见：冷色悬疑基调下的窗灯/门灯。 */
const WARM_LIGHT_TIMES: readonly TimeOfDay[] = ['dusk', 'night']

/** 地面层深度偏移：永远压在全部物件之下。 */
const GROUND_SORT_OFFSET = -1024
/** 遮挡层在脚点深度之后绘制，供选中居民时独立淡出。 */
const OCCLUDER_SORT_OFFSET = 1
/** 暖光 accent 叠在本体与遮挡之上。 */
const ACCENT_SORT_OFFSET = 2

/** 生成 width×depth 矩形占地偏移（有限整数格子）。 */
function rectOffsets(width: number, depth: number): GridPoint[] {
  const cells: GridPoint[] = []
  for (let x = 0; x < width; x += 1) {
    for (let z = 0; z < depth; z += 1) {
      cells.push({ x, z })
    }
  }
  return cells
}

/** 生成 width×depth 矩形外圈占地偏移（墙体等环形阻挡，有限整数格子）。 */
function perimeterOffsets(width: number, depth: number): GridPoint[] {
  const cells: GridPoint[] = []
  for (let x = 0; x < width; x += 1) {
    for (let z = 0; z < depth; z += 1) {
      if (x === 0 || z === 0 || x === width - 1 || z === depth - 1) {
        cells.push({ x, z })
      }
    }
  }
  return cells
}

interface LayerSpec {
  readonly file: string
  readonly role: AssetLayer['role']
  readonly sortOffset: number
  readonly visibleAt: readonly TimeOfDay[]
}

/** 按「同素材各层同尺寸同脚点」约定生成图层数组。 */
function layers(
  assetId: string,
  urlDir: string,
  pixelWidth: number,
  pixelHeight: number,
  anchorPx: PixelPoint,
  specs: readonly LayerSpec[],
): AssetLayer[] {
  return specs.map((spec) => ({
    id: `${assetId}-${spec.role}`,
    url: `${ASSET_URL_ROOT}/${urlDir}/${spec.file}`,
    pixelWidth,
    pixelHeight,
    anchorPx,
    role: spec.role,
    sortOffset: spec.sortOffset,
    visibleAt: spec.visibleAt,
  }))
}

const BASE: LayerSpec = { file: '', role: 'base', sortOffset: 0, visibleAt: ALL_TIMES }
const OCCLUDER: LayerSpec = {
  file: '',
  role: 'occluder',
  sortOffset: OCCLUDER_SORT_OFFSET,
  visibleAt: ALL_TIMES,
}
const ACCENT: LayerSpec = {
  file: '',
  role: 'accent',
  sortOffset: ACCENT_SORT_OFFSET,
  visibleAt: WARM_LIGHT_TIMES,
}

function spec(role: LayerSpec['role'], file: string): LayerSpec {
  const template = role === 'base' ? BASE : role === 'occluder' ? OCCLUDER : ACCENT
  return { ...template, file }
}

/* -------------------------------------------------------------------------- */
/* 建筑（T20–T22：buildings/*.png，各 base/occluder/accent 三层）              */
/* -------------------------------------------------------------------------- */

/**
 * 主楼 main-house：占地 4×3，三开间冷色石楼，暖窗仅黄昏/夜晚亮起。
 * 图片 288×264：脚点上留 144px（三层墙体+屋顶），下含 4×3 底菱形（最深 112px）加 8px 余量，
 * 左右各 32px 屋檐外挑。入口建议在南面（+z 面）x=2 处，见 BUILDING_ENTRY_OFFSETS。
 */
const MAIN_HOUSE: AssetDefinition = {
  id: 'main-house',
  layers: layers('main-house', 'buildings', 288, 264, { x: 128, y: 144 }, [
    spec('base', 'main-house-base.png'),
    spec('occluder', 'main-house-occluder.png'),
    spec('accent', 'main-house-accent.png'),
  ]),
  footprint: rectOffsets(4, 3),
  sortAnchor: { x: 3, z: 2 },
  hitPolygon: [
    { x: 0, y: -140 },
    { x: 96, y: -72 },
    { x: 128, y: 64 },
    { x: 32, y: 112 },
    { x: -96, y: 48 },
    { x: -88, y: -56 },
  ],
}

/**
 * 温室 greenhouse：占地 3×2，玻璃花房，内部暖光仅黄昏/夜晚亮起。
 * 图片 224×200：脚点上留 112px，下含 3×2 底菱形（最深 80px）加 8px 余量。入口在 +z 面 x=1。
 */
const GREENHOUSE: AssetDefinition = {
  id: 'greenhouse',
  layers: layers('greenhouse', 'buildings', 224, 200, { x: 96, y: 112 }, [
    spec('base', 'greenhouse-base.png'),
    spec('occluder', 'greenhouse-occluder.png'),
    spec('accent', 'greenhouse-accent.png'),
  ]),
  footprint: rectOffsets(3, 2),
  sortAnchor: { x: 2, z: 1 },
  hitPolygon: [
    { x: 0, y: -108 },
    { x: 72, y: -56 },
    { x: 96, y: 48 },
    { x: 32, y: 80 },
    { x: -64, y: 32 },
    { x: -56, y: -48 },
  ],
}

/**
 * 门房 gatehouse：占地 2×2，最小建筑，门灯暖光仅黄昏/夜晚亮起。
 * 图片 192×176：脚点上留 104px，下含 2×2 底菱形（最深 64px）加 8px 余量。入口在 +z 面 x=1。
 */
const GATEHOUSE: AssetDefinition = {
  id: 'gatehouse',
  layers: layers('gatehouse', 'buildings', 192, 176, { x: 96, y: 104 }, [
    spec('base', 'gatehouse-base.png'),
    spec('occluder', 'gatehouse-occluder.png'),
    spec('accent', 'gatehouse-accent.png'),
  ]),
  footprint: rectOffsets(2, 2),
  sortAnchor: { x: 1, z: 1 },
  hitPolygon: [
    { x: 0, y: -100 },
    { x: 56, y: -52 },
    { x: 64, y: 32 },
    { x: 0, y: 64 },
    { x: -64, y: 32 },
    { x: -56, y: -52 },
  ],
}

/* -------------------------------------------------------------------------- */
/* 地形与植被（T23–T24：terrain/*.png）                                        */
/* -------------------------------------------------------------------------- */

/** 单格地形菱形点击区（以格子顶角为原点）。 */
const TILE_HIT_POLYGON: readonly PixelPoint[] = [
  { x: 0, y: 0 },
  { x: 32, y: 16 },
  { x: 0, y: 32 },
  { x: -32, y: 16 },
]

function terrainTile(id: string, file: string): AssetDefinition {
  return {
    id,
    layers: [
      {
        id: `${id}-base`,
        url: `${ASSET_URL_ROOT}/terrain/${file}`,
        pixelWidth: 64,
        pixelHeight: 32,
        anchorPx: { x: 32, y: 0 },
        role: 'base',
        sortOffset: GROUND_SORT_OFFSET,
        visibleAt: ALL_TIMES,
      },
    ],
    footprint: [{ x: 0, z: 0 }],
    sortAnchor: { x: 0, z: 0 },
    hitPolygon: TILE_HIT_POLYGON,
  }
}

/** 地面 ground：冷色草地单格，可平铺，不烘焙建筑/道路/人物。 */
const GROUND = terrainTile('ground', 'ground.png')
/** 道路 path：明亮通路单格，明度与地面稳定可辨，对齐可通行区域。 */
const PATH = terrainTile('path', 'path.png')
/** 水岸 shore：水岸过渡单格，装饰用途。 */
const SHORE = terrainTile('shore', 'shore.png')

/**
 * 树 tree：双层素材——tree-base.png 树干基部 + tree-occluder.png 树冠遮挡。
 * 图片 128×160 两层同尺寸同脚点：脚点上留 120px 树冠，下含单格菱形加 8px 余量。
 */
const TREE: AssetDefinition = {
  id: 'tree',
  layers: layers('tree', 'terrain', 128, 160, { x: 64, y: 120 }, [
    spec('base', 'tree-base.png'),
    spec('occluder', 'tree-occluder.png'),
  ]),
  footprint: [{ x: 0, z: 0 }],
  sortAnchor: { x: 0, z: 0 },
  hitPolygon: [
    { x: 0, y: -116 },
    { x: 40, y: -80 },
    { x: 28, y: -24 },
    { x: 16, y: 28 },
    { x: -16, y: 28 },
    { x: -28, y: -24 },
    { x: -40, y: -80 },
  ],
}

/** 灌木 shrub：单层低植被，不遮蔽通路与入口可读区。 */
const SHRUB: AssetDefinition = {
  id: 'shrub',
  layers: layers('shrub', 'terrain', 96, 64, { x: 48, y: 24 }, [spec('base', 'shrub.png')]),
  footprint: [{ x: 0, z: 0 }],
  sortAnchor: { x: 0, z: 0 },
  hitPolygon: [
    { x: 0, y: -20 },
    { x: 24, y: -8 },
    { x: 28, y: 16 },
    { x: 0, y: 32 },
    { x: -28, y: 16 },
    { x: -24, y: -8 },
  ],
}

/* -------------------------------------------------------------------------- */
/* 大厅（T25–T26：hall/*.png）                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 大厅地面 hall-floor：6×5 室内地平面，精确菱形 352×176，不烘焙家具。
 * 脚点 = (0,0) 格子顶角，anchorPx {x:160, y:0}。
 */
export const HALL_FLOOR_GRID = { width: 6, depth: 5 } as const

const HALL_FLOOR: AssetDefinition = {
  id: 'hall-floor',
  layers: [
    {
      id: 'hall-floor-base',
      url: `${ASSET_URL_ROOT}/hall/floor.png`,
      pixelWidth: 352,
      pixelHeight: 176,
      anchorPx: { x: 160, y: 0 },
      role: 'base',
      sortOffset: GROUND_SORT_OFFSET,
      visibleAt: ALL_TIMES,
    },
  ],
  footprint: rectOffsets(6, 5),
  sortAnchor: { x: 0, z: 0 },
  hitPolygon: [
    { x: 0, y: 0 },
    { x: 192, y: 96 },
    { x: 32, y: 176 },
    { x: -160, y: 80 },
  ],
}

/**
 * 大厅墙体 hall-wall：wall-base.png 后墙 + wall-occluder.png 前景墙（可独立淡出）。
 * 与 hall-floor 同平面：352×256，地平面位于图片底部 176px，墙体向上 80px。
 * 占地为 6×5 外圈 18 格（墙体沿线阻挡），内部地面由 hall-floor 承载。
 */
const HALL_WALL: AssetDefinition = {
  id: 'hall-wall',
  layers: layers('hall-wall', 'hall', 352, 256, { x: 160, y: 80 }, [
    spec('base', 'wall-base.png'),
    spec('occluder', 'wall-occluder.png'),
  ]),
  footprint: perimeterOffsets(6, 5),
  sortAnchor: { x: 5, z: 4 },
  hitPolygon: [
    { x: 0, y: -78 },
    { x: 190, y: 14 },
    { x: 192, y: 96 },
    { x: 32, y: 176 },
    { x: -160, y: 80 },
    { x: -162, y: -2 },
  ],
}

/** 大厅桌 hall-table：占地 2×1。 */
const HALL_TABLE: AssetDefinition = {
  id: 'hall-table',
  layers: layers('hall-table', 'hall', 128, 88, { x: 48, y: 32 }, [spec('base', 'table.png')]),
  footprint: rectOffsets(2, 1),
  sortAnchor: { x: 1, z: 0 },
  hitPolygon: [
    { x: 0, y: -30 },
    { x: 48, y: -8 },
    { x: 64, y: 32 },
    { x: 32, y: 48 },
    { x: -32, y: 16 },
    { x: -24, y: -12 },
  ],
}

/** 大厅椅 hall-chair：占地 1×1。 */
const HALL_CHAIR: AssetDefinition = {
  id: 'hall-chair',
  layers: layers('hall-chair', 'hall', 96, 80, { x: 48, y: 40 }, [spec('base', 'chair.png')]),
  footprint: [{ x: 0, z: 0 }],
  sortAnchor: { x: 0, z: 0 },
  hitPolygon: [
    { x: 0, y: -36 },
    { x: 20, y: -20 },
    { x: 24, y: 16 },
    { x: 0, y: 32 },
    { x: -24, y: 16 },
    { x: -20, y: -20 },
  ],
}

/** 大厅灯 hall-lamp：占地 1×1，亮层可保留局部暖色（单层烘焙，T26 核对）。 */
const HALL_LAMP: AssetDefinition = {
  id: 'hall-lamp',
  layers: layers('hall-lamp', 'hall', 96, 128, { x: 48, y: 88 }, [spec('base', 'lamp.png')]),
  footprint: [{ x: 0, z: 0 }],
  sortAnchor: { x: 0, z: 0 },
  hitPolygon: [
    { x: 0, y: -84 },
    { x: 14, y: -72 },
    { x: 14, y: 16 },
    { x: 20, y: 24 },
    { x: 0, y: 32 },
    { x: -20, y: 24 },
    { x: -14, y: 16 },
    { x: -14, y: -72 },
  ],
}

/* -------------------------------------------------------------------------- */
/* 居民（T27：residents/*.png）                                                */
/* -------------------------------------------------------------------------- */

/**
 * 静态居民：约 1 格宽（身宽 ≤24px，远小于 64px 格宽）、高 56px（小于两格 64px）。
 * 40×56 透明背景，脚点位于所站格子顶角，脚底落在格心（脚点下方 16px）。
 */
function resident(id: string): AssetDefinition {
  return {
    id,
    layers: [
      {
        id: `${id}-base`,
        url: `${ASSET_URL_ROOT}/residents/${id}.png`,
        pixelWidth: 40,
        pixelHeight: 56,
        anchorPx: { x: 20, y: 40 },
        role: 'base',
        sortOffset: 0,
        visibleAt: ALL_TIMES,
      },
    ],
    footprint: [{ x: 0, z: 0 }],
    sortAnchor: { x: 0, z: 0 },
    hitPolygon: [
      { x: 0, y: -38 },
      { x: 11, y: -30 },
      { x: 12, y: -4 },
      { x: 8, y: 14 },
      { x: 0, y: 17 },
      { x: -8, y: 14 },
      { x: -12, y: -4 },
      { x: -11, y: -30 },
    ],
  }
}

const RESIDENT_A = resident('resident-a')
const RESIDENT_B = resident('resident-b')
const RESIDENT_C = resident('resident-c')

/* -------------------------------------------------------------------------- */
/* 清单与分组导出                                                              */
/* -------------------------------------------------------------------------- */

/** 冻结素材清单：T06 场景定义与 T28 素材汇合的唯一来源。 */
export const ASSET_MANIFEST: Readonly<Record<string, AssetDefinition>> = {
  'main-house': MAIN_HOUSE,
  greenhouse: GREENHOUSE,
  gatehouse: GATEHOUSE,
  ground: GROUND,
  path: PATH,
  shore: SHORE,
  tree: TREE,
  shrub: SHRUB,
  'hall-floor': HALL_FLOOR,
  'hall-wall': HALL_WALL,
  'hall-table': HALL_TABLE,
  'hall-chair': HALL_CHAIR,
  'hall-lamp': HALL_LAMP,
  'resident-a': RESIDENT_A,
  'resident-b': RESIDENT_B,
  'resident-c': RESIDENT_C,
}

/** 可移动建筑素材（T20–T22）。 */
export const BUILDING_ASSET_IDS = ['main-house', 'greenhouse', 'gatehouse'] as const

/** 地形素材（T23）。 */
export const TERRAIN_ASSET_IDS = ['ground', 'path', 'shore'] as const

/** 植被与外景遮挡素材（T24）。 */
export const VEGETATION_ASSET_IDS = ['tree', 'shrub'] as const

/** 大厅素材（T25–T26）。 */
export const HALL_ASSET_IDS = [
  'hall-floor',
  'hall-wall',
  'hall-table',
  'hall-chair',
  'hall-lamp',
] as const

/** 居民素材（T27）。 */
export const RESIDENT_ASSET_IDS = ['resident-a', 'resident-b', 'resident-c'] as const

/**
 * 建筑入口偏移建议（相对建筑原点的整数格子，位于 footprint 外一格的可通行面）。
 * 供 T06 冻结 BuildingDefinition.entryOffset 参考：
 * - main-house：+z 面 x=2 门外一格（大门朝南）。
 * - greenhouse：+z 面 x=1 门外一格。
 * - gatehouse：+z 面 x=1 门外一格。
 */
export const BUILDING_ENTRY_OFFSETS: Readonly<Record<string, GridPoint>> = {
  'main-house': { x: 2, z: 3 },
  greenhouse: { x: 1, z: 2 },
  gatehouse: { x: 1, z: 2 },
}

/** 建筑 footprint 尺寸速查（供素材任务 T20–T22 与 T06 核对比例）。 */
export const BUILDING_FOOTPRINT_SIZES: Readonly<
  Record<string, { readonly width: number; readonly depth: number }>
> = {
  'main-house': { width: 4, depth: 3 },
  greenhouse: { width: 3, depth: 2 },
  gatehouse: { width: 2, depth: 2 },
}
