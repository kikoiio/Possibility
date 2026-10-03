import type { VoxelDocument } from '@possibility/voxel-contract'

export type VoxelSpaceKind = 'exterior' | 'interior'
export type VoxelFogMode = 'outdoor' | 'indoor'

export type VoxelSpaceContext = {
  kind: VoxelSpaceKind
  skyVisible: boolean
  skyLightEnabled: boolean
  fogMode: VoxelFogMode
}

/**
 * Optional space metadata carried by newer documents or legacy envelopes.
 * The contract does not persist this field yet, so the resolver deliberately
 * accepts the narrow metadata shapes used by both forms without widening the
 * voxel document contract.
 */
export type VoxelSpaceMetadata = {
  kind?: unknown
  type?: unknown
  spaceKind?: unknown
  spaceType?: unknown
  spaceId?: unknown
  space?: { kind?: unknown; type?: unknown } | unknown
  metadata?: { kind?: unknown; type?: unknown; spaceKind?: unknown; spaceType?: unknown } | unknown
  meta?: { kind?: unknown; type?: unknown; spaceKind?: unknown; spaceType?: unknown } | unknown
}

export type VoxelSpaceDocument = Partial<VoxelDocument> & VoxelSpaceMetadata

const EXTERIOR_CONTEXT: VoxelSpaceContext = Object.freeze({
  kind: 'exterior',
  skyVisible: true,
  skyLightEnabled: true,
  fogMode: 'outdoor',
})

const INTERIOR_CONTEXT: VoxelSpaceContext = Object.freeze({
  kind: 'interior',
  skyVisible: false,
  skyLightEnabled: false,
  fogMode: 'indoor',
})

function contextFor(kind: VoxelSpaceKind): VoxelSpaceContext {
  // Return a fresh object so callers cannot mutate the shared defaults.
  return kind === 'interior' ? { ...INTERIOR_CONTEXT } : { ...EXTERIOR_CONTEXT }
}

function asKind(value: unknown): VoxelSpaceKind | undefined {
  return value === 'interior' || value === 'exterior' ? value : undefined
}

function nestedMetadata(value: unknown): VoxelSpaceMetadata | undefined {
  return typeof value === 'object' && value !== null ? value as VoxelSpaceMetadata : undefined
}

/**
 * Resolve explicit metadata before the compatibility mapping. This lets a
 * document-level declaration override an old/ambiguous space id safely.
 */
function explicitKind(document: VoxelSpaceDocument | null | undefined): VoxelSpaceKind | undefined {
  if (!document) return undefined

  for (const value of [document.spaceKind, document.spaceType]) {
    const kind = asKind(value)
    if (kind) return kind
  }

  for (const source of [nestedMetadata(document.space), nestedMetadata(document.metadata), nestedMetadata(document.meta)]) {
    if (!source) continue
    for (const value of [source.kind, source.type, source.spaceKind, source.spaceType]) {
      const kind = asKind(value)
      if (kind) return kind
    }
  }

  return undefined
}

function compatibleKind(spaceId: unknown): VoxelSpaceKind {
  if (typeof spaceId === 'string' && (spaceId === 'main-house-interior' || spaceId.endsWith('-main-house-interior'))) {
    return 'interior'
  }
  return 'exterior'
}

/**
 * Resolve the rendering semantics for a voxel space.
 *
 * Precedence is explicit document metadata, then the compatibility id mapping,
 * then the exterior default. Unknown and missing ids therefore retain the
 * existing exterior behavior.
 */
export function resolveSpaceContext(
  document?: VoxelSpaceDocument | null,
  spaceId?: string,
): VoxelSpaceContext {
  const kind = explicitKind(document) ?? compatibleKind(spaceId ?? document?.spaceId)
  return contextFor(kind)
}

/** Named alias for call sites that prefer the full resolver name. */
export const resolveVoxelSpaceContext = resolveSpaceContext
