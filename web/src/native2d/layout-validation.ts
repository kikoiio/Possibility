/**
 * N2D1 T11+T12：布局结构与占地校验、入口与通路连通。
 *
 * 纯函数模块，不修改传入的场景或布局：
 * - createInitialLayout：按建筑定义的 initialOrigin 生成完整初始布局。
 * - validateLayout：完整布局校验——建筑集合覆盖（缺失/多余/重复）、spaceId
 *   与建筑定义一致、原点为有限整数、占地不越界、不落在不可放置地面、
 *   不与静态阻挡/其他建筑交叠、不覆盖固定地点锚点与居民站位。
 * - validateBuildingMove：对候选移动构造新布局并复用完整校验。
 * - 连通校验（T12）：仅对 connectivityRoot 非 null 的外景空间执行——
 *   基础可通行格子减去静态阻挡与全部建筑占地得到可通行集合，确认起点
 *   仍可通行，再四方向 BFS 检查全部建筑入口与固定地点锚点/站位可达；
 *   入口被占地覆盖 → entrance_blocked，存在但不可达 → disconnected。
 *
 * 只导入 ./types 的类型；不依赖渲染、数据读取或存储。
 */

import type {
  BuildingDefinition,
  BuildingPlacement,
  GridPoint,
  LayoutState,
  MoveReason,
  MoveValidation,
  SampleScope,
  SceneDefinition,
  SpaceDefinition,
} from './types'

/** 四方向邻接（BFS 用）。 */
const DIRS: readonly GridPoint[] = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
]

function cellKey(p: GridPoint): string {
  return `${p.x},${p.z}`
}

/** 格子坐标必须是有限整数（契约约束）。 */
function isFiniteIntPoint(p: GridPoint): boolean {
  return (
    Number.isFinite(p.x) &&
    Number.isFinite(p.z) &&
    Number.isInteger(p.x) &&
    Number.isInteger(p.z)
  )
}

function inBounds(p: GridPoint, space: SpaceDefinition): boolean {
  return p.x >= 0 && p.z >= 0 && p.x < space.bounds.width && p.z < space.bounds.depth
}

function dedupeCells(cells: readonly GridPoint[]): GridPoint[] {
  const seen = new Set<string>()
  const out: GridPoint[] = []
  for (const c of cells) {
    const k = cellKey(c)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(c)
  }
  return out
}

/** 汇总 reasons 为 MoveValidation：valid 与去重后的 conflictCells。 */
function finalize(reasons: readonly MoveReason[]): MoveValidation {
  const conflictCells = dedupeCells(reasons.flatMap((r) => r.cells))
  return { valid: reasons.length === 0, conflictCells, reasons }
}

/** 空间内全部阻挡静态物件（blocksMovement）占用的绝对格子键。 */
function staticBlockedKeys(scene: SceneDefinition, space: SpaceDefinition): Set<string> {
  const keys = new Set<string>()
  for (const obj of space.staticObjects) {
    if (!obj.blocksMovement) continue
    const asset = scene.assetManifest[obj.assetId]
    if (!asset) continue
    for (const offset of asset.footprint) {
      keys.add(cellKey({ x: obj.origin.x + offset.x, z: obj.origin.z + offset.z }))
    }
  }
  return keys
}

/** 空间内受保护的固定地点锚点与居民站位（不可被建筑覆盖、须保持可达）。 */
function protectedCells(scene: SceneDefinition, spaceId: string): GridPoint[] {
  const cells: GridPoint[] = []
  for (const binding of scene.locationBindings) {
    const rep = binding.representation
    if (rep.kind !== 'outdoor' && rep.kind !== 'interior') continue
    if (rep.spaceId !== spaceId) continue
    cells.push(rep.anchor, ...rep.residentSlots)
  }
  return dedupeCells(cells)
}

/** 通过结构与空间检查的放置：可参与占地、交叠与连通计算。 */
interface ResolvedPlacement {
  readonly building: BuildingDefinition
  readonly placement: BuildingPlacement
  readonly cells: readonly GridPoint[]
}

/**
 * 从 buildings 的 initialOrigin 生成完整初始布局（每个建筑各一次）。
 * 返回全新对象，不与场景共享可变的 placement/origin 引用。
 */
export function createInitialLayout(scene: SceneDefinition, scope: SampleScope): LayoutState {
  return {
    scope,
    placements: scene.buildings.map((b) => ({
      buildingId: b.id,
      spaceId: b.spaceId,
      origin: { x: b.initialOrigin.x, z: b.initialOrigin.z },
    })),
  }
}

/**
 * 完整布局校验：结构（建筑集合/空间/整数原点）、占地（边界/地面/阻挡/
 * 交叠/锚点）与外景通路连通。返回带原因与冲突格子的 MoveValidation。
 */
