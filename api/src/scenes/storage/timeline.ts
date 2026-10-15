import { and, desc, eq, inArray } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { decodeSceneCompatibility } from '@possibility/voxel-contract'
import type { Db } from '../../db/client'
import { demoBaselines, sceneCompatibilityRequests, timelineSceneHeads, timelineSceneRevisions, timelines } from '../../db/schema'
import { buildCommitWriteProof, buildTimelineCommitGuardStatement, type SceneWriteAuthority, type SceneWriteProofRequest } from '../compatibility/write-proof'
import { hashStoredDocument, hashText, readTimelineRevisionRow } from './document'
import { scopedMainLegacyStatements } from './main-line-bridge'
import { SceneConflict, TimelineSceneConflict, TimelineSceneIntegrityError, type RestoreTimelineSceneInput, type StoredSceneDocument, type TimelineSceneCommitInput, type TimelineSceneForkStatementsInput, type TimelineSceneHistoryBoundary, type TimelineSceneHistoryOptions, type TimelineSceneHistoryPage, type TimelineSceneHistoryRevision, type TimelineSceneRevisionRead, type TimelineSceneScope } from './types'

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

function inputCommitNamespace(input: { kind: string; compatibilityJson?: string | null; compatibility?: SceneWriteProofRequest }) {
  const audit = auditNamespace(input.compatibilityJson)
  return { kind: input.kind, purpose: audit.purpose, draftId: input.compatibility?.draftId ?? audit.draftId }
}

function storedCommitNamespace(row: { kind: string; compatibilityJson: string | null; validationJson: string | null }) {
  const audit = auditNamespace(row.compatibilityJson)
  return { kind: row.kind, purpose: audit.purpose, draftId: proofRequestDraftId(row.validationJson) ?? audit.draftId }
}

export function sameCommitNamespace(
  input: { kind: string; compatibilityJson?: string | null; compatibility?: SceneWriteProofRequest },
  row: { kind: string; compatibilityJson: string | null; validationJson: string | null },
): boolean {
  const requested = inputCommitNamespace(input)
  const stored = storedCommitNamespace(row)
  return requested.kind === stored.kind
    && requested.purpose === stored.purpose
    && requested.draftId === stored.draftId
}

async function hashReplayPayload(document: StoredSceneDocument): Promise<string> {
  return hashText(JSON.stringify(document))
}

function assertTimelineVoxelScope(scope: TimelineSceneScope): void {
  if (scope.representation !== 'voxel') {
    throw new TimelineSceneIntegrityError('unsupported-representation', 'unsupported-representation')
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

function commitScope(input: TimelineSceneCommitInput): TimelineSceneScope {
  if ('scope' in input) return input.scope
  return { worldId: input.worldId, timelineId: input.timelineId, representation: input.representation ?? 'voxel' }
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
  const requestedPayloadHash = await hashReplayPayload(input.document)
  const prior = await db.select().from(timelineSceneRevisions).where(and(
    eq(timelineSceneRevisions.worldId, scope.worldId),
    eq(timelineSceneRevisions.timelineId, scope.timelineId),
    eq(timelineSceneRevisions.representation, scope.representation),
    eq(timelineSceneRevisions.requestId, input.requestId),
  )).get()
  if (prior) {
    const storedAudit = prior.validationJson ? JSON.parse(prior.validationJson).audit : null
    if (!sameCommitNamespace(input, { kind: prior.kind, compatibilityJson: storedAudit ? JSON.stringify(storedAudit) : null, validationJson: prior.validationJson })) throw new SceneConflict('同一 request ID 已用于其他场景用途')
    const priorDocument = JSON.parse(prior.snapshotJson) as StoredSceneDocument
    const priorPayloadHash = await hashReplayPayload(priorDocument)
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
  let parentRevisionId = input.parentRevisionId ?? head?.currentRevisionId ?? null
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
    const replay = await db.select().from(timelineSceneRevisions).where(and(
      eq(timelineSceneRevisions.worldId, scope.worldId),
      eq(timelineSceneRevisions.timelineId, scope.timelineId),
      eq(timelineSceneRevisions.representation, scope.representation),
      eq(timelineSceneRevisions.requestId, input.requestId),
    )).get()
    if (replay) {
      const replayHash = await hashReplayPayload(JSON.parse(replay.snapshotJson) as StoredSceneDocument)
      if (replayHash === requestedPayloadHash) return readTimelineRevisionRow(replay, scope)
      throw new SceneConflict('同一 request ID 不能提交不同场景内容')
    }
    throw await readTimelineHeadConflict(db, scope, input.expectedVersion)
  }
  return readTimelineRevisionRow(row, scope)
}

/** Restore a complete immutable ancestor snapshot into a child line. */
export async function restoreTimelineSceneFromAncestor(db: Db, input: RestoreTimelineSceneInput): Promise<TimelineSceneRevisionRead> {
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
