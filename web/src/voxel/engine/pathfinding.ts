import type { BlockRegistry, VoxelCoord } from '@possibility/voxel-contract'
import type { WorldModel } from './world-model'

const key = (x: number, y: number, z: number) => `${x},${y},${z}`

/** 可站立：脚下是不透明实体（或流体以外的实心），自身与头顶两格可通过 */
export function isStandable(world: WorldModel, registry: BlockRegistry, at: VoxelCoord): boolean {
  const below = registry.get(world.getBlock({ x: at.x, y: at.y - 1, z: at.z }))
  if (!below || !below.solid || below.translucent || below.category === 'fluid') return false
  const self = registry.get(world.getBlock(at))
  if (self?.solid) return false
  const above = registry.get(world.getBlock({ x: at.x, y: at.y + 1, z: at.z }))
  if (above?.solid) return false
  return true
}

/** 就近向下找一个可站立格（居民落点容错） */
export function nearestStandable(world: WorldModel, registry: BlockRegistry, at: VoxelCoord, maxDrop = 4): VoxelCoord | null {
  for (let dy = 0; dy <= maxDrop; dy++) {
    const probe = { x: at.x, y: at.y - dy, z: at.z }
    if (probe.y < 1) break
    if (isStandable(world, registry, probe)) return probe
  }
  return null
}

interface PathNode { x: number; y: number; z: number; g: number; f: number; parent: PathNode | null }

/**
 * A* 寻路：四邻移动，允许上下一级台阶。
 * 返回从 from 到 to 的站立格序列（含终点，不含起点）；无路返回 null。
 */
export function findPath(world: WorldModel, registry: BlockRegistry, from: VoxelCoord, to: VoxelCoord, maxIterations = 4000): VoxelCoord[] | null {
  const start = nearestStandable(world, registry, from)
  const goal = nearestStandable(world, registry, to)
  if (!start || !goal) return null
  if (start.x === goal.x && start.y === goal.y && start.z === goal.z) return [goal]

  const h = (x: number, y: number, z: number) => Math.abs(x - goal.x) + Math.abs(y - goal.y) + Math.abs(z - goal.z)
  const open: PathNode[] = [{ ...start, g: 0, f: h(start.x, start.y, start.z), parent: null }]
  const bestG = new Map<string, number>([[key(start.x, start.y, start.z), 0]])
  const closed = new Set<string>()
  let iterations = 0

  while (open.length > 0 && iterations++ < maxIterations) {
    let lowest = 0
    for (let i = 1; i < open.length; i++) if (open[i].f < open[lowest].f) lowest = i
    const node = open.splice(lowest, 1)[0]
    const nodeKey = key(node.x, node.y, node.z)
    if (closed.has(nodeKey)) continue
    closed.add(nodeKey)

    if (node.x === goal.x && node.y === goal.y && node.z === goal.z) {
      const path: VoxelCoord[] = []
      for (let n: PathNode | null = node; n && n.parent; n = n.parent) path.unshift({ x: n.x, y: n.y, z: n.z })
      return path
    }

    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      // 同一水平层，或上/下一级台阶
      for (const dy of [0, 1, -1] as const) {
        const nx = node.x + dx, ny = node.y + dy, nz = node.z + dz
        if (ny < 1 || ny >= world.doc.size.height) continue
        const nKey = key(nx, ny, nz)
        if (closed.has(nKey)) continue
        if (!isStandable(world, registry, { x: nx, y: ny, z: nz })) continue
        // 上台阶时头顶需有空间
        if (dy === 1) {
          const headroom = registry.get(world.getBlock({ x: node.x, y: node.y + 2, z: node.z }))
          if (headroom?.solid) continue
        }
        const g = node.g + 1
        if (g >= (bestG.get(nKey) ?? Infinity)) continue
        bestG.set(nKey, g)
        open.push({ x: nx, y: ny, z: nz, g, f: g + h(nx, ny, nz), parent: node })
      }
    }
  }
  return null
}
