import { getObjectTemplate } from './catalog'
import { fbm2D, mulberry32 } from './noise'
import { AIR, getBlock, setBlockMut } from './sections'
import type {
  ClampRecord, ResolvedTerrainParams, SectionKey, TerrainCell, TerrainParams, VoxelCoord, VoxelDocument, VoxelSize,
} from './types'

// ── 参数化地形生成器(S3b 第 9 项)────────────────
// 纯函数:同 (size, params) 必同输出(N4)。噪声全程整数哈希 + 浮点四则,
// 跨进程跨端逐位一致(AC2/AC11)。
//
// 水位约定:基准地面 B=3,水面顶格 y=3;河床/湖底挖到 y=1。
// 该约定是生成器内部常量,不写进 schema;与 S3a 下沉水面渲染兼容。

export const BASE_GROUND_Y = 3

export const TERRAIN_QUOTAS = {
  amplitudeMax: 8,
  scaleMin: 8,
  scaleMax: 96,
  riverWidthMin: 1,
  riverWidthMax: 3,
  lakeSizeMin: 2,
  lakeSizeMax: 8,
  densityMax: 0.1,
  treeMax: 160,
  decorMax: 2000,
} as const

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

/**
 * 配额夹取:AI 原始参数 → 合法参数 + 夹取记录(F5)。
 * 未提供的字段保持缺省(由 generateTerrainCells 的默认值兜底);
 * seed 非整数则忽略,由调用方通过 fallbackSeed 分配。
 */
export function clampTerrainParams(
  raw: TerrainParams,
  size: VoxelSize,
  fallbackSeed = 0,
): { params: ResolvedTerrainParams; clamps: ClampRecord[] } {
  const clamps: ClampRecord[] = []
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as TerrainParams
  const params: ResolvedTerrainParams = {
    seed: Number.isInteger(src.seed) ? (src.seed as number) : fallbackSeed,
  }

  const ampLimit = Math.min(TERRAIN_QUOTAS.amplitudeMax, Math.floor(size.height / 4))
  if (src.elevation && typeof src.elevation === 'object') {
    const elevation: NonNullable<TerrainParams['elevation']> = {}
    const amp = num(src.elevation.amplitude)
    if (amp !== undefined) {
      elevation.amplitude = clampNum(amp, 0, ampLimit)
      if (elevation.amplitude !== amp) {
        clamps.push({ field: 'elevation.amplitude', from: amp, to: elevation.amplitude })
      }
    }
    const scale = num(src.elevation.scale)
    if (scale !== undefined) {
      elevation.scale = clampNum(scale, TERRAIN_QUOTAS.scaleMin, TERRAIN_QUOTAS.scaleMax)
      if (elevation.scale !== scale) {
        clamps.push({ field: 'elevation.scale', from: scale, to: elevation.scale })
      }
    }
    params.elevation = elevation
  }

  if (src.river && typeof src.river === 'object') {
    const river: NonNullable<TerrainParams['river']> = {}
    const enabled = bool(src.river.enabled)
    river.enabled = enabled ?? false
    const width = num(src.river.width)
    if (width !== undefined) {
      river.width = clampNum(Math.round(width), TERRAIN_QUOTAS.riverWidthMin, TERRAIN_QUOTAS.riverWidthMax)
      if (river.width !== width) clamps.push({ field: 'river.width', from: width, to: river.width })
    }
    params.river = river
  }

  if (src.lakes && typeof src.lakes === 'object') {
    const lakes: NonNullable<TerrainParams['lakes']> = {}
    const enabled = bool(src.lakes.enabled)
    lakes.enabled = enabled ?? false
    const lakeSize = num(src.lakes.size)
    if (lakeSize !== undefined) {
      lakes.size = clampNum(Math.round(lakeSize), TERRAIN_QUOTAS.lakeSizeMin, TERRAIN_QUOTAS.lakeSizeMax)
      if (lakes.size !== lakeSize) clamps.push({ field: 'lakes.size', from: lakeSize, to: lakes.size })
    }
    params.lakes = lakes
  }

  if (src.vegetation && typeof src.vegetation === 'object') {
    const vegetation: NonNullable<TerrainParams['vegetation']> = {}
    const density = num(src.vegetation.density)
    if (density !== undefined) {
      vegetation.density = clampNum(density, 0, TERRAIN_QUOTAS.densityMax)
      if (vegetation.density !== density) {
        clamps.push({ field: 'vegetation.density', from: density, to: vegetation.density })
      }
    }
    vegetation.trees = bool(src.vegetation.trees) ?? true
    vegetation.flowers = bool(src.vegetation.flowers) ?? true
    vegetation.bushes = bool(src.vegetation.bushes) ?? true
    params.vegetation = vegetation
  }

  return { params, clamps }
}

