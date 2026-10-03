import {
  createBlockRegistry,
  getBlock,
  type BlockRegistry,
  type VoxelCoord,
  type VoxelDocument,
} from '@possibility/voxel-contract'
import type { VoxelSpaceContext } from './space-context'

export interface InteriorClosureReport {
  hasFloor: boolean
  hasContinuousRoof: boolean
  hasClosedWallBoundary: boolean
  walkableSpawn: VoxelCoord | null
  exposedCells: VoxelCoord[]
}

export interface InteriorClosureOptions {
  /** The first-person spawn candidate. Defaults to the document centre on y=1. */
  spawn?: VoxelCoord
  /** Bottom floor layer. */
  floorY?: number
  /** Top solid roof layer. Defaults to the highest non-empty layer. */
  roofY?: number
  /** Boundary air cells intentionally left open for doors. */
  allowedOpenings?: VoxelCoord[]
  registry?: BlockRegistry
}

const DEFAULT_OPENINGS = new Set([
  '11,1,0', '12,1,0',
  '11,2,0', '12,2,0',
  '11,3,0', '12,3,0',
])

const key = (at: VoxelCoord): string => `${at.x},${at.y},${at.z}`

function isSolid(registry: BlockRegistry, blockId: string): boolean {
  const block = registry.get(blockId)
  return Boolean(block?.solid && block.category !== 'fluid')
}

function isOpaque(registry: BlockRegistry, blockId: string): boolean {
  const block = registry.get(blockId)
  return Boolean(block?.solid && block.category !== 'fluid' && !block.translucent)
}

function inBounds(doc: VoxelDocument, at: VoxelCoord): boolean {
  return at.x >= 0 && at.x < doc.size.width
    && at.y >= 0 && at.y < doc.size.height
    && at.z >= 0 && at.z < doc.size.depth
}

function isStandable(doc: VoxelDocument, registry: BlockRegistry, at: VoxelCoord): boolean {
  if (!inBounds(doc, at) || at.y < 1 || at.y + 1 >= doc.size.height) return false
  const below = getBlock(doc, { x: at.x, y: at.y - 1, z: at.z })
  const current = getBlock(doc, at)
  const above = getBlock(doc, { x: at.x, y: at.y + 1, z: at.z })
  return isSolid(registry, below) && !isSolid(registry, current) && !isSolid(registry, above)
}

/** Object placements render geometry outside the voxel collision grid. Keep walk spawns clear of nearby furniture. */
export function isSpawnClearOfObjects(doc: VoxelDocument, at: VoxelCoord, radius = 2): boolean {
  return !(doc.objects ?? []).some(({ anchor }) =>
    Math.abs(anchor.x - at.x) <= radius
    && Math.abs(anchor.z - at.z) <= radius
    && anchor.y >= at.y - 1
    && anchor.y <= at.y + 2)
}

function highestSolidLayer(doc: VoxelDocument, registry: BlockRegistry): number {
  for (let y = doc.size.height - 1; y >= 0; y--) {
    for (let z = 0; z < doc.size.depth; z++) {
      for (let x = 0; x < doc.size.width; x++) {
        if (isOpaque(registry, getBlock(doc, { x, y, z }))) return y
      }
    }
  }
  return Math.max(0, doc.size.height - 1)
}

function defaultSpawn(doc: VoxelDocument): VoxelCoord {
  return {
    x: Math.floor(doc.size.width / 2),
    y: 1,
    z: Math.floor(doc.size.depth / 2),
  }
}

function findWalkableSpawn(doc: VoxelDocument, registry: BlockRegistry, target: VoxelCoord, roofY: number): VoxelCoord | null {
  const x0 = Math.min(Math.max(Math.floor(target.x), 0), doc.size.width - 1)
  const z0 = Math.min(Math.max(Math.floor(target.z), 0), doc.size.depth - 1)
  const candidates: VoxelCoord[] = [{ x: x0, y: Math.max(1, Math.floor(target.y)), z: z0 }]
  for (let radius = 1; radius <= 6; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue
        const x = x0 + dx
        const z = z0 + dz
        if (x < 0 || x >= doc.size.width || z < 0 || z >= doc.size.depth) continue
        candidates.push({ x, y: Math.max(1, Math.floor(target.y)), z })
      }
    }
  }
  const maxSpawnY = Math.min(doc.size.height - 3, roofY - 3)
  for (const candidate of candidates) {
    for (let y = 1; y <= maxSpawnY; y++) {
      const at = { x: candidate.x, y, z: candidate.z }
      const headroom = getBlock(doc, { x: at.x, y: at.y + 2, z: at.z })
      if (isStandable(doc, registry, at) && !isSolid(registry, headroom) && isSpawnClearOfObjects(doc, at)) return at
    }
  }
  return null
}

