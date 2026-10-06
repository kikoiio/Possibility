import { createBlockRegistry } from './registry'
import { getBlock, inBounds } from './sections'
import type { SceneWorkControl } from './scene-compatibility'
import type { BlockRegistry, ValidationIssue, VoxelCoord, VoxelDocument } from './types'

// ── S2b 可行走性校验（F5，仅生成管线使用）──────────────
// 语义与 web 引擎 pathfinding.ts 的 isStandable/findPath 同源:
// 可站立 = 脚下实心非流体非半透明、自身与头顶非实心。
// 本模块不依赖 web 引擎(契约包零外部依赖),通过测试对齐语义。

export interface WalkabilityOptions {
  lightThreshold?: number   // R3 单格亮度阈值,默认 4(0-15 光级)
  lightCoverage?: number    // R3 达标占比,默认 0.7
  maxVisited?: number       // BFS 上限,默认 200_000(N6)
  maxWorkspaceBytes?: number // Cooperative flood guard; omitted means report-only, as in the sync API.
}

type WalkabilityLightingOptions = Required<Pick<WalkabilityOptions, 'lightThreshold' | 'lightCoverage'>>

export interface WalkabilityFloodStats {
  /** Number of distinct standable cells actually admitted to this flood's BFS. */
  visited: number
  /** False when at least one seed/neighbor remained undiscovered at maxVisited. */
  complete: boolean
  /** Accounting estimate for retained queue + visited-set entries, not process RSS. */
  workspaceBytesPeak: number
}

export interface WalkabilityStats {
  withGaps: WalkabilityFloodStats
  strict: WalkabilityFloodStats
  /** Both reachability floods completed without truncation. */
  complete: boolean
  /** Peak for both floods in sequence, accounting for the retained first visited set. */
  workspaceBytesPeak: number
}

export interface WalkabilityValidationResult {
  issues: ValidationIssue[]
  complete: boolean
  /** Sum of cells admitted to the two independent BFS floods. */
  visitedCells: number
  workUnits: number
  /** Logical queue/set peak across both floods, not process RSS. */
  workspaceBytesPeak: number
  /** Per-flood details make each maxVisited truncation independently auditable. */
  floods: WalkabilityStats
  stopReason?: 'cancelled' | 'deadline' | 'work-limit' | 'workspace-limit' | 'visit-limit' | null
}

type WalkabilityControlWithDeadline = SceneWorkControl & {
  deadlineAt?: number
  consumeWork?: (units: number) => boolean
  consumeWorkspace?: (workspaceBytesPeak: number) => boolean
}

interface CooperativeWork {
  tick(force?: boolean): Promise<boolean>
  workspace(bytes: number): boolean
  stopWorkspace(): void
  get stopReason(): 'cancelled' | 'deadline' | 'work-limit' | 'workspace-limit' | null
}

function cooperativeWork(ctx: WalkContext, control: WalkabilityControlWithDeadline): CooperativeWork {
  let workAtYield = ctx.workUnits
  let yieldedAt = control.nowMs()
  let stopped: CooperativeWork['stopReason'] = null
  const checkStop = () => {
    if (control.signal.aborted) stopped = 'cancelled'
    else if (control.deadlineAt !== undefined && control.nowMs() >= control.deadlineAt) stopped = 'deadline'
    return stopped !== null
  }
  return {
    get stopReason() { return stopped },
    workspace(bytes) {
      if (control.consumeWorkspace && !control.consumeWorkspace(bytes)) stopped = 'workspace-limit'
      return stopped !== 'workspace-limit'
    },
    stopWorkspace() { stopped = 'workspace-limit' },
    async tick(force = false) {
      if (checkStop()) return false
      const delta = ctx.workUnits - workAtYield
      const shouldYield = force || delta >= 512 || control.nowMs() - yieldedAt >= 8
      if (!shouldYield) return true
      if (delta > 0 && control.consumeWork && !control.consumeWork(delta)) {
        stopped = 'work-limit'
        return false
      }
      workAtYield = ctx.workUnits
      await control.yieldControl()
      yieldedAt = control.nowMs()
      return !checkStop()
    },
  }
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
  workUnits: number
}