export function validateLayout(scene: SceneDefinition, layout: LayoutState): MoveValidation {
  const reasons: MoveReason[] = []
  const buildingsById = new Map(scene.buildings.map((b) => [b.id, b]))
  const spaceById = new Map(scene.spaces.map((s) => [s.id, s]))

  /* 1) 建筑集合覆盖：缺失 / 重复 / 多余（未知建筑）。 */
  const counts = new Map<string, number>()
  for (const p of layout.placements) {
    counts.set(p.buildingId, (counts.get(p.buildingId) ?? 0) + 1)
  }
  for (const b of scene.buildings) {
    const count = counts.get(b.id) ?? 0
    if (count === 0) {
      reasons.push({
        code: 'missing_building',
        message: `布局缺少建筑 ${b.id} 的放置`,
        buildingId: b.id,
        cells: [],
      })
    } else if (count > 1) {
      reasons.push({
        code: 'missing_building',
        message: `建筑 ${b.id} 在布局中重复出现 ${count} 次`,
        buildingId: b.id,
        cells: [],
      })
    }
  }
  for (const p of layout.placements) {
    if (!buildingsById.has(p.buildingId)) {
      reasons.push({
        code: 'missing_building',
        message: `布局包含场景未定义的建筑 ${p.buildingId}`,
        buildingId: p.buildingId,
        cells: [],
      })
    }
  }

  /* 2) 每个 placement 的结构检查（空间一致、原点有限整数），随后解析占地。 */
  const resolved: ResolvedPlacement[] = []
  for (const p of layout.placements) {
    const building = buildingsById.get(p.buildingId)
    if (!building) continue
    if (p.spaceId !== building.spaceId) {
      reasons.push({
        code: 'missing_building',
        message: `建筑 ${p.buildingId} 的空间 ${p.spaceId} 与定义要求的 ${building.spaceId} 不一致`,
        buildingId: p.buildingId,
        cells: [],
      })
      continue
    }
    if (!isFiniteIntPoint(p.origin)) {
      reasons.push({
        code: 'invalid_asset',
        message: `建筑 ${p.buildingId} 的原点不是有限整数格子`,
        buildingId: p.buildingId,
        cells: [],
      })
      continue
    }
    const asset = scene.assetManifest[building.assetId]
    if (!asset) {
      reasons.push({
        code: 'invalid_asset',
        message: `建筑 ${p.buildingId} 引用的素材 ${building.assetId} 不在清单中`,
        buildingId: p.buildingId,
        cells: [],
      })
      continue
    }
    const cells = asset.footprint.map((o) => ({ x: p.origin.x + o.x, z: p.origin.z + o.z }))
    resolved.push({ building, placement: p, cells })
  }

  /* 3) 占地检查：越界 / 不可放置地面 / 静态阻挡 / 建筑交叠 / 锚点站位覆盖。 */
  const occupancy = new Map<string, string>() // `${spaceId}|${x},${z}` -> 先占建筑 id
  for (const r of resolved) {
    const space = spaceById.get(r.building.spaceId)
    if (!space) continue
    const walkable = new Set(space.walkableCells.map(cellKey))
    const staticBlocked = staticBlockedKeys(scene, space)
    const protectedSet = new Set(protectedCells(scene, space.id).map(cellKey))

    const outCells = r.cells.filter((c) => !inBounds(c, space))
    if (outCells.length > 0) {
      reasons.push({
        code: 'out_of_bounds',
        message: `建筑 ${r.building.id} 的占地越出空间 ${space.id} 边界`,
        buildingId: r.building.id,
        cells: dedupeCells(outCells),
      })
    }

    const unplaceable = r.cells.filter((c) => inBounds(c, space) && !walkable.has(cellKey(c)))
    if (unplaceable.length > 0) {
      reasons.push({
        code: 'collision',
        message: `建筑 ${r.building.id} 落在不可放置地面`,
        buildingId: r.building.id,
        cells: dedupeCells(unplaceable),
      })
    }

    const onStatic = r.cells.filter((c) => staticBlocked.has(cellKey(c)))
    if (onStatic.length > 0) {
      reasons.push({
        code: 'collision',
        message: `建筑 ${r.building.id} 与固定阻挡物件重叠`,
        buildingId: r.building.id,
        cells: dedupeCells(onStatic),
      })
    }

    const onProtected = r.cells.filter((c) => protectedSet.has(cellKey(c)))
    if (onProtected.length > 0) {
      reasons.push({
        code: 'collision',
        message: `建筑 ${r.building.id} 覆盖固定地点锚点或居民站位`,
        buildingId: r.building.id,
        cells: dedupeCells(onProtected),
      })
    }

    for (const c of r.cells) {
      if (!inBounds(c, space)) continue
      const key = `${space.id}|${cellKey(c)}`
      const occupant = occupancy.get(key)
      if (occupant !== undefined && occupant !== r.building.id) {
        reasons.push({
          code: 'collision',
          message: `建筑 ${r.building.id} 与建筑 ${occupant} 的占地重叠`,
          buildingId: r.building.id,
          cells: [c],
        })
      } else {
        occupancy.set(key, r.building.id)
      }
    }
  }

  /* 4) 连通校验（T12）：仅对 connectivityRoot 非 null 的外景空间。 */
  for (const space of scene.spaces) {
    const root = space.connectivityRoot
    if (!root) continue
    const walkable = new Set(space.walkableCells.map(cellKey))
    const staticBlocked = staticBlockedKeys(scene, space)
    const inSpace = resolved.filter((r) => r.building.spaceId === space.id)

    const buildingCellKeys = new Set<string>()
    for (const r of inSpace) {
      for (const c of r.cells) buildingCellKeys.add(cellKey(c))
    }

    // 可通行集合 = 基础可通行格子 − 静态阻挡 − 全部候选建筑占地。
    const passable = new Set<string>()
    for (const k of walkable) {
      if (!staticBlocked.has(k) && !buildingCellKeys.has(k)) passable.add(k)
    }

    const rootKey = cellKey(root)
    if (!passable.has(rootKey)) {
      const coveredByBuilding = buildingCellKeys.has(rootKey)
      reasons.push({
        code: coveredByBuilding ? 'entrance_blocked' : 'disconnected',
        message: coveredByBuilding
          ? `连通起点 (${root.x},${root.z}) 被建筑占地覆盖`
          : `连通起点 (${root.x},${root.z}) 不可通行`,
        buildingId: null,
        cells: [root],
      })
      continue
    }

    // 四方向 BFS：从起点标记全部可达可通行格子。
    const reached = new Set<string>([rootKey])
    const queue: GridPoint[] = [root]
    while (queue.length > 0) {
      const current = queue.shift() as GridPoint
      for (const d of DIRS) {
        const next = { x: current.x + d.x, z: current.z + d.z }
        const k = cellKey(next)
        if (!passable.has(k) || reached.has(k)) continue
        reached.add(k)
        queue.push(next)
      }
    }

    // 建筑入口：被占地/阻挡/不在可通行地面 → entrance_blocked；存在但不可达 → disconnected。
    for (const r of inSpace) {
      const entry = {
        x: r.placement.origin.x + r.building.entryOffset.x,
        z: r.placement.origin.z + r.building.entryOffset.z,
      }
      const k = cellKey(entry)
      if (!inBounds(entry, space) || !walkable.has(k) || staticBlocked.has(k)) {
        reasons.push({
          code: 'entrance_blocked',
          message: `建筑 ${r.building.id} 的入口 (${entry.x},${entry.z}) 不在可通行地面`,
          buildingId: r.building.id,
          cells: [entry],
        })
      } else if (buildingCellKeys.has(k)) {
        reasons.push({
          code: 'entrance_blocked',
          message: `建筑 ${r.building.id} 的入口 (${entry.x},${entry.z}) 被建筑占地覆盖`,
          buildingId: r.building.id,
          cells: [entry],
        })
      } else if (!reached.has(k)) {
        reasons.push({
          code: 'disconnected',
          message: `建筑 ${r.building.id} 的入口 (${entry.x},${entry.z}) 从连通起点不可达`,
          buildingId: r.building.id,
          cells: [entry],
        })
      }
    }

    // 固定地点锚点与站位：被建筑覆盖已由占地检查报告 collision，这里只查可达性。
    for (const binding of scene.locationBindings) {
      const rep = binding.representation
      if (rep.kind !== 'outdoor' && rep.kind !== 'interior') continue
      if (rep.spaceId !== space.id) continue
      for (const cell of [rep.anchor, ...rep.residentSlots]) {
        const k = cellKey(cell)
        if (buildingCellKeys.has(k)) continue
        if (!walkable.has(k) || staticBlocked.has(k)) continue
        if (!reached.has(k)) {
          reasons.push({
            code: 'disconnected',
            message: `地点 ${binding.locationKey} 的锚点/站位 (${cell.x},${cell.z}) 从连通起点不可达`,
            buildingId: null,
            cells: [cell],
          })
        }
      }
    }
  }

  return finalize(reasons)
}

