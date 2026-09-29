import { createBlockRegistry } from './registry'
import { getBlock, inBounds } from './sections'
import type { BlockRegistry, ValidationIssue, VoxelCoord, VoxelDocument } from './types'

// ── S2b 可行走性校验（F5，仅生成管线使用）──────────────
// 语义与 web 引擎 pathfinding.ts 的 isStandable/findPath 同源:
// 可站立 = 脚下实心非流体非半透明、自身与头顶非实心。
// 本模块不依赖 web 引擎(契约包零外部依赖),通过测试对齐语义。

export interface WalkabilityOptions {
  lightThreshold?: number   // R3 单格亮度阈值,默认 4(0-15 光级)
  lightCoverage?: number    // R3 达标占比,默认 0.7
  maxVisited?: number       // BFS 上限,默认 200_000(N6)
}

const DEFAULTS = { lightThreshold: 4, lightCoverage: 0.7, maxVisited: 200_000 } as const

/** 单世界 issue 总数上限:重试提示词只取前几条,避免刷屏 */
const MAX_ISSUES = 20

const key = (at: VoxelCoord) => `${at.x},${at.y},${at.z}`

/** 阻挡移动/站立的实心:实心且非流体(水等可穿过) */
function blocksMovement(reg: BlockRegistry, blockId: string): boolean {
  const b = reg.get(blockId)
  return !!b?.solid && b.category !== 'fluid'
}

/** 可作为站立面:实心、非流体、非半透明(玻璃顶面不可站,与引擎一致) */
function standableSurface(reg: BlockRegistry, blockId: string): boolean {
  const b = reg.get(blockId)
  return !!b?.solid && b.category !== 'fluid' && !b.translucent
}

/** 校验上下文:每趟 validateWalkability 一份,缓存可站立判定 */
interface WalkContext {
  doc: VoxelDocument
  reg: BlockRegistry
  standableCache: Map<string, boolean>
}

/** 可站立格:脚下是站立面,自身与头顶可通过(与 web pathfinding.isStandable 同语义) */
function isStandableAt(ctx: WalkContext, at: VoxelCoord): boolean {
  const k = key(at)
  const cached = ctx.standableCache.get(k)
  if (cached !== undefined) return cached
  const { doc, reg } = ctx
  let result = false
  if (inBounds(doc.size, at) && at.y >= 1) {
    result = standableSurface(reg, getBlock(doc, { x: at.x, y: at.y - 1, z: at.z }))
      && !blocksMovement(reg, getBlock(doc, at))
      && !blocksMovement(reg, getBlock(doc, { x: at.x, y: at.y + 1, z: at.z }))
  }
  ctx.standableCache.set(k, result)
  return result
}

/** 移动边类型:walk/step 为常规,gap 为跳过 1 格间隙(R5 用) */
interface WalkEdge { to: VoxelCoord; kind: 'walk' | 'step' | 'gap'; via?: VoxelCoord }

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

/** 行走图邻接(惰性生成,不全图物化):平走 / 上下 1 格台阶 / 跳过同层 1 格间隙 */
function walkNeighbors(ctx: WalkContext, from: VoxelCoord): WalkEdge[] {
  const { doc, reg } = ctx
  const edges: WalkEdge[] = []
  for (const [dx, dz] of DIRS) {
    const flat = { x: from.x + dx, y: from.y, z: from.z + dz }
    if (!inBounds(doc.size, flat)) continue
    if (isStandableAt(ctx, flat)) {
      edges.push({ to: flat, kind: 'walk' })
      continue
    }
    // 上 1 格台阶:自身头顶第 3 格需非实心(起跳空间)
    const up = { x: flat.x, y: from.y + 1, z: flat.z }
    if (inBounds(doc.size, up) && isStandableAt(ctx, up)
        && !blocksMovement(reg, getBlock(doc, { x: from.x, y: from.y + 2, z: from.z }))) {
      edges.push({ to: up, kind: 'step' })
      continue
    }
    // 下 1 格台阶
    const down = { x: flat.x, y: from.y - 1, z: flat.z }
    if (down.y >= 1 && isStandableAt(ctx, down)) {
      edges.push({ to: down, kind: 'step' })
      continue
    }
    // 跳过同层 1 格间隙:中间格与其上方均可穿越,对面可站立
    const gapOpen = !blocksMovement(reg, getBlock(doc, flat))
      && !blocksMovement(reg, getBlock(doc, { x: flat.x, y: flat.y + 1, z: flat.z }))
    if (gapOpen) {
      const across = { x: from.x + dx * 2, y: from.y, z: from.z + dz * 2 }
      if (inBounds(doc.size, across) && isStandableAt(ctx, across)) {
        edges.push({ to: across, kind: 'gap', via: flat })
      }
    }
  }
  return edges
}