function addWork(ctx: WalkContext, units = 1) {
  ctx.workUnits += units
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
    addWork(ctx) // one cardinal adjacency candidate examined
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

/** 可达性泛洪结果:可达集(含跳隙)+ 严格可达集(仅平走/台阶,R5 用) */
interface FloodResult {
  reached: Set<string>
  reachedStrict: Set<string>
  stats: WalkabilityStats
}

// Explicit workspace accounting model: queue slot + xyz object = 64 bytes;
// Set/hash entry overhead = 96 bytes; key strings = UTF-16 code units. This
// estimates the two retained collections' logical storage, not JS engine RSS.
const FLOOD_QUEUE_ENTRY_BYTES = 64
const FLOOD_SET_ENTRY_BYTES = 96

/** 世界边缘一圈柱子中的全部可站立格为种子,沿行走图 BFS;allowGaps=false 时禁用跳隙边 */
function flood(ctx: WalkContext, maxVisited: number, allowGaps: boolean): {
  reached: Set<string>; stats: WalkabilityFloodStats; retainedSetBytes: number
} {
  const { doc } = ctx
  const { width, height, depth } = doc.size
  const queue: VoxelCoord[] = []
  const reached = new Set<string>()
  let complete = true
  let keyBytes = 0
  let workspaceBytesPeak = 0
  const recordPeak = () => {
    workspaceBytesPeak = Math.max(workspaceBytesPeak,
      queue.length * FLOOD_QUEUE_ENTRY_BYTES + reached.size * FLOOD_SET_ENTRY_BYTES + keyBytes)
  }
  const seed = (at: VoxelCoord) => {
    addWork(ctx) // one perimeter seed candidate examined
    const k = key(at)
    if (!reached.has(k) && isStandableAt(ctx, at)) {
      if (reached.size >= maxVisited) {
        complete = false
        return
      }
      reached.add(k)
      queue.push(at)
      keyBytes += k.length * 2
      recordPeak()
    }
  }
  for (let x = 0; x < width; x++) {
    for (const z of [0, depth - 1]) for (let y = 1; y < height; y++) seed({ x, y, z })
  }
  for (let z = 0; z < depth; z++) {
    for (const x of [0, width - 1]) for (let y = 1; y < height; y++) seed({ x, y, z })
  }
  for (let head = 0; head < queue.length && complete; head++) {
    addWork(ctx) // one queued standable cell dequeued
    for (const edge of walkNeighbors(ctx, queue[head])) {
      if (!allowGaps && edge.kind === 'gap') continue
      const k = key(edge.to)
      if (reached.has(k)) continue
      if (reached.size >= maxVisited) {
        complete = false
        break
      }
      reached.add(k)
      queue.push(edge.to)
      keyBytes += k.length * 2
      recordPeak()
    }
  }
  return {
    reached,
    stats: { visited: reached.size, complete, workspaceBytesPeak },
    retainedSetBytes: reached.size * FLOOD_SET_ENTRY_BYTES + keyBytes,
  }
}

function floodFromOutside(ctx: WalkContext, maxVisited: number): FloodResult {
  const withGaps = flood(ctx, maxVisited, true)
  const strict = flood(ctx, maxVisited, false)
  return {
    reached: withGaps.reached,
    reachedStrict: strict.reached,
    stats: {
      withGaps: withGaps.stats,
      strict: strict.stats,
      complete: withGaps.stats.complete && strict.stats.complete,
      workspaceBytesPeak: Math.max(
        withGaps.stats.workspaceBytesPeak,
        withGaps.retainedSetBytes + strict.stats.workspaceBytesPeak,
      ),
    },
  }
}

/** Cooperative counterpart to flood(): bounded chunks let deadline/abort checks run during BFS. */
async function floodCooperatively(
  ctx: WalkContext,
  maxVisited: number,
  allowGaps: boolean,
  maxWorkspaceBytes: number,
  workspaceOffset: number,
  work: CooperativeWork,
): Promise<{ reached: Set<string>; stats: WalkabilityFloodStats; retainedSetBytes: number; stopReason: CooperativeWork['stopReason'] }> {
  const { doc } = ctx
  const { width, height, depth } = doc.size
  const queue: VoxelCoord[] = []
  const reached = new Set<string>()
  let complete = true
  let keyBytes = 0
  let workspaceBytesPeak = 0
  const admitWorkspace = (keyLength: number): boolean => {
    const projected = (queue.length + 1) * FLOOD_QUEUE_ENTRY_BYTES
      + (reached.size + 1) * FLOOD_SET_ENTRY_BYTES + keyBytes + keyLength * 2
    workspaceBytesPeak = Math.max(workspaceBytesPeak, projected)
    if (workspaceOffset + projected > maxWorkspaceBytes) { work.stopWorkspace(); return false }
    return work.workspace(workspaceOffset + projected)
  }
  const seed = async (at: VoxelCoord): Promise<boolean> => {
    addWork(ctx) // one perimeter seed candidate examined
    const k = key(at)
    if (!reached.has(k) && isStandableAt(ctx, at)) {
      if (reached.size >= maxVisited) { complete = false; return false }
      if (!admitWorkspace(k.length)) { complete = false; return false }
      reached.add(k)
      queue.push(at)
      keyBytes += k.length * 2
    }
    return work.tick()
  }
  for (let x = 0; x < width && complete && !work.stopReason; x++) {
    for (const z of [0, depth - 1]) {
      for (let y = 1; y < height; y++) {
        if (!await seed({ x, y, z })) { complete = false; break }
      }
      if (!complete || work.stopReason) break
    }
  }
  for (let z = 0; z < depth && complete && !work.stopReason; z++) {
    for (const x of [0, width - 1]) {
      for (let y = 1; y < height; y++) {
        if (!await seed({ x, y, z })) { complete = false; break }
      }
      if (!complete || work.stopReason) break
    }
  }
  for (let head = 0; head < queue.length && complete && !work.stopReason; head++) {
    addWork(ctx) // one queued standable cell dequeued
    for (const edge of walkNeighbors(ctx, queue[head])) {
      if (!allowGaps && edge.kind === 'gap') continue
      const k = key(edge.to)
      if (reached.has(k)) continue
      if (reached.size >= maxVisited) { complete = false; break }
      if (!admitWorkspace(k.length)) { complete = false; break }
      reached.add(k)
      queue.push(edge.to)
      keyBytes += k.length * 2
    }
    if (complete && !await work.tick()) complete = false
  }
  if (work.stopReason) complete = false
  return {
    reached,
    stats: { visited: reached.size, complete, workspaceBytesPeak },
    retainedSetBytes: reached.size * FLOOD_SET_ENTRY_BYTES + keyBytes,
    stopReason: work.stopReason,
  }
}

async function floodFromOutsideCooperatively(
  ctx: WalkContext,
  maxVisited: number,
  maxWorkspaceBytes: number,
  work: CooperativeWork,
): Promise<FloodResult & { stopReason: CooperativeWork['stopReason'] }> {
  const withGaps = await floodCooperatively(ctx, maxVisited, true, maxWorkspaceBytes, 0, work)
  if (!withGaps.stats.complete || withGaps.stopReason) {
    return {
      reached: withGaps.reached,
      reachedStrict: new Set(),
      stopReason: withGaps.stopReason,
      stats: {
        withGaps: withGaps.stats,
        strict: { visited: 0, complete: false, workspaceBytesPeak: 0 },
        complete: false,
        workspaceBytesPeak: withGaps.stats.workspaceBytesPeak,
      },
    }
  }
  const strict = await floodCooperatively(ctx, maxVisited, false, maxWorkspaceBytes, withGaps.retainedSetBytes, work)
  return {
    reached: withGaps.reached,
    reachedStrict: strict.reached,
    stopReason: strict.stopReason,
    stats: {
      withGaps: withGaps.stats,
      strict: strict.stats,
      complete: withGaps.stats.complete && strict.stats.complete,
      workspaceBytesPeak: Math.max(withGaps.stats.workspaceBytesPeak,
        withGaps.retainedSetBytes + strict.stats.workspaceBytesPeak),
    },
  }
}

/** R1 净高:可达集旁出现「净高 1 格」的通道格(自身非实心、头顶实心)→ 门洞过矮 */
function checkClearance(ctx: WalkContext, flood: FloodResult): ValidationIssue[] {
  const { doc, reg } = ctx
  const { width, height, depth } = doc.size
  const issues: ValidationIssue[] = []
  for (let y = 1; y < height - 1; y++) {
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        addWork(ctx) // one voxel considered by the clearance scan
        const at = { x, y, z }
        if (isStandableAt(ctx, at)) continue                       // 正常通道格不管
        if (blocksMovement(reg, getBlock(doc, at))) continue       // 实心不是通道
        if (!blocksMovement(reg, getBlock(doc, { x, y: y + 1, z }))) continue // 净高 ≥2,合规
        // 脚下须是真实地面,否则只是「某层的空气」,不是走得进去的矮门洞
        if (!standableSurface(reg, getBlock(doc, { x, y: y - 1, z }))) continue
        // 净高 1 格的通道格:仅当邻接可达集时才是「走得到的矮门洞」
        const touchesReached = DIRS.some(([dx, dz]) => {
          addWork(ctx) // one adjacent column checked for reachable clearance
          return flood.reached.has(key({ x: x + dx, y, z: z + dz }))
            || flood.reached.has(key({ x: x + dx, y: y - 1, z: z + dz }))
            || flood.reached.has(key({ x: x + dx, y: y + 1, z: z + dz }))
        })
        if (!touchesReached) continue
        issues.push({
          code: 'walk-clearance',
          message: `通行格净空不足 2 格(门洞/走廊过矮)`,
          at,
        })
        if (issues.length >= MAX_ISSUES) return issues
      }
    }
  }
  return issues
}