/**
 * 候选移动校验：建筑不存在 → missing_building；目标非有限整数 → invalid_asset；
 * 其余对候选布局执行完整校验（结构、占地与连通）。输入布局不被修改。
 */
export function validateBuildingMove(
  scene: SceneDefinition,
  layout: LayoutState,
  buildingId: string,
  target: GridPoint,
): MoveValidation {
  const building = scene.buildings.find((b) => b.id === buildingId)
  if (!building) {
    return finalize([
      {
        code: 'missing_building',
        message: `场景不存在建筑 ${buildingId}，无法移动`,
        buildingId,
        cells: [],
      },
    ])
  }
  if (!isFiniteIntPoint(target)) {
    return finalize([
      {
        code: 'invalid_asset',
        message: `建筑 ${buildingId} 的移动目标不是有限整数格子`,
        buildingId,
        cells: [],
      },
    ])
  }

  let replaced = false
  const placements: BuildingPlacement[] = layout.placements.map((p) => {
    if (p.buildingId !== buildingId) return p
    replaced = true
    return { buildingId, spaceId: building.spaceId, origin: { x: target.x, z: target.z } }
  })
  if (!replaced) {
    placements.push({
      buildingId,
      spaceId: building.spaceId,
      origin: { x: target.x, z: target.z },
    })
  }
  return validateLayout(scene, { scope: layout.scope, placements })
}