interface Column { h: number; water: boolean; bank: boolean }

/** 纯函数:世界尺寸 + 已夹取参数(含 seed) → 地形格集合 */
export function generateTerrainCells(size: VoxelSize, params: ResolvedTerrainParams): TerrainCell[] {
  const { width, height, depth } = size
  const seed = params.seed | 0
  const amp = params.elevation?.amplitude ?? 0
  const scale = params.elevation?.scale ?? 24
  const riverOn = params.river?.enabled ?? false
  const riverWidth = params.river?.width ?? 2
  const lakesOn = params.lakes?.enabled ?? false
  const lakeSize = params.lakes?.size ?? 4
  const density = params.vegetation?.density ?? 0
  const treesOn = params.vegetation?.trees ?? true
  const flowersOn = params.vegetation?.flowers ?? true
  const bushesOn = params.vegetation?.bushes ?? true

  // ── 高度场 ──────────────────────────────
  const heightAt = (x: number, z: number): number => {
    const h = BASE_GROUND_Y + Math.round(amp * fbm2D(seed, x / scale, z / scale, 4))
    return Math.min(height - 2, Math.max(1, h))
  }

  // ── 河流中线:沿 x 推进,z 由 fbm 引导蜿蜒 ──
  const riverCenter = (x: number): number =>
    depth / 2 + (depth / 4) * fbm2D((seed ^ 0x51ed) | 0, x / (scale * 2), 0, 3)

  // ── 湖泊:种子派生 1–3 个中心 ─────────────
  const lakes: Array<{ cx: number; cz: number; r: number }> = []
  if (lakesOn) {
    const rng = mulberry32((seed ^ 0x1a2b3c) | 0)
    const count = 1 + Math.floor(rng() * 3)
    for (let i = 0; i < count; i++) {
      lakes.push({ cx: Math.floor(rng() * width), cz: Math.floor(rng() * depth), r: lakeSize })
    }
  }

  // ── 柱状雕刻 ─────────────────────────────
  const columns: Column[] = new Array(width * depth)
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      let h = heightAt(x, z)
      let water = false
      let bank = false
      if (riverOn) {
        const d = Math.abs(z - riverCenter(x))
        if (d <= riverWidth / 2) {
          h = Math.min(h, BASE_GROUND_Y - 2)
          water = true
        } else if (d <= riverWidth / 2 + 1) {
          h = Math.min(h, BASE_GROUND_Y - 1)
          bank = true
        }
      }
      for (const lake of lakes) {
        const d = Math.sqrt((x - lake.cx) * (x - lake.cx) + (z - lake.cz) * (z - lake.cz))
        if (d <= lake.r) {
          h = Math.min(h, BASE_GROUND_Y - 2)
          water = true
        } else if (d <= lake.r + 1) {
          h = Math.min(h, BASE_GROUND_Y - 1)
          bank = true
        }
      }
      columns[z * width + x] = { h: Math.max(1, h), water, bank }
    }
  }

  // ── 落格:柱填充 + 水体 ───────────────────
  const cells: TerrainCell[] = []
  const push = (x: number, y: number, z: number, block: string) => cells.push({ at: { x, y, z }, block })
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      const col = columns[z * width + x]
      const topBlock = col.water || col.bank ? 'gravel' : 'grass'
      for (let y = 0; y <= col.h; y++) {
        const block = y === col.h ? topBlock : y >= col.h - 2 ? 'dirt' : 'stone'
        push(x, y, z, block)
      }
      if (col.water) {
        for (let y = col.h + 1; y <= BASE_GROUND_Y; y++) push(x, y, z, 'water')
      }
    }
  }

  // ── 植被散布(配额:树 ≤ treeMax,装饰格 ≤ decorMax)──
  if (density > 0) {
    const rng = mulberry32((seed ^ 0xf00d) | 0)
    let decorCount = 0
    let treeCount = 0

    // 树:4×4 抖动网格,每胞至多一棵,保证间距;烙模板格但不注册 objectCells
    const treeTemplate = treesOn ? getObjectTemplate('tree') : undefined
    if (treeTemplate) {
      const maxOffsetY = Math.max(...treeTemplate.cells.map((c) => c.offset.y))
      for (let gz = 0; gz * 4 < depth && treeCount < TERRAIN_QUOTAS.treeMax; gz++) {
        for (let gx = 0; gx * 4 < width && treeCount < TERRAIN_QUOTAS.treeMax; gx++) {
          const tx = gx * 4 + Math.floor(rng() * 4)
          const tz = gz * 4 + Math.floor(rng() * 4)
          if (tx >= width || tz >= depth) continue
          const col = columns[tz * width + tx]
          if (col.water || col.bank) continue
          if (col.h + 1 + maxOffsetY > height - 1) continue // 树冠不出世界顶
          if (rng() >= density) continue
          if (decorCount + treeTemplate.cells.length > TERRAIN_QUOTAS.decorMax) continue
          for (const c of treeTemplate.cells) {
            push(tx + c.offset.x, col.h + 1 + c.offset.y, tz + c.offset.z, c.block)
          }
          decorCount += treeTemplate.cells.length
          treeCount += 1
        }
      }
    }

    // 花/灌木:逐柱散布
    for (let z = 0; z < depth && decorCount < TERRAIN_QUOTAS.decorMax; z++) {
      for (let x = 0; x < width && decorCount < TERRAIN_QUOTAS.decorMax; x++) {
        const col = columns[z * width + x]
        if (col.water || col.bank) continue
        if (rng() >= density) continue
        const pickFlower = flowersOn && (!bushesOn || rng() < 0.6)
        if (pickFlower) push(x, col.h + 1, z, 'flower')
        else if (bushesOn) push(x, col.h + 1, z, 'bush')
        else continue
        decorCount += 1
      }
    }
  }

  return cells
}