/** R5 地面完整性:存在只能经跳隙边到达的区域(reached − reachedStrict 非空)→ 主路径依赖跳跃过缺口 */
function checkGaps(ctx: WalkContext, flood: FloodResult): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const seen = new Set<string>()
  for (const k of flood.reachedStrict) {
    addWork(ctx) // one strictly reachable cell inspected for gap edges
    const [x, y, z] = k.split(',').map(Number)
    const from = { x, y, z }
    for (const edge of walkNeighbors(ctx, from)) {
      if (edge.kind !== 'gap') continue
      const tk = key(edge.to)
      if (flood.reachedStrict.has(tk) || seen.has(tk)) continue
      seen.add(tk)
      issues.push({
        code: 'walk-gap',
        message: '区域仅可由跳跃跨过缺口到达,缺少可步行的绕行路径',
        at: from,   // 缺口前格(跳隙边起点)
      })
      if (issues.length >= MAX_ISSUES) return issues
    }
  }
  return issues
}

/** 不透光(阻挡天光与方块光):实心且非半透明(玻璃/水透光) */
function isOpaque(reg: BlockRegistry, blockId: string): boolean {
  const b = reg.get(blockId)
  return !!b?.solid && !b.translucent
}

/**
 * 简化光照模型(N6,与引擎泛洪光同语义但独立实现):
 * 天光 = 每柱自顶向下 15,遇不透光截止;方块光 = emitsLight 源六邻 BFS,每格衰减 1。
 */
