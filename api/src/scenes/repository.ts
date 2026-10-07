import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import {
  decodeSceneCompatibility,
  isSerializedVoxelDocument, isSerializedVoxelSpaces,
  type SerializedVoxelDocument, type SerializedVoxelSpaces,
} from '@possibility/voxel-contract'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../db/client'
import {
  demoBaselines,
  sceneCompatibilityRequests,
  timelineSceneHeads,
  timelineSceneRevisions,
  timelines,
  worldSceneRevisions,
  worldScenes,
} from '../db/schema'
import {
  buildCloneCopyWriteProof,
  buildCommitGuardStatement,
  buildTimelineCommitGuardStatement,
  buildCommitWriteProof,
  buildInitialWriteProof,
  buildPendingSceneBindings,
  loadSceneWriteProofFacts,
  resolveSceneWritePolicy,
  type PendingSceneBindings,
  type SceneWriteProofBaseline,
  type SceneWriteAuthority,
  type SceneWriteProofFacts,
  type SceneWriteProofRequest,
} from './compatibility/write-proof'

/** 存储层文档（S2 起）:体素信封或多空间体素包;2D 场景已退役 */
export type StoredSceneDocument = SerializedVoxelDocument | SerializedVoxelSpaces

/** 体素系负载（单文档信封 / 多空间包）：不透明存储，不做 2D 归一化、不改写文档内版本 */
export function isVoxelScenePayload(value: unknown): value is SerializedVoxelDocument | SerializedVoxelSpaces {
  return isSerializedVoxelDocument(value) || isSerializedVoxelSpaces(value)
}

/** 体素系负载的主题 id（多空间包取第一个空间的主题） */
function voxelThemeId(doc: SerializedVoxelDocument | SerializedVoxelSpaces): string {
  return isSerializedVoxelDocument(doc) ? doc.theme : (doc.spaces[0]?.document.theme ?? 'mist-manor')
}
export interface StoredScene { document: StoredSceneDocument; version: number; contentHash: string; createdAt: string }
export class SceneConflict extends Error { constructor(message = '场景已被其他操作更新，请重新加载') { super(message); this.name = 'SceneConflict' } }

export interface TimelineSceneScope {
  worldId: string
  timelineId: string
  representation: string
}

export interface TimelineSceneRevisionRead extends StoredScene {
  id: string
  worldId: string
  timelineId: string
  representation: string
  requestId: string
  parentRevisionId: string | null
  summary: string
  kind: string
  validationJson: string | null
}

export type TimelineSceneIntegrityErrorCode =
  | 'unsupported-representation'
  | 'missing-head-revision'
  | 'invalid-cursor'
  | 'invalid-parent-chain'
  | 'unreconstructable-history'
  | 'invalid-json'
  | 'invalid-snapshot'
  | 'invalid-space-set'
  | 'hash-mismatch'

export class TimelineSceneIntegrityError extends Error {
  constructor(
    public readonly code: TimelineSceneIntegrityErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TimelineSceneIntegrityError'
  }
}

/**
 * A1 B29：提交用途命名空间 = kind + 兼容审计 purpose + 草稿身份。
 * 执行租约字段（attempt/leaseToken）不参与：崩溃后以新 attempt 重试同一确认
 * 仍属同一用途，应命中重放；普通编辑与兼容请求同 requestId 则明确拒绝。
 */
function auditNamespace(compatibilityJson: string | null | undefined): { purpose: string | null; draftId: string | null } {
  if (!compatibilityJson) return { purpose: null, draftId: null }
  try {
    const audit = JSON.parse(compatibilityJson) as { purpose?: unknown; draftId?: unknown }
    return {
      purpose: typeof audit.purpose === 'string' ? audit.purpose : null,
      draftId: typeof audit.draftId === 'string' ? audit.draftId : null,
    }
  } catch { return { purpose: null, draftId: null } }
}

function proofRequestDraftId(validationJson: string | null | undefined): string | null {
  if (!validationJson) return null
  try {
    const proof = JSON.parse(validationJson) as { request?: { draftId?: unknown } | null }
    return typeof proof.request?.draftId === 'string' ? proof.request.draftId : null
  } catch { return null }
}

function commitNamespaceKey(parts: { kind: string; purpose: string | null; draftId: string | null }): string {
  return JSON.stringify([parts.kind, parts.purpose, parts.draftId])
}

function commitInputNamespace(input: { kind: string; compatibilityJson?: string | null; compatibility?: SceneWriteProofRequest }): string {
  const audit = auditNamespace(input.compatibilityJson)
  return commitNamespaceKey({ kind: input.kind, purpose: audit.purpose, draftId: input.compatibility?.draftId ?? audit.draftId })
}

function commitRowNamespace(row: { kind: string; compatibilityJson: string | null; validationJson: string | null }): string {
  const audit = auditNamespace(row.compatibilityJson)
  return commitNamespaceKey({ kind: row.kind, purpose: audit.purpose, draftId: proofRequestDraftId(row.validationJson) ?? audit.draftId })
}

async function hashText(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/** 文档哈希：体素系负载对（文档 + 目标修订版本）整体哈希（version 是格式版本，恒 1） */
export async function hashStoredDocument(document: StoredSceneDocument, version: number): Promise<string> {
  return hashText(JSON.stringify({ document, version }))
}

function assertTimelineVoxelScope(scope: TimelineSceneScope): void {
  if (scope.representation !== 'voxel') {
    throw new TimelineSceneIntegrityError('unsupported-representation', 'unsupported-representation')
  }
}

function sameSpaceSet(actual: string[], expected: readonly string[]): boolean {
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length) return false
  return actual.length === expected.length && [...actual].sort().every((spaceId, index) => spaceId === [...expected].sort()[index])
}