/** 可达性泛洪结果:可达集 + 「仅经跳隙边到达」的格(R5 用) */
interface FloodResult {
  reached: Set<string>
  gapOnly: Set<string>
}

/** 世界边缘一圈柱子中的全部可站立格为种子,沿行走图 BFS(R2 的可达集) */
function floodFromOutside(ctx: WalkContext, maxVisited: number): FloodResult {
  const { doc } = ctx
  const { width, height, depth } = doc.size
  const queue: VoxelCoord[] = []
  const reached = new Set<string>()
  const gapOnly = new Set<string>()
  const seed = (at: VoxelCoord) => {
    const k = key(at)
    if (!reached.has(k) && isStandableAt(ctx, at)) {
      reached.add(k)
      queue.push(at)
    }
  }
  for (let x = 0; x < width; x++) {
    for (const z of [0, depth - 1]) for (let y = 1; y < height; y++) seed({ x, y, z })
  }
  for (let z = 0; z < depth; z++) {
    for (const x of [0, width - 1]) for (let y = 1; y < height; y++) seed({ x, y, z })
  }
  for (let head = 0; head < queue.length && reached.size < maxVisited; head++) {
    const from = queue[head]
    for (const edge of walkNeighbors(ctx, from)) {
      const k = key(edge.to)
      if (reached.has(k)) {
        if (edge.kind !== 'gap') gapOnly.delete(k)
        continue
      }
      reached.add(k)
      if (edge.kind === 'gap') gapOnly.add(k)
      queue.push(edge.to)
    }
  }
  return { reached, gapOnly }
}

/** 绑定人物/地点的物体(locations 表 + 物体自带 binding) */
function boundObjects(doc: VoxelDocument) {
  const boundIds = new Set(doc.locations.map((l) => l.objectId))
  return doc.objects.filter((o) => boundIds.has(o.id) || o.binding)
}

/** R2:绑定物体的邻接可站立格至少一格 ∈ 可达集 */
function checkConnectivity(ctx: WalkContext, flood: FloodResult): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const cellsOf = new Map(ctx.doc.objectCells.map((e) => [e.objectId, e.cells]))
  for (const object of boundObjects(ctx.doc)) {
    const cells = cellsOf.get(object.id) ?? []
    let reachable = false
    for (const c of cells) {
      // 候选站位:占据格四邻(同层与上下一格)与占据格正上方
      const candidates: VoxelCoord[] = [{ x: c.x, y: c.y + 1, z: c.z }]
      for (const [dx, dz] of DIRS) {
        for (const dy of [0, 1, -1]) candidates.push({ x: c.x + dx, y: c.y + dy, z: c.z + dz })
      }
      if (candidates.some((at) => isStandableAt(ctx, at) && flood.reached.has(key(at)))) {
        reachable = true
        break
      }
    }
    if (!reachable) {
      issues.push({
        code: 'walk-connectivity',
        message: `object '${object.id}' (${object.objectType}) 无可达站位:从室外沿可行走规则无法靠近`,
        at: object.anchor,
      })
    }
  }
  return issues
}

/**
 * 可行走性校验(F5):输入世界文档,输出 ValidationIssue[]。
 * 只在 AI 生成管线调用;用户编辑路径不经过(F6)。
 */
export function validateWalkability(
  doc: VoxelDocument,
  registry?: BlockRegistry,
  opts: WalkabilityOptions = {},
): ValidationIssue[] {
  const options = { ...DEFAULTS, ...opts }
  const reg = registry ?? createBlockRegistry(doc.theme)
  const ctx: WalkContext = { doc, reg, standableCache: new Map() }
  const flood = floodFromOutside(ctx, options.maxVisited)
  const issues: ValidationIssue[] = [
    ...checkConnectivity(ctx, flood),          // R2
    // T3: R1 净高 + R5 缺口;T4: R4 高差突变;T5: R3 照明
  ]
  return issues.slice(0, MAX_ISSUES)
}