function approxLighting(ctx: WalkContext) {
  const { doc, reg } = ctx
  const { width, height, depth } = doc.size
  // 每柱最高的不透光格 y(柱内其上方天光 15,下方被遮)
  const topOpaque = new Int16Array(width * depth).fill(-1)
  const sources: Array<{ at: VoxelCoord; level: number }> = []
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = height - 1; y >= 0; y--) {
        addWork(ctx) // opaque-roof scan cell
        const block = getBlock(doc, { x, y, z })
        if (isOpaque(reg, block)) { topOpaque[z * width + x] = y; break }
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        addWork(ctx) // light-source scan cell
        const emits = reg.get(getBlock(doc, { x, y, z }))?.emitsLight ?? 0
        if (emits > 0) sources.push({ at: { x, y, z }, level: emits })
      }
    }
  }
  // 方块光 BFS(光源格本身可不透光,从源向六邻扩散到非透光格)
  const blockLight = new Map<string, number>()
  const queue: Array<{ at: VoxelCoord; level: number }> = []
  for (const s of sources) {
    addWork(ctx) // one emitting source admitted to the block-light queue
    blockLight.set(key(s.at), s.level)
    queue.push(s)
  }
  const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const
  for (let head = 0; head < queue.length; head++) {
    addWork(ctx) // one block-light queue item dequeued
    const { at, level } = queue[head]
    if (level <= 1) continue
    for (const [dx, dy, dz] of SIX) {
      addWork(ctx) // one six-neighbor light propagation candidate
      const n = { x: at.x + dx, y: at.y + dy, z: at.z + dz }
      if (!inBounds(doc.size, n) || isOpaque(reg, getBlock(doc, n))) continue
      const nk = key(n)
      if ((blockLight.get(nk) ?? 0) >= level - 1) continue
      blockLight.set(nk, level - 1)
      queue.push({ at: n, level: level - 1 })
    }
  }
  const skyAt = (at: VoxelCoord) => (at.y > topOpaque[at.z * width + at.x] ? 15 : 0)
  const lightAt = (at: VoxelCoord) => Math.max(skyAt(at), blockLight.get(key(at)) ?? 0)
  /** 室内判定:自该格向上,首块不透光遮挡为 structural(人造屋顶);树叶/山体不算室内 */
  const roofedByStructure = (at: VoxelCoord) => {
    for (let y = at.y + 1; y < height; y++) {
      addWork(ctx) // one cell inspected above a reached cell for an indoor roof
      const block = getBlock(doc, { x: at.x, y, z: at.z })
      if (isOpaque(reg, block)) return reg.get(block)?.category === 'structural'
    }
    return false
  }
  return { lightAt, roofedByStructure }
}