async function readTimelineRevisionRow(
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
  let hashMatches = row.contentHash === expectedHash
  // 0038 keeps the source world's hash while creating a new v1 timeline root.
  // Accept that provenance-bound hash only when the migration proof names the
  // original revision version; all ordinary timeline revisions use their own version.
  if (!hashMatches && row.kind === 'legacy-migration' && row.validationJson) {
    try {
      const proof = JSON.parse(row.validationJson) as { mode?: unknown; sourceVersion?: unknown }
      if (proof.mode === 'legacy-migration' && Number.isInteger(proof.sourceVersion) && (proof.sourceVersion as number) > 0) {
        hashMatches = row.contentHash === await hashStoredDocument(parsed as StoredSceneDocument, proof.sourceVersion as number)
      }
    } catch { /* malformed provenance is handled as a hash mismatch below */ }
  }
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

/** Read the current X1 head without consulting the legacy world-scoped pointer. */
export async function readTimelineSceneHead(db: Db, scope: TimelineSceneScope) {
  assertTimelineVoxelScope(scope)
  return db.select().from(timelineSceneHeads).where(and(
    eq(timelineSceneHeads.worldId, scope.worldId),
    eq(timelineSceneHeads.timelineId, scope.timelineId),
    eq(timelineSceneHeads.representation, scope.representation),
  )).get()
}

/** Read the current complete X1 revision for one world/timeline/representation scope. */
export async function readCurrentTimelineScene(
  db: Db,
  scope: TimelineSceneScope,
  expectedSpaceIds?: readonly string[],
): Promise<TimelineSceneRevisionRead | null> {
  const head = await readTimelineSceneHead(db, scope)
  if (!head) return null
  const row = await db.select().from(timelineSceneRevisions).where(and(
    eq(timelineSceneRevisions.id, head.currentRevisionId),
    eq(timelineSceneRevisions.worldId, scope.worldId),
    eq(timelineSceneRevisions.timelineId, scope.timelineId),
    eq(timelineSceneRevisions.representation, scope.representation),
    eq(timelineSceneRevisions.version, head.currentVersion),
  )).get()
  if (!row) throw new TimelineSceneIntegrityError('missing-head-revision', 'missing-head-revision')
  return readTimelineRevisionRow(row, scope, expectedSpaceIds)
}

/** Read one X1 revision by scoped version; no legacy fallback is performed. */
export async function readTimelineSceneVersion(
  db: Db,
  scope: TimelineSceneScope,
  version: number,
  expectedSpaceIds?: readonly string[],
): Promise<TimelineSceneRevisionRead | null> {
  assertTimelineVoxelScope(scope)
  const row = await db.select().from(timelineSceneRevisions).where(and(
    eq(timelineSceneRevisions.worldId, scope.worldId),
    eq(timelineSceneRevisions.timelineId, scope.timelineId),
    eq(timelineSceneRevisions.representation, scope.representation),
    eq(timelineSceneRevisions.version, version),
  )).get()
  return row ? readTimelineRevisionRow(row, scope, expectedSpaceIds) : null
}

/** Read one X1 revision by scoped idempotency request; no cross-scope lookup is allowed. */
export async function readTimelineSceneRequest(
  db: Db,
  scope: TimelineSceneScope,
  requestId: string,
  expectedSpaceIds?: readonly string[],
): Promise<TimelineSceneRevisionRead | null> {
  assertTimelineVoxelScope(scope)
  const row = await db.select().from(timelineSceneRevisions).where(and(
    eq(timelineSceneRevisions.worldId, scope.worldId),
    eq(timelineSceneRevisions.timelineId, scope.timelineId),
    eq(timelineSceneRevisions.representation, scope.representation),
    eq(timelineSceneRevisions.requestId, requestId),
  )).get()
  return row ? readTimelineRevisionRow(row, scope, expectedSpaceIds) : null
}

/** Public integrity probe used by migration and repository tests without a database read. */
export async function validateTimelineSceneRevision(
  row: typeof timelineSceneRevisions.$inferSelect,
  scope: TimelineSceneScope,
  expectedSpaceIds?: readonly string[],
): Promise<TimelineSceneRevisionRead> {
  assertTimelineVoxelScope(scope)
  if (row.worldId !== scope.worldId || row.timelineId !== scope.timelineId || row.representation !== scope.representation) {
    throw new TimelineSceneIntegrityError('missing-head-revision', 'missing-head-revision')
  }
  return readTimelineRevisionRow(row, scope, expectedSpaceIds)
}

/** A revision returned by the lineage reader, with its visibility provenance. */
export interface TimelineSceneHistoryRevision extends TimelineSceneRevisionRead {
  /** `current` belongs to the selected line; `ancestor` is before a fork boundary. */
  source: 'current' | 'ancestor'
  sourceTimelineId: string
  /** True when this row is the first row inherited from its immediate parent line. */
  isForkBoundary: boolean
}

export interface TimelineSceneHistoryBoundary {
  fromTimelineId: string
  toTimelineId: string
  revisionId: string
}

export interface TimelineSceneHistoryPage {
  /** Newest first: selected line revisions followed by each ancestor at its cutoff. */
  revisions: TimelineSceneHistoryRevision[]
  /** Alias for callers that use the generic page vocabulary. */
  items: TimelineSceneHistoryRevision[]
  nextCursor: string | null
  hasMore: boolean
  boundaries: TimelineSceneHistoryBoundary[]
}

export interface TimelineSceneHistoryOptions {
  limit?: number
  cursor?: string | null
  /** Start at this revision on the selected line and omit newer rows. */
  cutoffRevisionId?: string
  /** Equivalent version form of cutoffRevisionId for the selected line. */
  cutoffVersion?: number
}

function historyError(
  code: 'invalid-cursor' | 'invalid-parent-chain' | 'unreconstructable-history',
  message: string,
  details?: Record<string, unknown>,
): TimelineSceneIntegrityError {
  const error = new TimelineSceneIntegrityError(code, message)
  if (details) Object.assign(error, { details })
  return error
}

function normalizeHistoryOptions(
  options: TimelineSceneHistoryOptions | number | undefined,
  positionalCursor?: string | null,
): TimelineSceneHistoryOptions {
  if (typeof options === 'number') return { limit: options, cursor: positionalCursor }
  return { ...(options ?? {}), ...(positionalCursor !== undefined ? { cursor: positionalCursor } : {}) }
}

function boundedHistoryLimit(value: number | undefined): number {
  if (value === undefined) return 30
  if (!Number.isFinite(value)) return 30
  return Math.max(1, Math.min(100, Math.trunc(value)))
}

/**
 * Read the selected line's scene history, then follow its immutable parent
 * revision at every fork boundary. Parent rows are always fetched with the
 * selected world and representation in the predicate. This keeps sibling
 * lines and timelines from another world out even when a corrupt row points
 * at an otherwise valid revision id.
 */
export async function listTimelineSceneHistory(
  db: Db,
  scope: TimelineSceneScope,
  options?: TimelineSceneHistoryOptions | number,
  positionalCursor?: string | null,
): Promise<TimelineSceneHistoryPage | null> {
  assertTimelineVoxelScope(scope)
  const requested = normalizeHistoryOptions(options, positionalCursor)
  const limit = boundedHistoryLimit(requested.limit)

  const selectedTimeline = await db.select().from(timelines).where(and(
    eq(timelines.id, scope.timelineId),
    eq(timelines.worldId, scope.worldId),
  )).get()
  if (!selectedTimeline) return null

  // Resolve actual parent links rather than trusting ancestorIdsJson. A
  // missing parent or a cycle means the historical scene cannot be rebuilt.
  const timelineById = new Map<string, typeof timelines.$inferSelect>()
  const seenTimelines = new Set<string>()
  let line = selectedTimeline
  while (true) {
    if (seenTimelines.has(line.id)) {
      throw historyError('unreconstructable-history', 'timeline-parent-cycle', { timelineId: line.id })
    }
    seenTimelines.add(line.id)
    timelineById.set(line.id, line)
    if (!line.parentTimelineId) break
    const parent = await db.select().from(timelines).where(and(
      eq(timelines.id, line.parentTimelineId),
      eq(timelines.worldId, scope.worldId),
    )).get()
    if (!parent) {
      throw historyError('unreconstructable-history', 'timeline-parent-missing', {
        timelineId: line.id,
        parentTimelineId: line.parentTimelineId,
      })
    }
    line = parent
  }

  if (requested.cursor !== undefined && requested.cursor !== null && (typeof requested.cursor !== 'string' || !requested.cursor.trim())) {
    throw historyError('invalid-cursor', 'scene-history-cursor-invalid')
  }
  if (requested.cutoffRevisionId !== undefined && !requested.cutoffRevisionId.trim()) {
    throw historyError('invalid-cursor', 'scene-cutoff-revision-invalid')
  }
  if (requested.cutoffVersion !== undefined && (!Number.isSafeInteger(requested.cutoffVersion) || requested.cutoffVersion < 1)) {
    throw historyError('invalid-cursor', 'scene-cutoff-version-invalid', { cutoffVersion: requested.cutoffVersion })
  }

  const head = await readTimelineSceneHead(db, scope)
  if (!head) {
    if (requested.cursor) throw historyError('invalid-cursor', 'scene-history-cursor-unknown', { cursor: requested.cursor })
    if (requested.cutoffRevisionId) throw historyError('invalid-cursor', 'scene-cutoff-not-on-current-line', { cutoffRevisionId: requested.cutoffRevisionId })
    if (requested.cutoffVersion !== undefined) throw historyError('invalid-cursor', 'scene-cutoff-version-not-found', { cutoffVersion: requested.cutoffVersion })
    return { revisions: [], items: [], nextCursor: null, hasMore: false, boundaries: [] }
  }
  type RevisionMeta = Pick<typeof timelineSceneRevisions.$inferSelect,
    'id' | 'worldId' | 'timelineId' | 'representation' | 'version' | 'historyParentRevisionId'>
  const readMeta = (revisionId: string) => db.select({
    id: timelineSceneRevisions.id,
    worldId: timelineSceneRevisions.worldId,
    timelineId: timelineSceneRevisions.timelineId,
    representation: timelineSceneRevisions.representation,
    version: timelineSceneRevisions.version,
    historyParentRevisionId: timelineSceneRevisions.historyParentRevisionId,
  }).from(timelineSceneRevisions).where(and(
    eq(timelineSceneRevisions.id, revisionId),
    eq(timelineSceneRevisions.worldId, scope.worldId),
    eq(timelineSceneRevisions.representation, scope.representation),
    inArray(timelineSceneRevisions.timelineId, [...timelineById.keys()]),
  )).get()
  const headRow = await db.select({
    id: timelineSceneRevisions.id,
    worldId: timelineSceneRevisions.worldId,
    timelineId: timelineSceneRevisions.timelineId,
    representation: timelineSceneRevisions.representation,
    version: timelineSceneRevisions.version,
    historyParentRevisionId: timelineSceneRevisions.historyParentRevisionId,
  }).from(timelineSceneRevisions).where(and(
    eq(timelineSceneRevisions.id, head.currentRevisionId),
    eq(timelineSceneRevisions.worldId, scope.worldId),
    eq(timelineSceneRevisions.timelineId, scope.timelineId),
    eq(timelineSceneRevisions.representation, scope.representation),
    eq(timelineSceneRevisions.version, head.currentVersion),
  )).get()
  if (!headRow) throw new TimelineSceneIntegrityError('missing-head-revision', 'missing-head-revision')

  // Walk only immutable parent pointers needed to seek and fill this page. The
  // metadata query omits snapshot_json; at most limit+1 snapshots are decoded.
  const selected: Array<{ revision: TimelineSceneRevisionRead; sourceTimelineId: string; source: 'current' | 'ancestor';
    isForkBoundary: boolean; boundary?: TimelineSceneHistoryBoundary }> = []
  const seenRevisions = new Set<string>()
  let row = headRow
  let previousTimelineId: string | null = null
  let foundCutoff = requested.cutoffRevisionId === undefined && requested.cutoffVersion === undefined
  let foundCursor = requested.cursor === undefined || requested.cursor === null
  while (true) {
    if (seenRevisions.has(row.id)) {
      throw historyError('unreconstructable-history', 'scene-parent-cycle', { revisionId: row.id })
    }
    seenRevisions.add(row.id)
    if (row.worldId !== scope.worldId || row.representation !== scope.representation || !timelineById.has(row.timelineId)) {
      throw historyError('invalid-parent-chain', 'scene-parent-out-of-scope', { revisionId: row.id, timelineId: row.timelineId })
    }
    const crossedBoundary = previousTimelineId !== null && previousTimelineId !== row.timelineId
    if (crossedBoundary) {
      const owner = timelineById.get(previousTimelineId!)
      if (!owner || owner.parentTimelineId !== row.timelineId) {
        throw historyError('invalid-parent-chain', 'scene-parent-not-immediate-ancestor', {
          revisionId: row.id, timelineId: previousTimelineId, parentTimelineId: row.timelineId,
        })
      }
    }

    const isCutoff = row.timelineId === scope.timelineId
      && (requested.cutoffRevisionId !== undefined ? row.id === requested.cutoffRevisionId
        : requested.cutoffVersion !== undefined ? row.version === requested.cutoffVersion : false)
    if (isCutoff) foundCutoff = true
    const isCursor = requested.cursor != null && row.id === requested.cursor
    if (isCursor) {
      if (!foundCutoff) throw historyError('invalid-cursor', 'scene-history-cursor-before-cutoff', { cursor: requested.cursor })
      foundCursor = true
    }
    if (foundCutoff && foundCursor && !isCursor) {
      const source = row.timelineId === scope.timelineId ? 'current' : 'ancestor'
      const fullRow = await db.select().from(timelineSceneRevisions).where(and(
        eq(timelineSceneRevisions.id, row.id),
        eq(timelineSceneRevisions.worldId, scope.worldId),
        eq(timelineSceneRevisions.timelineId, row.timelineId),
        eq(timelineSceneRevisions.representation, scope.representation),
      )).get()
      if (!fullRow) throw new TimelineSceneIntegrityError('missing-head-revision', 'missing-head-revision')
      // Decoding validates only snapshots returned by this page plus its one
      // lookahead row, rather than every older immutable revision.
      const revision = await readTimelineRevisionRow(fullRow, { worldId: scope.worldId, timelineId: row.timelineId, representation: scope.representation })
      selected.push({ revision, sourceTimelineId: row.timelineId, source, isForkBoundary: crossedBoundary,
        ...(crossedBoundary ? { boundary: { fromTimelineId: previousTimelineId!, toTimelineId: row.timelineId, revisionId: row.id } } : {}) })
      if (selected.length > limit) {
        break
      }
    }
    previousTimelineId = row.timelineId

    const parentRevisionId = row.historyParentRevisionId
    if (!parentRevisionId) {
      const owner = timelineById.get(row.timelineId)!
      if (owner.parentTimelineId) {
        throw historyError('unreconstructable-history', 'scene-parent-revision-missing', {
          revisionId: row.id,
          timelineId: row.timelineId,
          parentTimelineId: owner.parentTimelineId,
        })
      }
      break
    }

    const parent = await readMeta(parentRevisionId)
    if (!parent) {
      throw historyError('unreconstructable-history', 'scene-parent-revision-missing', {
        revisionId: row.id,
        parentRevisionId,
        timelineId: row.timelineId,
      })
    }
    if (!timelineById.has(parent.timelineId)) {
      throw historyError('invalid-parent-chain', 'scene-parent-timeline-out-of-lineage', {
        revisionId: row.id,
        parentRevisionId,
        parentTimelineId: parent.timelineId,
      })
    }
    if (parent.timelineId === row.timelineId && parent.version >= row.version) {
      throw historyError('invalid-parent-chain', 'scene-parent-version-not-older', {
        revisionId: row.id,
        parentRevisionId,
        version: row.version,
        parentVersion: parent.version,
      })
    }
    if (parent.timelineId !== row.timelineId) {
      const owner = timelineById.get(row.timelineId)!
      if (owner.parentTimelineId !== parent.timelineId) {
        throw historyError('invalid-parent-chain', 'scene-parent-not-immediate-ancestor', {
          revisionId: row.id,
          parentRevisionId,
          timelineId: row.timelineId,
          parentTimelineId: parent.timelineId,
        })
      }
    }
    row = parent
  }

  if (!foundCutoff) {
    if (requested.cutoffRevisionId !== undefined) throw historyError('invalid-cursor', 'scene-cutoff-not-on-current-line', { cutoffRevisionId: requested.cutoffRevisionId })
    throw historyError('invalid-cursor', 'scene-cutoff-version-not-found', { cutoffVersion: requested.cutoffVersion })
  }
  if (!foundCursor) throw historyError('invalid-cursor', 'scene-history-cursor-unknown', { cursor: requested.cursor })
  const pageRows = selected.slice(0, limit)
  const visible: TimelineSceneHistoryRevision[] = pageRows.map(item => ({
    ...item.revision, source: item.source, sourceTimelineId: item.sourceTimelineId, isForkBoundary: item.isForkBoundary,
  }))
  const hasMore = selected.length > limit
  const boundaries = pageRows.flatMap(item => item.boundary ? [item.boundary] : [])
  return {
    revisions: visible,
    items: visible,
    nextCursor: hasMore ? visible[visible.length - 1]!.id : null,
    hasMore,
    boundaries,
  }
}

/** Semantic aliases used by map/history callers. */
export const readTimelineSceneHistory = listTimelineSceneHistory
export const queryTimelineSceneHistory = listTimelineSceneHistory
export const readTimelineSceneLineage = listTimelineSceneHistory
export const listTimelineSceneRevisions = listTimelineSceneHistory

export type TimelineSceneCommitInput = {
  expectedVersion: number
  requestId: string
  document: StoredSceneDocument
  summary: string
  kind: string
  /** Explicit fork boundary. When omitted for a child first commit, the parent head is used. */
  parentRevisionId?: string | null
  authority?: SceneWriteAuthority
  compatibility?: SceneWriteProofRequest
  compatibilityCompletion?: { actorKey: string }
  compatibilityJson?: string | null
  allowBaseline?: boolean
} & ({ scope: TimelineSceneScope } | { worldId: string; timelineId: string; representation?: string })

function commitScope(input: TimelineSceneCommitInput): TimelineSceneScope {
  if ('scope' in input) return input.scope
  return { worldId: input.worldId, timelineId: input.timelineId, representation: input.representation ?? 'voxel' }
}

export class TimelineSceneConflict extends SceneConflict {
  constructor(
    message: string,
    public readonly expectedVersion: number,
    public readonly currentVersion: number,
    public readonly currentRevisionId: string | null,
  ) {
    super(message)
    this.name = 'TimelineSceneConflict'
  }
}

function assertCommitInput(input: TimelineSceneCommitInput): void {
  assertTimelineVoxelScope(commitScope(input))
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new TimelineSceneConflict('场景版本参数无效，请刷新后重试', input.expectedVersion, 0, null)
  }
  if (!input.requestId.trim() || input.requestId.length > 200) {
    throw new SceneConflict('场景请求 ID 无效')
  }
}

