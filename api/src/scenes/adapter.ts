import {
  decodeSceneCompatibility,
  materializeSceneCandidate,
  serialize,
  validateDocument,
  validateWalkability,
  type EditOperation,
  type SceneIssue,
  type SerializedVoxelDocument,
  type SerializedVoxelSpaces,
  type StoredSceneDocument,
  type VoxelDocument,
} from '@possibility/voxel-contract'

export type SceneRepresentation = 'voxel' | 'native2d' | (string & {})
export type SceneAdapterErrorCode = 'unsupported-representation' | 'unknown-space' | 'invalid-snapshot'

export class SceneAdapterError extends Error {
  constructor(
    public readonly code: SceneAdapterErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SceneAdapterError'
  }
}

export interface SceneSnapshotSpace {
  spaceId: string
  document: VoxelDocument
}

/** Decoded complete scene snapshot; every declared space is available to validators and editors. */
export interface VoxelSceneSnapshot {
  representation: 'voxel'
  format: 'single' | 'spaces'
  defaultSpaceId: string
  spaces: SceneSnapshotSpace[]
  original: StoredSceneDocument
}

export interface SceneSnapshotValidationIssue {
  spaceId: string
  code: string
  message: string
}

export interface SceneAdapter {
  readonly representation: SceneRepresentation
  readonly supported: boolean
  decodeSnapshot(snapshot: unknown): VoxelSceneSnapshot
  validateSnapshot(snapshot: VoxelSceneSnapshot): SceneSnapshotValidationIssue[]
  applyLocalEdit(snapshot: unknown, input: { spaceId?: string; operations: EditOperation[] }): {
    snapshot: StoredSceneDocument
    changedSpaceId: string
    validationIssues: SceneSnapshotValidationIssue[]
  }
}

function invalidSnapshot(message: string): SceneAdapterError {
  return new SceneAdapterError('invalid-snapshot', message)
}

function decodeVoxelSnapshot(snapshot: unknown): VoxelSceneSnapshot {
  const decoded = decodeSceneCompatibility(snapshot)
  if (decoded.status !== 'ready') {
    const firstIssue: SceneIssue | undefined = decoded.issues[0]
    throw invalidSnapshot(firstIssue?.code ?? 'voxel-snapshot-invalid')
  }
  const { envelope } = decoded
  const defaultSpaceId = envelope.format === 'single'
    ? envelope.spaces[0]!.spaceId
    : (envelope.original as SerializedVoxelSpaces).defaultSpaceId
  return {
    representation: 'voxel',
    format: envelope.format,
    defaultSpaceId,
    spaces: envelope.spaces,
    original: envelope.original,
  }
}

function validateVoxelSnapshot(snapshot: VoxelSceneSnapshot): SceneSnapshotValidationIssue[] {
  return snapshot.spaces.flatMap(({ spaceId, document }) => [
    ...validateDocument(document),
    ...validateWalkability(document),
  ].map(issue => ({ spaceId, code: issue.code, message: issue.message })))
}

function replaceSpaceSnapshot(
  original: StoredSceneDocument,
  format: VoxelSceneSnapshot['format'],
  spaceId: string,
  document: VoxelDocument,
): StoredSceneDocument {
  const serialized = JSON.parse(serialize(document)) as SerializedVoxelDocument
  if (format === 'single') return serialized
  const spaces = (structuredClone(original) as SerializedVoxelSpaces).spaces
  const index = spaces.findIndex(space => space.id === spaceId)
  if (index < 0) throw new SceneAdapterError('unknown-space', 'unknown-space')
  spaces[index] = { ...spaces[index]!, document: serialized }
  return { ...(original as SerializedVoxelSpaces), spaces }
}

const voxelAdapter: SceneAdapter = {
  representation: 'voxel',
  supported: true,
  decodeSnapshot: decodeVoxelSnapshot,
  validateSnapshot: validateVoxelSnapshot,
  applyLocalEdit(snapshot, input) {
    const current = decodeVoxelSnapshot(snapshot)
    const candidate = materializeSceneCandidate(current.original, {
      kind: 'operations',
      ...(input.spaceId !== undefined ? { spaceId: input.spaceId } : {}),
      operations: input.operations,
    })
    if (candidate.status !== 'ready') {
      const firstIssue: SceneIssue | undefined = candidate.issues[0]
      if (firstIssue?.code === 'unknown-space-id' || firstIssue?.code === 'single-space-id') {
        throw new SceneAdapterError('unknown-space', 'unknown-space')
      }
      throw invalidSnapshot(firstIssue?.code ?? 'voxel-edit-invalid')
    }
    const selectedSpaceId = input.spaceId ?? candidate.envelope.spaces[0]!.spaceId
    const editedSpace = candidate.envelope.spaces.find(space => space.spaceId === selectedSpaceId)
    if (!editedSpace) throw new SceneAdapterError('unknown-space', 'unknown-space')
    const nextSnapshot = replaceSpaceSnapshot(current.original, current.format, selectedSpaceId, editedSpace.document)
    const decodedNext = decodeVoxelSnapshot(nextSnapshot)
    return {
      snapshot: nextSnapshot,
      changedSpaceId: selectedSpaceId,
      validationIssues: validateVoxelSnapshot(decodedNext),
    }
  },
}

const unsupportedAdapter: SceneAdapter = {
  representation: 'native2d',
  supported: false,
  decodeSnapshot() {
    throw new SceneAdapterError('unsupported-representation', 'unsupported-representation')
  },
  validateSnapshot() {
    throw new SceneAdapterError('unsupported-representation', 'unsupported-representation')
  },
  applyLocalEdit() {
    throw new SceneAdapterError('unsupported-representation', 'unsupported-representation')
  },
}

const adapters = new Map<string, SceneAdapter>([
  [voxelAdapter.representation, voxelAdapter],
  [unsupportedAdapter.representation, unsupportedAdapter],
])

export const voxelSceneAdapter = voxelAdapter
export const native2dSceneAdapter = unsupportedAdapter

export function getSceneAdapter(representation: SceneRepresentation): SceneAdapter {
  const adapter = adapters.get(representation)
  if (!adapter) {
    throw new SceneAdapterError('unsupported-representation', 'unsupported-representation')
  }
  return adapter
}

export function listSceneAdapterRepresentations(): SceneRepresentation[] {
  return [...adapters.keys()]
}