/** R3 室内照明覆盖:可达的「屋顶之下」可站立格中,光级 ≥ 阈值的占比须达标 */
function checkLighting(ctx: WalkContext, flood: FloodResult, opts: WalkabilityLightingOptions): ValidationIssue[] {
  const { lightAt, roofedByStructure } = approxLighting(ctx)
  const indoor: VoxelCoord[] = []
  for (const k of flood.reached) {
    addWork(ctx) // one reached cell checked for indoor-roof membership
    const [x, y, z] = k.split(',').map(Number)
    const at = { x, y, z }
    if (roofedByStructure(at)) indoor.push(at)
  }
  if (indoor.length === 0) return []
  let lit = 0
  let darkest = indoor[0]
  let darkestLevel = Infinity
  for (const at of indoor) {
    addWork(ctx) // one indoor cell evaluated for lighting coverage
    const level = lightAt(at)
    if (level >= opts.lightThreshold) lit++
    if (level < darkestLevel) { darkestLevel = level; darkest = at }
  }
  const coverage = lit / indoor.length
  if (coverage >= opts.lightCoverage) return []
  return [{
    code: 'walk-lighting',
    message: `室内可行走区域照明不足:${(coverage * 100).toFixed(0)}% 达标(阈值光级 ${opts.lightThreshold},要求 ${(opts.lightCoverage * 100).toFixed(0)}%)`,
    at: darkest,
  }]
}

async function checkClearanceCooperatively(ctx: WalkContext, flood: FloodResult, work: CooperativeWork): Promise<ValidationIssue[]> {
  const { doc, reg } = ctx
  const { width, height, depth } = doc.size
  const issues: ValidationIssue[] = []
  for (let y = 1; y < height - 1; y++) for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    addWork(ctx)
    const at = { x, y, z }
    if (!isStandableAt(ctx, at) && !blocksMovement(reg, getBlock(doc, at))
      && blocksMovement(reg, getBlock(doc, { x, y: y + 1, z }))
      && standableSurface(reg, getBlock(doc, { x, y: y - 1, z }))) {
      const touchesReached = DIRS.some(([dx, dz]) => {
        addWork(ctx)
        return flood.reached.has(key({ x: x + dx, y, z: z + dz }))
          || flood.reached.has(key({ x: x + dx, y: y - 1, z: z + dz }))
          || flood.reached.has(key({ x: x + dx, y: y + 1, z: z + dz }))
      })
      if (touchesReached) issues.push({ code: 'walk-clearance', message: '通行格净空不足 2 格(门洞/走廊过矮)', at })
      if (issues.length >= MAX_ISSUES) return issues
    }
    if (!await work.tick()) return issues
  }
  return issues
}

async function checkGapsCooperatively(ctx: WalkContext, flood: FloodResult, work: CooperativeWork): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  const seen = new Set<string>()
  for (const k of flood.reachedStrict) {
    addWork(ctx)
    const [x, y, z] = k.split(',').map(Number)
    for (const edge of walkNeighbors(ctx, { x, y, z })) {
      if (edge.kind !== 'gap') continue
      const targetKey = key(edge.to)
      if (flood.reachedStrict.has(targetKey) || seen.has(targetKey)) continue
      seen.add(targetKey)
      issues.push({ code: 'walk-gap', message: '区域仅可由跳跃跨过缺口到达,缺少可步行的绕行路径', at: { x, y, z } })
      if (issues.length >= MAX_ISSUES) return issues
    }
    if (!await work.tick()) return issues
  }
  return issues
}