async function readTimelineHeadConflict(db: Db, scope: TimelineSceneScope, expectedVersion: number): Promise<TimelineSceneConflict> {
  const current = await readTimelineSceneHead(db, scope)
  return new TimelineSceneConflict(
    '场景已被其他操作更新，请刷新当前时间线后重试',
    expectedVersion,
    current?.currentVersion ?? 0,
    current?.currentRevisionId ?? null,
  )
}

/** Resolve the immutable parent snapshot at a child timeline's creation time. */
async function readTimelineForkSnapshot(
  db: Db,
  parentScope: TimelineSceneScope,
  childCreatedAt: string,
): Promise<TimelineSceneHistoryRevision | null> {
  let cursor: string | null = null
  let fallback: TimelineSceneHistoryRevision | null = null
  while (true) {
    const page = await listTimelineSceneHistory(db, parentScope, { limit: 100, cursor })
    if (!page) return null
    for (const revision of page.revisions) {
      fallback = revision
      if (revision.createdAt <= childCreatedAt) return revision
    }
    if (!page.hasMore || !page.nextCursor) return fallback
    cursor = page.nextCursor
  }
}

/**
 * Commit an immutable timeline scene revision with a version CAS. The first
 * head update reserves the expected next version inside the same D1 batch;
 * inserting the revision then makes the reservation valid. A concurrent stale
 * writer either loses that conditional update or hits the scoped version
 * uniqueness constraint, so it cannot leave an orphan revision behind.
 */
