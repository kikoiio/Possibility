import type {
  Native2dBuildingBinding,
  Native2dGridPoint,
  Native2dLayout,
  Native2dSpaceBinding,
  Native2dValidationIssue,
} from './schema'

const DIRECTIONS: readonly Native2dGridPoint[] = [
  { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 },
]

export function cellKey(point: Native2dGridPoint): string {
  return `${point.x},${point.z}`
}

export function isGridPoint(point: unknown): point is Native2dGridPoint {
  if (!point || typeof point !== 'object') return false
  const value = point as Record<string, unknown>
  return Number.isSafeInteger(value.x) && Number.isSafeInteger(value.z)
}

function inBounds(point: Native2dGridPoint, space: Native2dSpaceBinding): boolean {
  return point.x >= 0 && point.z >= 0 && point.x < space.width && point.z < space.depth
}

function occupiedCells(
  layout: Native2dLayout,
  spaceId: string,
): Map<string, string> {
  const bindings = new Map(layout.metadata.buildings.map((binding) => [binding.buildingId, binding]))
  const occupied = new Map<string, string>()
  for (const placement of layout.placements) {
    if (placement.spaceId !== spaceId) continue
    const binding = bindings.get(placement.buildingId)
    if (!binding) continue
    for (const offset of binding.footprint) {
      occupied.set(cellKey({ x: placement.origin.x + offset.x, z: placement.origin.z + offset.z }), placement.buildingId)
    }
  }
  return occupied
}

function reachable(space: Native2dSpaceBinding, blocked: ReadonlySet<string>): Set<string> {
  const root = space.connectivityRoot
  if (!root || !inBounds(root, space) || blocked.has(cellKey(root))) return new Set()
  const walkable = new Set(space.walkable.map(cellKey))
  const seen = new Set<string>([cellKey(root)])
  const queue: Native2dGridPoint[] = [root]
  for (let head = 0; head < queue.length; head += 1) {
    const point = queue[head]!
    for (const direction of DIRECTIONS) {
      const next = { x: point.x + direction.x, z: point.z + direction.z }
      const key = cellKey(next)
      if (!inBounds(next, space) || !walkable.has(key) || blocked.has(key) || seen.has(key)) continue
      seen.add(key)
      queue.push(next)
    }
  }
  return seen
}

/** Check the walkable graph after applying building footprints. */
export function validateConnectivity(layout: Native2dLayout): Native2dValidationIssue[] {
  const issues: Native2dValidationIssue[] = []
  for (const space of layout.metadata.spaces) {
    if (!space.connectivityRoot) continue
    const occupied = occupiedCells(layout, space.spaceId)
    const blocked = new Set((space.blocked ?? []).map(cellKey))
    const reachableCells = reachable(space, new Set([...blocked, ...occupied.keys()]))
    const rootKey = cellKey(space.connectivityRoot)
    if (!reachableCells.has(rootKey)) {
      issues.push({ code: 'disconnected', spaceId: space.spaceId, message: `Connectivity root is blocked in ${space.spaceId}`, cells: [space.connectivityRoot] })
      continue
    }
    for (const binding of layout.metadata.buildings.filter((item) => item.spaceId === space.spaceId)) {
      const placement = layout.placements.find((item) => item.buildingId === binding.buildingId)
      if (!placement || !binding.entry) continue
      const entry = { x: placement.origin.x + binding.entry.x, z: placement.origin.z + binding.entry.z }
      const key = cellKey(entry)
      const walkable = new Set(space.walkable.map(cellKey))
      if (!inBounds(entry, space) || !walkable.has(key) || blocked.has(key)) {
        issues.push({ code: 'entry_blocked', buildingId: binding.buildingId, spaceId: space.spaceId, message: `Entry for ${binding.buildingId} is not walkable`, cells: [entry] })
      } else if (occupied.has(key)) {
        issues.push({ code: 'entry_blocked', buildingId: binding.buildingId, spaceId: space.spaceId, message: `Entry for ${binding.buildingId} is blocked`, cells: [entry] })
      } else if (!reachableCells.has(key)) {
        issues.push({ code: 'disconnected', buildingId: binding.buildingId, spaceId: space.spaceId, message: `Entry for ${binding.buildingId} is disconnected`, cells: [entry] })
      }
    }
  }
  return issues
}

export { inBounds }
export const checkConnectivity = validateConnectivity