async function checkStairsCooperatively(ctx: WalkContext, flood: FloodResult, work: CooperativeWork): Promise<ValidationIssue[]> {
  const artificial = new Set<string>()
  const objectCellExact = new Set<string>()
  for (const entry of ctx.doc.objectCells) for (const c of entry.cells) {
    addWork(ctx)
    artificial.add(key(c)); objectCellExact.add(key(c))
    for (const [dx, dz] of DIRS) { addWork(ctx); artificial.add(key({ x: c.x + dx, y: c.y, z: c.z + dz })) }
    if (!await work.tick()) return []
  }
  if (artificial.size === 0) return []
  const issues: ValidationIssue[] = []
  const reported = new Set<string>()
  for (const k of flood.reached) {
    addWork(ctx)
    const [x, y, z] = k.split(',').map(Number)
    for (const [dx, dz] of DIRS) {
      addWork(ctx)
      const nx = x + dx, nz = z + dz
      for (let ny = y + 2; ny < ctx.doc.size.height; ny++) {
        addWork(ctx)
        if (!await work.tick()) return issues
        const high = { x: nx, y: ny, z: nz }
        if (!inBounds(ctx.doc.size, high)) break
        if (!isStandableAt(ctx, high)) continue
        const highKey = key(high)
        if (flood.reached.has(highKey)) break
        if (!artificial.has(highKey) || reported.has(highKey)) continue
        if (objectCellExact.has(key({ x: nx, y: ny - 1, z: nz }))) break
        reported.add(highKey)
        issues.push({ code: 'walk-stairs', message: `人工结构台面高差 ${ny - y} 格(≥2),断级楼梯/跳不上的台面`, at: high })
        break
      }
      if (issues.length >= MAX_ISSUES) return issues
    }
    if (!await work.tick()) return issues
  }
  return issues
}

async function checkConnectivityCooperatively(ctx: WalkContext, flood: FloodResult, work: CooperativeWork): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  const cellsOf = new Map(ctx.doc.objectCells.map((entry) => [entry.objectId, entry.cells]))
  addWork(ctx, ctx.doc.objects.length + ctx.doc.locations.length)
  for (const object of boundObjects(ctx.doc)) {
    addWork(ctx)
    const cells = cellsOf.get(object.id) ?? []
    let reachable = false
    for (const c of cells) {
      const candidates: VoxelCoord[] = [{ x: c.x, y: c.y + 1, z: c.z }]
      for (const [dx, dz] of DIRS) for (const dy of [0, 1, -1]) candidates.push({ x: c.x + dx, y: c.y + dy, z: c.z + dz })
      addWork(ctx, candidates.length)
      if (candidates.some((at) => isStandableAt(ctx, at) && flood.reached.has(key(at)))) { reachable = true; break }
      if (!await work.tick()) return issues
    }
    if (!reachable) issues.push({
      code: 'walk-connectivity', message: `object '${object.id}' (${object.objectType}) 无可达站位:从室外沿可行走规则无法靠近`, at: object.anchor,
    })
    if (!await work.tick()) return issues
  }
  return issues
}

async function checkLightingCooperatively(
  ctx: WalkContext, flood: FloodResult, opts: WalkabilityLightingOptions, work: CooperativeWork,
): Promise<ValidationIssue[]> {
  const { doc, reg } = ctx
  const { width, height, depth } = doc.size
  const topOpaque = new Int16Array(width * depth).fill(-1)
  const sources: Array<{ at: VoxelCoord; level: number }> = []
  for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    for (let y = height - 1; y >= 0; y--) {
      addWork(ctx)
      const block = getBlock(doc, { x, y, z })
      if (isOpaque(reg, block)) { topOpaque[z * width + x] = y; break }
      if (!await work.tick()) return []
    }
    if (!await work.tick()) return []
  }
  for (let y = 0; y < height; y++) for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    addWork(ctx)
    const emits = reg.get(getBlock(doc, { x, y, z }))?.emitsLight ?? 0
    if (emits > 0) sources.push({ at: { x, y, z }, level: emits })
    if (!await work.tick()) return []
  }
  const blockLight = new Map<string, number>()
  const queue: Array<{ at: VoxelCoord; level: number }> = []
  for (const source of sources) {
    addWork(ctx); blockLight.set(key(source.at), source.level); queue.push(source)
    if (!await work.tick()) return []
  }
  const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const
  for (let head = 0; head < queue.length; head++) {
    addWork(ctx)
    const { at, level } = queue[head]
    if (level > 1) for (const [dx, dy, dz] of SIX) {
      addWork(ctx)
      const next = { x: at.x + dx, y: at.y + dy, z: at.z + dz }
      if (inBounds(doc.size, next) && !isOpaque(reg, getBlock(doc, next))) {
        const k = key(next)
        if ((blockLight.get(k) ?? 0) < level - 1) { blockLight.set(k, level - 1); queue.push({ at: next, level: level - 1 }) }
      }
      if (!await work.tick()) return []
    }
    if (!await work.tick()) return []
  }
  const indoor: VoxelCoord[] = []
  for (const k of flood.reached) {
    addWork(ctx)
    const [x, y, z] = k.split(',').map(Number)
    let indoorRoof = false
    for (let roofY = y + 1; roofY < height; roofY++) {
      addWork(ctx)
      const block = getBlock(doc, { x, y: roofY, z })
      if (isOpaque(reg, block)) { indoorRoof = reg.get(block)?.category === 'structural'; break }
      if (!await work.tick()) return []
    }
    if (indoorRoof) indoor.push({ x, y, z })
    if (!await work.tick()) return []
  }
  if (indoor.length === 0) return []
  let lit = 0, darkest = indoor[0], darkestLevel = Infinity
  for (const at of indoor) {
    addWork(ctx)
    const sky = at.y > topOpaque[at.z * width + at.x] ? 15 : 0
    const level = Math.max(sky, blockLight.get(key(at)) ?? 0)
    if (level >= opts.lightThreshold) lit++
    if (level < darkestLevel) { darkestLevel = level; darkest = at }
    if (!await work.tick()) return []
  }
  const coverage = lit / indoor.length
  return coverage >= opts.lightCoverage ? [] : [{
    code: 'walk-lighting',
    message: `室内可行走区域照明不足:${(coverage * 100).toFixed(0)}% 达标(阈值光级 ${opts.lightThreshold},要求 ${(opts.lightCoverage * 100).toFixed(0)}%)`,
    at: darkest,
  }]
}