export async function commitTimelineScene(db: Db, input: TimelineSceneCommitInput): Promise<TimelineSceneRevisionRead> {
  assertCommitInput(input)
  const scope = commitScope(input)
  if ('worldId' in input && input.worldId !== scope.worldId) throw new SceneConflict('场景作用域不一致')
  const timeline = await db.select().from(timelines).where(and(
    eq(timelines.id, scope.timelineId), eq(timelines.worldId, scope.worldId),
  )).get()
  if (!timeline) throw new SceneConflict('时间线不存在，请刷新后重试')
  if (timeline.status !== 'active') throw new SceneConflict('归档时间线只支持查看历史，不能编辑或恢复')
  const baseline = await db.select({ id: demoBaselines.id }).from(demoBaselines)
    .where(and(eq(demoBaselines.worldId, scope.worldId), eq(demoBaselines.status, 'active'))).get()
  if (baseline && !input.allowBaseline) throw new SceneConflict('公共演示基线只读，请先进入访客体验副本')
  const decoded = decodeSceneCompatibility(input.document)
  if (decoded.status !== 'ready') throw new TimelineSceneIntegrityError('invalid-snapshot', decoded.issues[0]?.code ?? 'invalid-snapshot')
  const requestedHash = await hashStoredDocument(input.document, input.expectedVersion + 1)
  // Idempotency is about the request payload, not the caller's stale version.
  // A conflict refresh may legitimately retry the same request with a newer
  // expectedVersion, while the persisted content hash remains version-bound.
  const requestedPayloadHash = await hashText(JSON.stringify(input.document))
  const prior = await db.select().from(timelineSceneRevisions).where(and(
    eq(timelineSceneRevisions.worldId, scope.worldId),
    eq(timelineSceneRevisions.timelineId, scope.timelineId),
    eq(timelineSceneRevisions.representation, scope.representation),
    eq(timelineSceneRevisions.requestId, input.requestId),
  )).get()
  if (prior) {
    const storedAudit = prior.validationJson ? JSON.parse(prior.validationJson).audit : null
    if (commitRowNamespace({ kind: prior.kind, compatibilityJson: storedAudit ? JSON.stringify(storedAudit) : null, validationJson: prior.validationJson }) !== commitInputNamespace(input)) throw new SceneConflict('同一 request ID 已用于其他场景用途')
    const priorDocument = JSON.parse(prior.snapshotJson) as StoredSceneDocument
    const priorPayloadHash = await hashText(JSON.stringify(priorDocument))
    if (priorPayloadHash !== requestedPayloadHash) {
      throw new SceneConflict('同一 request ID 不能提交不同场景内容')
    }
    return readTimelineRevisionRow(prior, scope)
  }

  const head = await readTimelineSceneHead(db, scope)
  const actual = head?.currentVersion ?? 0
  if (actual !== input.expectedVersion) throw await readTimelineHeadConflict(db, scope, input.expectedVersion)
  const version = actual + 1
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const proof = await buildCommitWriteProof(db, { worldId: scope.worldId, scope,
    candidate: { version, contentHash: requestedHash }, ...(input.compatibility ? { compatibility: input.compatibility } : {}) })
  // Ordinary edits always extend the selected line's current head. Only a
  // first child revision may explicitly choose its fork boundary parent.
  let parentRevisionId = head ? head.currentRevisionId : (input.parentRevisionId ?? null)
  if (!head && parentRevisionId === null && timeline.parentTimelineId) {
    const parentScope: TimelineSceneScope = {
      worldId: scope.worldId,
      timelineId: timeline.parentTimelineId,
      representation: scope.representation,
    }
    const parentSnapshot = await readTimelineForkSnapshot(db, parentScope, timeline.createdAt)
    if (!parentSnapshot) throw new TimelineSceneIntegrityError('unreconstructable-history', 'scene-parent-head-missing')
    parentRevisionId = parentSnapshot.id
  }
  if (parentRevisionId) {
    const parent = await db.select().from(timelineSceneRevisions).where(and(
      eq(timelineSceneRevisions.id, parentRevisionId),
      eq(timelineSceneRevisions.worldId, scope.worldId),
      eq(timelineSceneRevisions.representation, scope.representation),
    )).get()
    if (!parent) throw new TimelineSceneIntegrityError('unreconstructable-history', 'scene-parent-revision-missing')
    if (parent.timelineId !== scope.timelineId && parent.timelineId !== timeline.parentTimelineId) {
      throw new TimelineSceneIntegrityError('invalid-parent-chain', 'scene-parent-not-immediate-ancestor')
    }
  }
  const row = {
    id,
    worldId: scope.worldId,
    timelineId: scope.timelineId,
    representation: scope.representation,
    version,
    historyParentRevisionId: parentRevisionId,
    requestId: input.requestId,
    contentHash: requestedHash,
    snapshotJson: JSON.stringify(structuredClone(input.document)),
    summary: input.summary,
    kind: input.kind,
    validationJson: JSON.stringify({ ...proof, scope, ...(input.compatibilityJson ? { audit: JSON.parse(input.compatibilityJson) } : {}) }),
    createdAt: now,
  } satisfies typeof timelineSceneRevisions.$inferInsert

  // Main-line compatibility reads share the same transaction. Child timelines
  // never write the world-level pointer, preserving branch isolation.
  const legacyWrites = timeline.parentTimelineId === null
    ? await scopedMainLegacyStatements(db, { scope, input, createdAt: now }) : []
  try {
    const guard = buildTimelineCommitGuardStatement(db, { scope, revisionId: id, version,
      requestId: input.requestId, proof, authority: input.authority, compatibility: input.compatibility,
      compatibilityCompletion: input.compatibilityCompletion })
    const complete = input.compatibility && input.compatibilityCompletion
      ? db.update(sceneCompatibilityRequests).set({ state: 'completed', resultVersion: version,
        leaseToken: null, leaseUntil: null, updatedAt: now }).where(and(
        eq(sceneCompatibilityRequests.worldId, scope.worldId), eq(sceneCompatibilityRequests.requestId, input.requestId),
        eq(sceneCompatibilityRequests.actorKey, input.compatibilityCompletion.actorKey),
        eq(sceneCompatibilityRequests.attempt, input.compatibility.attempt),
        eq(sceneCompatibilityRequests.leaseToken, input.compatibility.leaseToken))) : null
    if (head) {
      // The old revision id remains a valid FK while this transaction reserves
      // the version; the following insert and pointer update are atomic.
      await db.batch([
        db.update(timelineSceneHeads).set({ currentVersion: version, updatedAt: now }).where(and(
          eq(timelineSceneHeads.worldId, scope.worldId),
          eq(timelineSceneHeads.timelineId, scope.timelineId),
          eq(timelineSceneHeads.representation, scope.representation),
          eq(timelineSceneHeads.currentRevisionId, head.currentRevisionId),
          eq(timelineSceneHeads.currentVersion, input.expectedVersion),
        )),
        db.insert(timelineSceneRevisions).values(row),
        db.update(timelineSceneHeads).set({ currentRevisionId: id, currentVersion: version, updatedAt: now }).where(and(
          eq(timelineSceneHeads.worldId, scope.worldId),
          eq(timelineSceneHeads.timelineId, scope.timelineId),
          eq(timelineSceneHeads.representation, scope.representation),
          eq(timelineSceneHeads.currentVersion, version),
        )),
        ...legacyWrites,
        guard,
        ...(complete ? [complete] : []),
      ])
    } else {
      await db.batch([
        db.insert(timelineSceneRevisions).values(row),
        db.insert(timelineSceneHeads).values({
          worldId: scope.worldId, timelineId: scope.timelineId, representation: scope.representation,
          currentRevisionId: id, currentVersion: version, updatedAt: now,
        }),
        ...legacyWrites,
        guard,
        ...(complete ? [complete] : []),
      ])
    }
  } catch (error) {
    // A concurrent identical request is a successful replay, even if this
    // attempt lost the CAS race before its idempotency row became visible.
    const replay = await db.select().from(timelineSceneRevisions).where(and(
      eq(timelineSceneRevisions.worldId, scope.worldId),
      eq(timelineSceneRevisions.timelineId, scope.timelineId),
      eq(timelineSceneRevisions.representation, scope.representation),
      eq(timelineSceneRevisions.requestId, input.requestId),
    )).get()
    if (replay) {
      const replayHash = await hashText(JSON.stringify(JSON.parse(replay.snapshotJson) as StoredSceneDocument))
      if (replayHash === requestedPayloadHash) return readTimelineRevisionRow(replay, scope)
      throw new SceneConflict('同一 request ID 不能提交不同场景内容')
    }
    throw await readTimelineHeadConflict(db, scope, input.expectedVersion)
  }
  return readTimelineRevisionRow(row, scope)
}