function defaultOpenings(options: InteriorClosureOptions): Set<string> {
  return new Set(options.allowedOpenings?.map(key) ?? DEFAULT_OPENINGS)
}

/**
 * Inspect an interior document once at load/test time. The check deliberately
 * uses the contract document rather than rendered meshes, so a missing roof or
 * wall cannot be hidden by a camera angle or by toggling the sky dome.
 */
export function inspectInteriorClosure(
  document: VoxelDocument,
  context?: VoxelSpaceContext,
  options: InteriorClosureOptions = {},
): InteriorClosureReport {
  const registry = options.registry ?? createBlockRegistry(document.theme)
  if (context && context.kind !== 'interior') {
    return {
      hasFloor: false,
      hasContinuousRoof: false,
      hasClosedWallBoundary: false,
      walkableSpawn: null,
      exposedCells: [],
    }
  }

  const floorY = options.floorY ?? 0
  const roofY = options.roofY ?? highestSolidLayer(document, registry)
  const openings = defaultOpenings(options)
  const exposedCells: VoxelCoord[] = []

  let hasFloor = true
  for (let z = 1; z < document.size.depth - 1; z++) {
    for (let x = 1; x < document.size.width - 1; x++) {
      if (!isSolid(registry, getBlock(document, { x, y: floorY, z }))) {
        hasFloor = false
        exposedCells.push({ x, y: floorY, z })
      }
    }
  }

  let hasContinuousRoof = roofY > floorY
  for (let z = 0; z < document.size.depth; z++) {
    for (let x = 0; x < document.size.width; x++) {
      if (!isOpaque(registry, getBlock(document, { x, y: roofY, z }))) {
        hasContinuousRoof = false
        exposedCells.push({ x, y: roofY, z })
      }
    }
  }

  let hasClosedWallBoundary = true
  const wallTop = Math.max(floorY, roofY - 1)
  for (let y = floorY + 1; y <= wallTop; y++) {
    for (let z = 0; z < document.size.depth; z++) {
      for (const x of [0, document.size.width - 1]) {
        const at = { x, y, z }
        if (openings.has(key(at))) continue
        if (!isSolid(registry, getBlock(document, at))) {
          hasClosedWallBoundary = false
          exposedCells.push(at)
        }
      }
    }
    for (let x = 1; x < document.size.width - 1; x++) {
      for (const z of [0, document.size.depth - 1]) {
        const at = { x, y, z }
        if (openings.has(key(at))) continue
        if (!isSolid(registry, getBlock(document, at))) {
          hasClosedWallBoundary = false
          exposedCells.push(at)
        }
      }
    }
  }

  const requestedSpawn = options.spawn ?? defaultSpawn(document)
  const maxSpawnY = Math.min(document.size.height - 3, roofY - 3)
  const walkableSpawn = options.spawn
    ? (requestedSpawn.y <= maxSpawnY
      && isStandable(document, registry, requestedSpawn)
      && !isSolid(registry, getBlock(document, { x: requestedSpawn.x, y: requestedSpawn.y + 2, z: requestedSpawn.z }))
      && isSpawnClearOfObjects(document, requestedSpawn) ? requestedSpawn : null)
    : findWalkableSpawn(document, registry, requestedSpawn, roofY)

  const unique = new Map<string, VoxelCoord>()
  for (const at of exposedCells) unique.set(key(at), at)
  return {
    hasFloor,
    hasContinuousRoof,
    hasClosedWallBoundary,
    walkableSpawn,
    exposedCells: [...unique.values()].sort((a, b) => key(a).localeCompare(key(b))),
  }
}

export const inspectInterior = inspectInteriorClosure