/**
 * 重生成 diff(F7 地形层替换规则):
 * - 物体格(objectCells)绝对不动;
 * - 旧地形层的格无条件替换为新输出(新输出无此格则写 air)——
 *   含被手工修改过的地形格与地面小径;
 * - 仅属于新输出的格只在当前为 air 时写入——新地形不压既有内容(建筑)。
 */
export function diffTerrainRegen(
  doc: VoxelDocument,
  oldCells: TerrainCell[],
  newCells: TerrainCell[],
): TerrainCell[] {
  const keyOf = (at: VoxelCoord) => `${at.x},${at.y},${at.z}`
  const oldMap = new Map<string, TerrainCell>()
  for (const c of oldCells) oldMap.set(keyOf(c.at), c)
  const newMap = new Map<string, TerrainCell>()
  for (const c of newCells) newMap.set(keyOf(c.at), c)
  const protectedCells = new Set<string>()
  for (const entry of doc.objectCells) for (const at of entry.cells) protectedCells.add(keyOf(at))

  const out: TerrainCell[] = []
  for (const [k, cell] of oldMap) {
    if (protectedCells.has(k)) continue
    const nv = newMap.get(k)
    out.push({ at: cell.at, block: nv ? nv.block : AIR })
  }
  for (const [k, cell] of newMap) {
    if (oldMap.has(k) || protectedCells.has(k)) continue
    if (getBlock(doc, cell.at) === AIR) out.push(cell)
  }
  return out
}

/** 地形格集合落文档:与 applyEdits 同样的文档级不可变更新,只动 sections */
export function writeTerrainCells(
  doc: VoxelDocument,
  cells: TerrainCell[],
): { document: VoxelDocument; changedSections: SectionKey[] } {
  const next: VoxelDocument = { ...doc, sections: { ...doc.sections } }
  const changed = new Set<SectionKey>()
  for (const cell of cells) {
    for (const key of setBlockMut(next, cell.at, cell.block)) changed.add(key)
  }
  return { document: next, changedSections: [...changed] }
}