/** Alias retained for callers that name the operation after its row type. */
export const commitTimelineSceneRevision = commitTimelineScene

export interface RestoreTimelineSceneInput {
  scope: TimelineSceneScope
  expectedVersion: number
  requestId: string
  /** Parent/ancestor timeline to restore. Defaults to scope.timelineId's parent. */
  ancestorScope?: TimelineSceneScope
  summary?: string
  kind?: string
}

/** Restore a complete immutable ancestor snapshot into a child line. */
export async function restoreTimelineSceneFromAncestor(db: Db, input: RestoreTimelineSceneInput): Promise<TimelineSceneRevisionRead> {
  // Resolve an already completed restore before consulting the mutable
  // ancestor head; otherwise a later ancestor edit would break replay.
  const prior = await db.select().from(timelineSceneRevisions).where(and(
    eq(timelineSceneRevisions.worldId, input.scope.worldId),
    eq(timelineSceneRevisions.timelineId, input.scope.timelineId),
    eq(timelineSceneRevisions.representation, input.scope.representation),
    eq(timelineSceneRevisions.requestId, input.requestId),
  )).get()
  if (prior) return readTimelineRevisionRow(prior, input.scope)
  const timeline = await db.select().from(timelines).where(and(
    eq(timelines.id, input.scope.timelineId), eq(timelines.worldId, input.scope.worldId),
  )).get()
  if (!timeline) throw new SceneConflict('时间线不存在，请刷新后重试')
  const ancestorTimelineId = input.ancestorScope?.timelineId ?? timeline.parentTimelineId
  if (!ancestorTimelineId) throw new TimelineSceneIntegrityError('unreconstructable-history', 'scene-ancestor-missing')
  if (input.ancestorScope && (input.ancestorScope.worldId !== input.scope.worldId || input.ancestorScope.representation !== input.scope.representation)) {
    throw new TimelineSceneIntegrityError('invalid-parent-chain', 'scene-ancestor-out-of-scope')
  }
  if (ancestorTimelineId !== timeline.parentTimelineId) throw new TimelineSceneIntegrityError('invalid-parent-chain', 'scene-ancestor-not-immediate-parent')
  const ancestorScope: TimelineSceneScope = { worldId: input.scope.worldId, timelineId: ancestorTimelineId, representation: input.scope.representation }
  const ancestor = await readTimelineForkSnapshot(db, ancestorScope, timeline.createdAt)
  if (!ancestor) throw new TimelineSceneIntegrityError('unreconstructable-history', 'scene-parent-head-missing')
  return commitTimelineScene(db, {
    scope: input.scope,
    expectedVersion: input.expectedVersion,
    requestId: input.requestId,
    document: structuredClone(ancestor.document),
    parentRevisionId: ancestor.id,
    summary: input.summary ?? '恢复分叉点前的场景快照',
    kind: input.kind ?? 'ancestor-restore',
  })
}

