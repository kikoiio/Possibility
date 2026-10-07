import {
  applyEdits, createBlockRegistry, validateDocument, validateWalkability,
  type AssetManifest, type ValidationIssue, type VoxelDocument,
} from '@possibility/voxel-contract'

const MIN_SIZE = { width: 8, height: 4, depth: 8 } as const
const MAX_SIZE = { width: 256, height: 64, depth: 256 } as const
const WALK_REPAIR_LIMIT = 20
const CLEAR_BLOCK = 'air'

interface Size { width?: unknown; height?: unknown; depth?: unknown }
interface Payload { size?: Size; ops?: unknown[] }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function operationCoordinates(ops: unknown[]): Array<{ x: number; y: number; z: number }> {
  const coords: Array<{ x: number; y: number; z: number }> = []
  const add = (value: unknown) => {
    const at = value as { x?: unknown; y?: unknown; z?: unknown } | null
    if (at && finiteNumber(at.x) && finiteNumber(at.y) && finiteNumber(at.z)) {
      coords.push({ x: at.x, y: at.y, z: at.z })
    }
  }
  for (const value of ops) {
    if (!value || typeof value !== 'object') continue
    const op = value as Record<string, unknown>
    add(op.at)
    add(op.from)
    add(op.to)
    add(op.anchor)
  }
  return coords
}

function inferSize(ops: unknown[]): { width: number; height: number; depth: number } | null {
  const coords = operationCoordinates(ops)
  if (coords.length === 0) return null
  const max = coords.reduce((result, at) => ({
    x: Math.max(result.x, at.x), y: Math.max(result.y, at.y), z: Math.max(result.z, at.z),
  }), { x: 0, y: 0, z: 0 })
  return {
    width: clamp(Math.ceil(max.x + 3), MIN_SIZE.width, MAX_SIZE.width),
    height: clamp(Math.ceil(max.y + 3), MIN_SIZE.height, MAX_SIZE.height),
    depth: clamp(Math.ceil(max.z + 3), MIN_SIZE.depth, MAX_SIZE.depth),
  }
}

export function normalizePayloadSize<T extends Payload>(payload: T): { payload: T; fixes: string[] } {
  const size = payload.size
  if (size && finiteNumber(size.width) && finiteNumber(size.height) && finiteNumber(size.depth)) {
    const nextSize = {
      width: clamp(Math.round(size.width), MIN_SIZE.width, MAX_SIZE.width),
      height: clamp(Math.round(size.height), MIN_SIZE.height, MAX_SIZE.height),
      depth: clamp(Math.round(size.depth), MIN_SIZE.depth, MAX_SIZE.depth),
    }
    const changed = nextSize.width !== size.width || nextSize.height !== size.height || nextSize.depth !== size.depth
    return changed
      ? { payload: { ...payload, size: nextSize } as T, fixes: [`size:${size.width}x${size.height}x${size.depth}->${nextSize.width}x${nextSize.height}x${nextSize.depth}`] }
      : { payload, fixes: [] }
  }

  const inferred = inferSize(Array.isArray(payload.ops) ? payload.ops : [])
  if (!inferred) return { payload, fixes: [] }
  return {
    payload: { ...payload, size: inferred } as T,
    fixes: [`size:inferred->${inferred.width}x${inferred.height}x${inferred.depth}`],
  }
}

function allIssues(doc: VoxelDocument, assets?: AssetManifest): ValidationIssue[] {
  return [
    ...validateDocument(doc, undefined, assets),
    ...validateWalkability(doc, createBlockRegistry(doc.theme)),
  ]
}

function issueKey(issue: ValidationIssue): string {
  const at = issue.at ? `${issue.at.x},${issue.at.y},${issue.at.z}` : ''
  return `${issue.code}:${at}`
}

export function normalizeWorldDocument(
  document: VoxelDocument,
  assets?: AssetManifest,
): { document: VoxelDocument; fixes: string[]; repairable: boolean } {
  let current = document
  let issues = allIssues(current, assets)
  const fixes: string[] = []
  if (issues.some(issue => issue.code !== 'walk-clearance')) {
    return { document, fixes, repairable: false }
  }

  for (let iteration = 0; iteration < WALK_REPAIR_LIMIT; iteration++) {
    const clearanceIssues = issues.filter(issue => issue.code === 'walk-clearance')
    if (clearanceIssues.length === 0) return { document: current, fixes, repairable: true }

    const edits = new Map<string, { kind: 'set-block'; at: { x: number; y: number; z: number }; block: string }>()
    for (const issue of clearanceIssues) {
      if (!issue.at) return { document: current, fixes, repairable: false }
      const at = { x: issue.at.x, y: issue.at.y + 1, z: issue.at.z }
      edits.set(`${at.x},${at.y},${at.z}`, { kind: 'set-block', at, block: CLEAR_BLOCK })
    }
    const candidate = applyEdits(current, [...edits.values()]).document
    const candidateIssues = allIssues(candidate, assets)
    if (candidateIssues.some(issue => issue.code !== 'walk-clearance')) {
      return { document: current, fixes, repairable: false }
    }
    const candidateKeys = new Set(candidateIssues.map(issueKey))
    if (!clearanceIssues.some(issue => !candidateKeys.has(issueKey(issue)))) {
      return { document: current, fixes, repairable: false }
    }
    const nextCount = candidateIssues.filter(issue => issue.code === 'walk-clearance').length
    if (nextCount >= clearanceIssues.length) return { document: current, fixes, repairable: false }

    current = candidate
    issues = candidateIssues
    fixes.push(`walk-clearance:${clearanceIssues.length}->${nextCount}`)
  }

  return {
    document: current,
    fixes,
    repairable: issues.length === 0,
  }
}