/** R4 高差突变:可达格邻柱存在高差 ≥2 的可站立面,且该面属人工结构(物体占据格或其水平邻格)→ 断级楼梯/跳不上的台面 */
function checkStairs(ctx: WalkContext, flood: FloodResult): ValidationIssue[] {
  const { doc } = ctx
  // 人工结构格集:物体占据格 + 水平邻接格(排除自然山体)
  const artificial = new Set<string>()
  const objectCellExact = new Set<string>() // 物体占据格(精确,用于排除「屋顶」误判)
  for (const entry of doc.objectCells) {
    for (const c of entry.cells) {
      addWork(ctx) // one object cell added to the artificial-structure index
      artificial.add(key(c))
      objectCellExact.add(key(c))
      for (const [dx, dz] of DIRS) {
        addWork(ctx) // one horizontal neighbor added to the artificial index
        artificial.add(key({ x: c.x + dx, y: c.y, z: c.z + dz }))
      }
    }
  }
  if (artificial.size === 0) return []
  const issues: ValidationIssue[] = []
  const reported = new Set<string>()
  for (const k of flood.reached) {
    addWork(ctx) // one reached cell considered as a stair approach
    const [x, y, z] = k.split(',').map(Number)
    for (const [dx, dz] of DIRS) {
      addWork(ctx) // one neighboring column considered for a stair check
      const nx = x + dx, nz = z + dz
      // 邻柱内所有高差 ≥2 的可站立面
      for (let ny = y + 2; ny < doc.size.height; ny++) {
        addWork(ctx) // one candidate standable height checked
        const high = { x: nx, y: ny, z: nz }
        if (!inBounds(doc.size, high)) break
        if (!isStandableAt(ctx, high)) continue
        const hk = key(high)
        // 台面可经行走到达(台阶在别处)→ 合规;只拦「看得见但走不上」的人工台面
        if (flood.reached.has(hk)) break
        if (!artificial.has(hk) || reported.has(hk)) continue
        // 支撑面本身是物体占据格(屋顶/墙顶)→ 是建筑封顶而非「该走上去的台面」,豁免
        if (objectCellExact.has(key({ x: nx, y: ny - 1, z: nz }))) break
        reported.add(hk)
        issues.push({
          code: 'walk-stairs',
          message: `人工结构台面高差 ${ny - y} 格(≥2),断级楼梯/跳不上的台面`,
          at: high,
        })
        break // 同一邻柱只报最低一处
      }
      if (issues.length >= MAX_ISSUES) return issues
    }
  }
  return issues
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
  addWork(ctx, ctx.doc.objects.length + ctx.doc.locations.length) // scan objects and location bindings
  for (const object of boundObjects(ctx.doc)) {
    addWork(ctx) // one bound object checked for reachable access
    const cells = cellsOf.get(object.id) ?? []
    let reachable = false
    for (const c of cells) {
      // 候选站位:占据格四邻(同层与上下一格)与占据格正上方
      const candidates: VoxelCoord[] = [{ x: c.x, y: c.y + 1, z: c.z }]
      for (const [dx, dz] of DIRS) {
        for (const dy of [0, 1, -1]) candidates.push({ x: c.x + dx, y: c.y + dy, z: c.z + dz })
      }
      addWork(ctx, candidates.length) // all candidate standing cells checked
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
  return validateWalkabilityWithStats(doc, registry, opts).issues
}

/**
 * R2 reachability validation with explicit BFS truncation and workspace stats.
 * Work units count perimeter seed candidates, dequeued BFS cells, cardinal
 * adjacency candidates, rule-scan cells/candidates, and block-light queue and
 * propagation candidates. They are deterministic work counts, not CPU time.
 * Existing callers can continue using validateWalkability for the legacy array.
 */
export function validateWalkabilityWithStats(
  doc: VoxelDocument,
  registry?: BlockRegistry,
  opts: WalkabilityOptions = {},
): WalkabilityValidationResult {
  const options = { ...DEFAULTS, ...opts }
  options.maxVisited = Number.isFinite(options.maxVisited)
    ? Math.max(0, Math.floor(options.maxVisited))
    : DEFAULTS.maxVisited
  const reg = registry ?? createBlockRegistry(doc.theme)
  const ctx: WalkContext = { doc, reg, standableCache: new Map(), workUnits: 0 }
  const flood = floodFromOutside(ctx, options.maxVisited)
  const issues: ValidationIssue[] = [
    ...checkConnectivity(ctx, flood),          // R2
    ...checkClearance(ctx, flood),             // R1
    ...checkGaps(ctx, flood),                  // R5
    ...checkStairs(ctx, flood),                // R4
    ...checkLighting(ctx, flood, options),     // R3
  ]
  return {
    issues: issues.slice(0, MAX_ISSUES),
    complete: flood.stats.complete,
    visitedCells: flood.stats.withGaps.visited + flood.stats.strict.visited,
    workUnits: ctx.workUnits,
    workspaceBytesPeak: flood.stats.workspaceBytesPeak,
    floods: flood.stats,
  }
}

/**
 * Cooperative R04 variant used by full scene validation. It retains the legacy
 * synchronous API above for callers that do not provide a work-control context.
 */
export async function validateWalkabilityWithStatsAsync(
  doc: VoxelDocument,
  registry: BlockRegistry | undefined,
  opts: WalkabilityOptions,
  control: WalkabilityControlWithDeadline,
): Promise<WalkabilityValidationResult> {
  const options = { ...DEFAULTS, ...opts }
  options.maxVisited = Number.isFinite(options.maxVisited)
    ? Math.max(0, Math.floor(options.maxVisited))
    : DEFAULTS.maxVisited
  const maxWorkspaceBytes = Number.isFinite(options.maxWorkspaceBytes)
    ? Math.max(0, Math.floor(options.maxWorkspaceBytes!))
    : Number.POSITIVE_INFINITY
  const reg = registry ?? createBlockRegistry(doc.theme)
  const ctx: WalkContext = { doc, reg, standableCache: new Map(), workUnits: 0 }
  const work = cooperativeWork(ctx, control)
  const flood = await floodFromOutsideCooperatively(ctx, options.maxVisited, maxWorkspaceBytes, work)
  const issues: ValidationIssue[] = []
  let complete = flood.stats.complete
  if (complete && !work.stopReason) {
    for (const scan of [
      () => checkConnectivityCooperatively(ctx, flood, work),
      () => checkClearanceCooperatively(ctx, flood, work),
      () => checkGapsCooperatively(ctx, flood, work),
      () => checkStairsCooperatively(ctx, flood, work),
      () => checkLightingCooperatively(ctx, flood, options, work),
    ]) {
      issues.push(...await scan())
      if (work.stopReason) { complete = false; break }
    }
  }
  if (complete) {
    await work.tick(true)
    if (work.stopReason) complete = false
  }
  return {
    issues: issues.slice(0, MAX_ISSUES),
    complete,
    visitedCells: flood.stats.withGaps.visited + flood.stats.strict.visited,
    workUnits: ctx.workUnits,
    workspaceBytesPeak: flood.stats.workspaceBytesPeak,
    floods: flood.stats,
    stopReason: work.stopReason ?? (!flood.stats.complete ? 'visit-limit' : complete ? null : 'work-limit'),
  }
}