export const restoreTimelineScene = restoreTimelineSceneFromAncestor
export const commitTimelineSceneVersion = commitTimelineScene

export interface TimelineSceneForkStatementsInput {
  source: TimelineSceneScope
  target: TimelineSceneScope
  requestId: string
  createdAt?: string
}

/** Build the child scene root/head writes so fork can commit them atomically. */
export async function timelineSceneForkStatements(
  db: Db,
  input: TimelineSceneForkStatementsInput,
): Promise<BatchItem<'sqlite'>[]> {
  assertTimelineVoxelScope(input.source)
  assertTimelineVoxelScope(input.target)
  if (input.source.worldId !== input.target.worldId) {
    throw new TimelineSceneIntegrityError('invalid-parent-chain', 'scene-fork-world-mismatch')
  }
  const source = await readCurrentTimelineScene(db, input.source)
  if (!source) return []
  const now = input.createdAt ?? new Date().toISOString()
  const revisionId = `timeline-fork:${input.target.timelineId}:${input.target.representation}:v1`
  const requestId = `${input.requestId}:scene:${input.target.representation}`
  const contentHash = await hashStoredDocument(source.document, 1)
  return [
    db.insert(timelineSceneRevisions).values({
      id: revisionId,
      worldId: input.target.worldId,
      timelineId: input.target.timelineId,
      representation: input.target.representation,
      version: 1,
      historyParentRevisionId: source.id,
      requestId,
      contentHash,
      snapshotJson: JSON.stringify(structuredClone(source.document)),
      summary: '分叉时恢复父线场景快照',
      kind: 'fork-restore',
      validationJson: JSON.stringify({ schema: 'timeline-scene-write-proof-v1', mode: 'fork-restore', sourceTimelineId: source.timelineId, sourceRevisionId: source.id }),
      createdAt: now,
    }),
    db.insert(timelineSceneHeads).values({
      worldId: input.target.worldId,
      timelineId: input.target.timelineId,
      representation: input.target.representation,
      currentRevisionId: revisionId,
      currentVersion: 1,
      updatedAt: now,
    }),
  ]
}

async function scopedMainLegacyStatements(db: Db, options: {
  scope: TimelineSceneScope; input: TimelineSceneCommitInput; createdAt: string
}): Promise<BatchItem<'sqlite'>[]> {
  const { scope, input, createdAt } = options
  const current = await db.select().from(worldScenes).where(eq(worldScenes.worldId, scope.worldId)).get()
  const actual = current?.currentVersion ?? 0
  const version = actual + 1
  const contentHash = await hashStoredDocument(input.document, version)
  const proof = await buildCommitWriteProof(db, { worldId: scope.worldId, candidate: { version, contentHash } })
  const id = crypto.randomUUID()
  return [
    db.insert(worldSceneRevisions).values({ id, worldId: scope.worldId, version, parentVersion: actual || null,
      requestId: input.requestId, contentHash, documentJson: JSON.stringify(input.document), summary: input.summary,
      kind: input.kind, compatibilityJson: input.compatibilityJson ?? null, validationJson: JSON.stringify(proof),
      commitGuard: true, createdAt }),
    current
      ? db.update(worldScenes).set({ currentVersion: version, themeId: voxelThemeId(input.document), updatedAt: createdAt })
        .where(and(eq(worldScenes.worldId, scope.worldId), eq(worldScenes.currentVersion, actual)))
      : db.insert(worldScenes).values({ worldId: scope.worldId, currentVersion: version,
        themeId: voxelThemeId(input.document), updatedAt: createdAt }),
    buildCommitGuardStatement(db, { revisionId: id, worldId: scope.worldId, version,
      requestId: input.requestId, baseline: proof.baseline, authority: input.authority }),
  ]
}

