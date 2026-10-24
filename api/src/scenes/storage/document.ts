import {
  decodeSceneCompatibility,
  isSerializedVoxelDocument,
  isSerializedVoxelSpaces,
  type SerializedVoxelDocument,
  type SerializedVoxelSpaces,
} from '@possibility/voxel-contract'
import { timelineSceneRevisions } from '../../db/schema'
import { TimelineSceneIntegrityError, type StoredSceneDocument, type TimelineSceneRevisionRead, type TimelineSceneScope } from './types'

/** 体素系负载（单文档信封 / 多空间包）：不透明存储，不做 2D 归一化、不改写文档内版本 */
export function isVoxelScenePayload(value: unknown): value is SerializedVoxelDocument | SerializedVoxelSpaces {
  return isSerializedVoxelDocument(value) || isSerializedVoxelSpaces(value)
}

export function storedSceneThemeId(document: SerializedVoxelDocument | SerializedVoxelSpaces): string {
  return isSerializedVoxelDocument(document) ? document.theme : (document.spaces[0]?.document.theme ?? 'mist-manor')
}

function sameSpaceSet(actual: string[], expected: readonly string[]): boolean {
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length) return false
  return actual.length === expected.length && [...actual].sort().every((spaceId, index) => spaceId === [...expected].sort()[index])
}

export async function hashText(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function hashStoredDocument(document: StoredSceneDocument, revisionVersion: number): Promise<string> {
  return hashText(JSON.stringify({ document, version: revisionVersion }))
}

async function matchesLegacyMigrationHash(
  row: Pick<typeof timelineSceneRevisions.$inferSelect, 'kind' | 'validationJson' | 'contentHash'>,
  document: StoredSceneDocument,
): Promise<boolean> {
  if (row.kind !== 'legacy-migration' || !row.validationJson) return false
  try {
    const proof = JSON.parse(row.validationJson) as { mode?: unknown; sourceVersion?: unknown }
    return proof.mode === 'legacy-migration'
      && Number.isInteger(proof.sourceVersion)
      && (proof.sourceVersion as number) > 0
      && row.contentHash === await hashStoredDocument(document, proof.sourceVersion as number)
  } catch {
    return false
  }
}

export async function readTimelineRevisionRow(
  row: typeof timelineSceneRevisions.$inferSelect,
  scope: TimelineSceneScope,
  expectedSpaceIds?: readonly string[],
): Promise<TimelineSceneRevisionRead> {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.snapshotJson)
  } catch {
    throw new TimelineSceneIntegrityError('invalid-json', 'invalid-json')
  }
  const decoded = decodeSceneCompatibility(parsed)
  if (decoded.status !== 'ready') {
    const hasSpaceIssue = decoded.issues.some(issue => issue.code.includes('space'))
    throw new TimelineSceneIntegrityError(hasSpaceIssue ? 'invalid-space-set' : 'invalid-snapshot', decoded.issues[0]?.code ?? 'invalid-snapshot')
  }
  const actualSpaceIds = decoded.envelope.spaces.map(space => space.spaceId)
  if (expectedSpaceIds && !sameSpaceSet(actualSpaceIds, [...expectedSpaceIds])) {
    throw new TimelineSceneIntegrityError('invalid-space-set', 'invalid-space-set')
  }
  const expectedHash = await hashStoredDocument(parsed as StoredSceneDocument, row.version)
  const hashMatches = row.contentHash === expectedHash
    || await matchesLegacyMigrationHash(row, parsed as StoredSceneDocument)
  if (!hashMatches) {
    throw new TimelineSceneIntegrityError('hash-mismatch', 'hash-mismatch')
  }
  return {
    id: row.id,
    worldId: row.worldId,
    timelineId: row.timelineId,
    representation: row.representation,
    requestId: row.requestId,
    parentRevisionId: row.historyParentRevisionId,
    summary: row.summary,
    kind: row.kind,
    validationJson: row.validationJson,
    document: parsed as StoredSceneDocument,
    version: row.version,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
  }
}