export async function readCurrentScene(db: Db, worldId: string, scope?: TimelineSceneScope): Promise<StoredScene | null> {
  if (scope) {
    if (scope.worldId !== worldId) throw new SceneConflict('场景作用域不一致')
    return readCurrentTimelineScene(db, scope)
  }
  const current = await db.select().from(worldScenes).where(eq(worldScenes.worldId, worldId)).get()
  if (!current) return null
  const row = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, worldId), eq(worldSceneRevisions.version, current.currentVersion))).get()
  if (!row) throw new Error('场景版本索引损坏：当前版本记录不存在')
  try { return { document: JSON.parse(row.documentJson) as StoredSceneDocument, version: row.version, contentHash: row.contentHash, createdAt: row.createdAt } }
  catch { throw new Error('场景文档损坏：无法解析已保存版本') }
}
export async function readSceneVersion(db: Db, worldId: string, version: number, scope?: TimelineSceneScope): Promise<StoredScene | null> {
  if (scope) {
    if (scope.worldId !== worldId) throw new SceneConflict('场景作用域不一致')
    return readTimelineSceneVersion(db, scope, version)
  }
  const row = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, worldId), eq(worldSceneRevisions.version, version))).get()
  if (!row) return null
  try { return { document: JSON.parse(row.documentJson) as StoredSceneDocument, version: row.version, contentHash: row.contentHash, createdAt: row.createdAt } }
  catch { throw new Error('场景历史文档损坏：无法解析指定版本') }
}
export async function readSceneRequest(db: Db, worldId: string, requestId: string): Promise<StoredScene | null> {
  const row = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, worldId), eq(worldSceneRevisions.requestId, requestId))).get()
  if (!row) return null
  try { return { document: JSON.parse(row.documentJson) as StoredSceneDocument, version: row.version, contentHash: row.contentHash, createdAt: row.createdAt } }
  catch { throw new Error('场景请求记录损坏：无法解析版本') }
}
export async function listSceneVersions(db: Db, worldId: string, limit = 30) {
  const rows = await db.select({ version: worldSceneRevisions.version, parentVersion: worldSceneRevisions.parentVersion, summary: worldSceneRevisions.summary, kind: worldSceneRevisions.kind, createdAt: worldSceneRevisions.createdAt, contentHash: worldSceneRevisions.contentHash })
    .from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, worldId)).orderBy(desc(worldSceneRevisions.version)).limit(Math.max(1, Math.min(100, limit))).all()
  return rows
}
export async function commitScene(db: Db, input: {
  worldId: string
  scope?: TimelineSceneScope
  expectedVersion: number
  requestId: string
  document: StoredSceneDocument
  summary: string
  kind: string
  allowBaseline?: boolean
  compatibilityJson?: string | null
  /** Compatibility confirm execution identity, re-checked by the insert gate. */
  compatibility?: SceneWriteProofRequest
  /** Atomically complete a compatibility request with the scene revision. */
  compatibilityCompletion?: { actorKey: string }
  /** Final auth/ownership recheck, provided only by trusted server routes. */
  authority?: SceneWriteAuthority
  /** A1 B28：演示基线重指向与修订同批写入；批内 guard 断言新基线引用。 */
  baselineUpdate?: { baselineId: string }
}): Promise<StoredScene> {
  if (input.scope) {
    if (input.worldId !== input.scope.worldId) throw new SceneConflict('场景作用域不一致')
    return commitTimelineScene(db, { ...input, scope: input.scope })
  }
  const baseline = await db.select({ id: demoBaselines.id }).from(demoBaselines)
    .where(and(eq(demoBaselines.worldId, input.worldId), eq(demoBaselines.status, 'active'))).get()
  if (baseline && !input.allowBaseline) throw new SceneConflict('公共演示基线只读，请先进入访客体验副本')
  const prior = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, input.worldId), eq(worldSceneRevisions.requestId, input.requestId))).get()
  const normalized = structuredClone(input.document)
  const contentHash = await hashStoredDocument(normalized, input.expectedVersion + 1)
  if (prior) {
    // B29：跨用途同 ID 明确拒绝，不返回对方结果；同用途同内容重发仍返回原结果
    if (commitRowNamespace(prior) !== commitInputNamespace(input)) throw new SceneConflict('同一 request ID 已用于其他场景用途')
    if (prior.contentHash !== contentHash) throw new SceneConflict('同一 request ID 不能提交不同场景内容')
    return { document: JSON.parse(prior.documentJson) as StoredSceneDocument, version: prior.version, contentHash: prior.contentHash, createdAt: prior.createdAt }
  }
  const current = await db.select().from(worldScenes).where(eq(worldScenes.worldId, input.worldId)).get()
  const actual = current?.currentVersion ?? 0
  if (actual !== input.expectedVersion) throw new SceneConflict()
  const version = actual + 1; const now = new Date().toISOString(); const id = crypto.randomUUID()
  // 体素系负载的 version 是格式版本（恒 1），修订版本只存在行上
  const document: StoredSceneDocument = normalized
  const themeId = voxelThemeId(document)
  const serialized = JSON.stringify(document)
  // A1 B16：写入依据只由服务端从权威资料构造，随修订一同持久化
  const proof = await buildCommitWriteProof(db, {
    worldId: input.worldId, candidate: { version, contentHash }, ...(input.compatibility ? { compatibility: input.compatibility } : {}),
  })
  // B28：基线重指向入批时 guard 断言新引用；依据内仍是提交前基线（插入闸门在基线更新前核对）
  const guardBaseline: SceneWriteProofBaseline | null = input.baselineUpdate
    ? { id: input.baselineUpdate.baselineId, status: 'active', sceneVersion: version, contentHash }
    : proof.baseline
  const guard = buildCommitGuardStatement(db, {
    revisionId: id, worldId: input.worldId, version, requestId: input.requestId, baseline: guardBaseline,
    ...(input.authority ? { authority: input.authority } : {}),
    ...(input.compatibility && input.compatibilityCompletion ? {
      requestCompletion: { requestId: input.requestId, attempt: input.compatibility.attempt, resultVersion: version },
    } : {}),
  })
  const baselineStatement = input.baselineUpdate
    ? db.update(demoBaselines).set({ sceneVersion: version, contentHash })
      .where(and(eq(demoBaselines.id, input.baselineUpdate.baselineId), eq(demoBaselines.worldId, input.worldId), eq(demoBaselines.status, 'active')))
    : null
  const requestCompletionStatement = input.compatibility && input.compatibilityCompletion
    ? db.update(sceneCompatibilityRequests).set({
      state: 'completed', resultVersion: version, leaseToken: null, leaseUntil: null, updatedAt: now,
    }).where(and(
      eq(sceneCompatibilityRequests.worldId, input.worldId),
      eq(sceneCompatibilityRequests.requestId, input.requestId),
      eq(sceneCompatibilityRequests.actorKey, input.compatibilityCompletion.actorKey),
      eq(sceneCompatibilityRequests.attempt, input.compatibility.attempt),
      eq(sceneCompatibilityRequests.leaseToken, input.compatibility.leaseToken),
      eq(sceneCompatibilityRequests.state, 'submitting'),
    ))
    : null
  const timelineWrites = await legacyMainSceneStatements(db, {
    worldId: input.worldId, version, expectedVersion: actual, document,
    requestId: input.requestId, summary: input.summary, kind: input.kind,
    validationJson: JSON.stringify(proof), createdAt: now,
  })
  try {
    if (current) await db.batch([
      db.insert(worldSceneRevisions).values({ id, worldId: input.worldId, version, parentVersion: actual, requestId: input.requestId, contentHash, documentJson: serialized, summary: input.summary, kind: input.kind, compatibilityJson: input.compatibilityJson ?? null, validationJson: JSON.stringify(proof), commitGuard: true, createdAt: now }),
      db.update(worldScenes).set({ currentVersion: version, themeId, updatedAt: now }).where(and(eq(worldScenes.worldId, input.worldId), eq(worldScenes.currentVersion, actual))),
      ...(baselineStatement ? [baselineStatement] : []),
      ...(requestCompletionStatement ? [requestCompletionStatement] : []),
      guard,
      ...timelineWrites,
    ])
    else await db.batch([
      // 首版同样先插入有依据的新修订、后创建当前指针，避免误用普通旧版本闸门
      db.insert(worldSceneRevisions).values({ id, worldId: input.worldId, version, parentVersion: null, requestId: input.requestId, contentHash, documentJson: serialized, summary: input.summary, kind: input.kind, compatibilityJson: input.compatibilityJson ?? null, validationJson: JSON.stringify(proof), commitGuard: true, createdAt: now }),
      db.insert(worldScenes).values({ worldId: input.worldId, currentVersion: version, themeId, updatedAt: now }),
      ...(baselineStatement ? [baselineStatement] : []),
      ...(requestCompletionStatement ? [requestCompletionStatement] : []),
      guard,
      ...timelineWrites,
    ])
  } catch (error) { throw new SceneConflict(error instanceof Error ? error.message : undefined) }
  return { document, version, contentHash, createdAt: now }
}
export async function initialSceneStatements(db: Db, worldId: string, document: StoredSceneDocument, requestId: string, pendingBindings?: PendingSceneBindings, timelineId?: string): Promise<[BatchItem<'sqlite'>, BatchItem<'sqlite'>, BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]> {
  const now = new Date().toISOString()
  const doc = structuredClone(document)
  const themeId = voxelThemeId(doc)
  const contentHash = await hashText(JSON.stringify({ document: doc, version: 1 }))
  // A1 B16/B17：首版修订携带服务端构造的 initial 依据，且先于当前指针落库。
  // A1 B30：外层同批创建世界时由调用方显式传入待创建绑定快照——此时世界/成员尚未落库，读库只会得到空集合。
  const facts: SceneWriteProofFacts = pendingBindings
    ? { policy: await resolveSceneWritePolicy(db), bindings: await buildPendingSceneBindings(pendingBindings), baseline: null, current: null }
    : await loadSceneWriteProofFacts(db, worldId)
  const proof = buildInitialWriteProof(facts, { candidate: { version: 1, contentHash } })
  const revisionId = crypto.randomUUID()
  return [
    db.insert(worldSceneRevisions).values({ id: revisionId, worldId, version: 1, parentVersion: null, requestId, contentHash, documentJson: JSON.stringify(doc), summary: '开始生活时的场景', kind: 'initial', validationJson: JSON.stringify(proof), commitGuard: true, createdAt: now }),
    db.insert(worldScenes).values({ worldId, currentVersion: 1, themeId, updatedAt: now }),
    // B30 步骤2 最终断言：批内核对外层世界/成员/地点与依据快照一致，不符则 guard=0 整批回滚
    buildCommitGuardStatement(db, { revisionId, worldId, version: 1, requestId, baseline: proof.baseline, expectedBindings: facts.bindings }),
    ...await legacyMainSceneStatements(db, { worldId, timelineId, document: doc, version: 1, expectedVersion: 0,
      requestId, summary: '开始生活时的场景', kind: 'initial', validationJson: JSON.stringify(proof), createdAt: now }),
  ]
}

/** Legacy main-line clients and new timeline clients share one atomic scene
 * result. Explicit timeline operations never enter this compatibility seam. */
async function legacyMainSceneStatements(db: Db, input: {
  worldId: string; timelineId?: string; document: StoredSceneDocument; version: number; expectedVersion: number
  requestId: string; summary: string; kind: string; validationJson: string; createdAt: string
}): Promise<BatchItem<'sqlite'>[]> {
  const timelineId = input.timelineId ?? (await db.select({ id: timelines.id }).from(timelines)
    .where(and(eq(timelines.worldId, input.worldId), isNull(timelines.parentTimelineId))).get())?.id
  if (!timelineId) return []
  const scope = { worldId: input.worldId, timelineId, representation: 'voxel' }
  const head = await readTimelineSceneHead(db, scope)
  const version = (head?.currentVersion ?? 0) + 1
  const id = crypto.randomUUID()
  return [
    db.insert(timelineSceneRevisions).values({ id, ...scope, version,
      historyParentRevisionId: head?.currentRevisionId ?? null, requestId: input.requestId,
      contentHash: await hashStoredDocument(input.document, version), snapshotJson: JSON.stringify(input.document),
      summary: input.summary, kind: input.kind, validationJson: input.validationJson, createdAt: input.createdAt }),
    head ? db.update(timelineSceneHeads).set({ currentRevisionId: id, currentVersion: version, updatedAt: input.createdAt })
      .where(and(eq(timelineSceneHeads.worldId, scope.worldId), eq(timelineSceneHeads.timelineId, timelineId),
        eq(timelineSceneHeads.representation, 'voxel'), eq(timelineSceneHeads.currentVersion, head.currentVersion)))
      : db.insert(timelineSceneHeads).values({ ...scope, currentRevisionId: id, currentVersion: version, updatedAt: input.createdAt }),
  ]
}

export interface CloneSceneStatementsInput {
  sourceWorldId: string
  targetWorldId: string
  targetOwnerId: string
  /**
   * 目标世界（与场景同批创建、尚未落库）的待创建绑定快照（B30 同款口径）：
   * 克隆批内读库只能得到空集合，必须由调用方显式给出重映射后的成员与地点。
   */
  pendingBindings: PendingSceneBindings
  /** 源世界的当前场景指针；源世界无场景时传 null（此时 revisions 也必须为空）。 */
  pointer: typeof worldScenes.$inferSelect | null
  /** 源世界的全部场景修订。 */
  revisions: Array<typeof worldSceneRevisions.$inferSelect>
  /** 目标修订 id/请求 id 分配器（调用方掌握确定性重放口径）。 */
  revisionIdFor: (source: typeof worldSceneRevisions.$inferSelect) => Promise<string>
  requestIdFor: (source: typeof worldSceneRevisions.$inferSelect) => Promise<string>
  /** 身份重映射后的文档 JSON（人物/时间线引用已由调用方改写）。 */
  remapDocument: (documentJson: string) => string
  issuedAt?: string
}

/**
 * A1 B31：克隆批内证明与语句工厂。
 *
 * 只返回语句，不独立落库——调用方把返回的修订/指针/断言语句拼进外层克隆批，
 * 与身份重映射后的世界/成员同批提交，任何一处失败整批回滚。
 *
 * 与裸复制的差别：
 *  - 每条修订生成新的 clone-copy 依据（来源指向源世界修订、归属校验目标 owner），
 *    绝不逐字携带源行的旧依据（旧依据的 source.worldId 指向源世界，策略激活后必然
 *    source_mismatch ABORT，且等于把"源场景有效"的声明伪造到目标世界）；
 *  - contentHash 按重映射后的新文档 + 原版本号重算，与目标世界的存储文档一致；
 *  - 末尾附批内后置断言（指针/修订/基线/绑定复核），断言落空则整批回滚。
 */
export async function cloneSceneStatements(db: Db, input: CloneSceneStatementsInput): Promise<BatchItem<'sqlite'>[]> {
  if (!input.pointer && input.revisions.length === 0) return []
  if (!input.pointer || input.revisions.length === 0) {
    throw new Error('克隆源场景资料不一致：指针与修订必须同时存在')
  }
  const revisions = [...input.revisions].sort((a, b) => a.version - b.version)
  const current = revisions.find(row => row.version === input.pointer!.currentVersion)
  if (!current) throw new Error('克隆源场景资料不一致：当前版本修订不存在')

  const facts: SceneWriteProofFacts = {
    policy: await resolveSceneWritePolicy(db),
    bindings: await buildPendingSceneBindings(input.pendingBindings),
    baseline: null,
    current: null,
  }
  const now = input.issuedAt ?? new Date().toISOString()
  const statements: BatchItem<'sqlite'>[] = []
  let currentRevisionId: string | null = null
  let currentRequestId: string | null = null
  for (const row of revisions) {
    const documentJson = input.remapDocument(row.documentJson)
    // 按复制后的 document+version 重算哈希，与 hashStoredDocument 口径一致
    const contentHash = await hashText(JSON.stringify({ document: JSON.parse(documentJson), version: row.version }))
    const proof = buildCloneCopyWriteProof(facts, {
      source: { worldId: input.sourceWorldId, version: row.version, contentHash: row.contentHash },
      targetOwnerId: input.targetOwnerId,
      candidate: { version: row.version, contentHash },
      issuedAt: now,
    })
    const revisionId = await input.revisionIdFor(row)
    const requestId = await input.requestIdFor(row)
    if (row.version === current.version) {
      currentRevisionId = revisionId
      currentRequestId = requestId
    }
    statements.push(db.insert(worldSceneRevisions).values({
      id: revisionId, worldId: input.targetWorldId, version: row.version, parentVersion: row.parentVersion,
      requestId, contentHash, documentJson, summary: row.summary, kind: row.kind,
      compatibilityJson: row.compatibilityJson, validationJson: JSON.stringify(proof), commitGuard: true,
      createdAt: row.createdAt,
    }))
  }
  statements.push(db.insert(worldScenes).values({
    worldId: input.targetWorldId, currentVersion: input.pointer.currentVersion,
    themeId: input.pointer.themeId, updatedAt: now,
  }))
  // 后置断言：目标指针/当前修订/无基线/批内世界与成员绑定复核，落空则整批回滚
  statements.push(buildCommitGuardStatement(db, {
    revisionId: currentRevisionId!, worldId: input.targetWorldId, version: current.version,
    requestId: currentRequestId!, baseline: null, expectedBindings: facts.bindings,
  }))
  return statements
}
