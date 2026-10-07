import {
  commitScene,
  listTimelineSceneHistory,
  readCurrentTimelineScene,
  readSceneVersion,
  readTimelineSceneVersion,
  SceneConflict,
  type TimelineSceneHistoryRevision,
  type TimelineSceneScope,
} from './repository'
import type { Db } from '../db/client'
import type { SceneValidationAccess } from './compatibility/context'
import { and, desc, eq, isNull, lt } from 'drizzle-orm'
import { timelines, worldPersons, worldSceneRevisions, worldScenes, worlds } from '../db/schema'
import {
  inspectSceneCompatibility,
  SceneCompatibilityServiceError,
  validateStoredSceneCandidate,
} from './compatibility/service'
import { deriveSceneBindings } from './compatibility/context'
import { isSerializedVoxelDocument, isSerializedVoxelSpaces } from '@possibility/voxel-contract'

export type SceneRepresentation = 'voxel' | 'native2d'

export class TimelineSceneRequestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: 400 | 404 | 409 | 422,
  ) {
    super(message)
    this.name = 'TimelineSceneRequestError'
  }
}

/** Resolve an explicit scope, or the single authorized main line for old clients. */
export async function resolveTimelineSceneScope(
  db: Db,
  input: { worldId: string; timelineId?: string; representation?: string },
): Promise<{ scope: TimelineSceneScope; timeline: typeof timelines.$inferSelect }> {
  const representation = input.representation ?? 'voxel'
  if (representation !== 'voxel' && representation !== 'native2d') {
    throw new TimelineSceneRequestError('场景表现不受支持', 'format-unsupported', 422)
  }
  if (representation !== 'voxel') {
    throw new TimelineSceneRequestError('原生 2D 场景尚未接入服务端持久化', 'format-unsupported', 422)
  }
  if (input.timelineId !== undefined && !input.timelineId.trim()) {
    throw new TimelineSceneRequestError('时间线 ID 无效', 'invalid-timeline', 400)
  }

  let timelineId = input.timelineId
  if (timelineId === undefined) {
    const mainTimelines = await db.select().from(timelines).where(and(
      eq(timelines.worldId, input.worldId),
      isNull(timelines.parentTimelineId),
    )).all()
    if (mainTimelines.length !== 1) {
      throw new TimelineSceneRequestError('主时间线不存在或不唯一', 'timeline-missing', 404)
    }
    timelineId = mainTimelines[0]!.id
  }
  const timeline = await db.select().from(timelines).where(and(
    eq(timelines.id, timelineId),
    eq(timelines.worldId, input.worldId),
  )).get()
  if (!timeline) throw new TimelineSceneRequestError('时间线不存在', 'timeline-missing', 404)
  return { scope: { worldId: input.worldId, timelineId: timeline.id, representation }, timeline }
}

/** Ensure a client-selected space is part of the complete stored scene snapshot. */
export function assertTimelineSceneSpace(
  document: unknown,
  spaceId: string | undefined,
): void {
  if (spaceId === undefined) return
  if (!spaceId.trim()) throw new TimelineSceneRequestError('空间 ID 无效', 'invalid-space', 400)
  if (document && typeof document === 'object' && 'format' in document
    && (document as { format?: unknown }).format === 'voxel-spaces'
    && Array.isArray((document as { spaces?: unknown }).spaces)) {
    const spaces = (document as { spaces: Array<{ id?: unknown }> }).spaces
    if (spaces.some(space => space?.id === spaceId)) return
    throw new TimelineSceneRequestError('空间不存在', 'space-missing', 404)
  }
  // A single voxel document has one public map space; its internal adapter
  // sentinel is deliberately not exposed as a client space ID.
  if (spaceId !== 'exterior') throw new TimelineSceneRequestError('空间不存在', 'space-missing', 404)
}

/** Resolve a requested revision only if the current line can see it in lineage history. */
export async function findVisibleTimelineSceneRevision(
  db: Db,
  scope: TimelineSceneScope,
  target: { revisionId: string } | { version: number },
): Promise<TimelineSceneHistoryRevision | null> {
  let cursor: string | null = null
  while (true) {
    const page = await listTimelineSceneHistory(db, scope, { limit: 100, cursor })
    if (!page) return null
    const found = page.revisions.find(revision => 'revisionId' in target
      ? revision.id === target.revisionId
      : revision.timelineId === scope.timelineId && revision.version === target.version)
    if (found) return found
    if (!page.hasMore || !page.nextCursor) return null
    cursor = page.nextCursor
  }
}

/** Read a version from the selected line only; ancestor restores use history visibility instead. */
export function readTimelineSceneVersionInScope(
  db: Db,
  scope: TimelineSceneScope,
  version: number,
) {
  return readTimelineSceneVersion(db, scope, version)
}

export function readCurrentTimelineSceneInScope(db: Db, scope: TimelineSceneScope) {
  return readCurrentTimelineScene(db, scope)
}

/** Transitional legacy bridge for clients that omitted timelineId. */
export async function readImplicitMainLegacyScene(db: Db, scope: TimelineSceneScope) {
  const pointer = await db.select().from(worldScenes).where(eq(worldScenes.worldId, scope.worldId)).get()
  if (!pointer) return null
  const row = await db.select().from(worldSceneRevisions).where(and(
    eq(worldSceneRevisions.worldId, scope.worldId), eq(worldSceneRevisions.version, pointer.currentVersion),
  )).get()
  if (!row) throw new TimelineSceneRequestError('主时间线旧场景记录损坏', 'legacy-scene-corrupt', 409)
  let document: unknown
  try { document = JSON.parse(row.documentJson) }
  catch { throw new TimelineSceneRequestError('主时间线旧场景记录损坏', 'legacy-scene-corrupt', 409) }
  return { id: row.id, worldId: row.worldId, timelineId: scope.timelineId, representation: scope.representation,
    requestId: row.requestId, parentRevisionId: null, summary: row.summary, kind: row.kind,
    validationJson: row.validationJson, document, version: row.version, contentHash: row.contentHash, createdAt: row.createdAt,
    legacy: true as const }
}

export async function listImplicitMainLegacySceneHistory(db: Db, scope: TimelineSceneScope, options: { limit?: number; cursor?: string | null } = {}) {
  const limit = options.limit ?? 30
  const safeLimit = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 30))
  let rows: (typeof worldSceneRevisions.$inferSelect)[]
  if (options.cursor) {
    const cursor = await db.select({ version: worldSceneRevisions.version }).from(worldSceneRevisions).where(and(
      eq(worldSceneRevisions.worldId, scope.worldId), eq(worldSceneRevisions.id, options.cursor),
    )).get()
    if (!cursor) throw new TimelineSceneRequestError('场景历史游标无效', 'invalid-cursor', 400)
    rows = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, scope.worldId),
      lt(worldSceneRevisions.version, cursor.version))).orderBy(desc(worldSceneRevisions.version)).limit(safeLimit + 1).all()
  } else {
    rows = await db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, scope.worldId))
      .orderBy(desc(worldSceneRevisions.version)).limit(safeLimit + 1).all()
  }
  const hasMore = rows.length > safeLimit
  const page = rows.slice(0, safeLimit)
  return { scope, revisions: page.map(row => ({ revisionId: row.id, version: row.version, timelineId: scope.timelineId,
    originTimelineId: scope.timelineId, origin: 'current' as const, parentRevisionId: null, contentHash: row.contentHash,
    summary: row.summary, kind: row.kind, createdAt: row.createdAt })), nextCursor: hasMore ? page[page.length - 1]!.id : null, hasMore,
    boundaries: [] }
}

export async function readImplicitMainLegacyRevision(db: Db, scope: TimelineSceneScope, param: string) {
  const row = /^\d+$/.test(param)
    ? await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, scope.worldId), eq(worldSceneRevisions.version, Number(param)))).get()
    : await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, scope.worldId), eq(worldSceneRevisions.id, param))).get()
  if (!row) return null
  let document: unknown
  try { document = JSON.parse(row.documentJson) }
  catch { throw new TimelineSceneRequestError('主时间线旧场景记录损坏', 'legacy-scene-corrupt', 409) }
  return { id: row.id, worldId: row.worldId, timelineId: scope.timelineId, representation: scope.representation,
    requestId: row.requestId, parentRevisionId: row.parentVersion === null ? null : `legacy-v${row.parentVersion}`,
    summary: row.summary, kind: row.kind, validationJson: row.validationJson, document, version: row.version,
    contentHash: row.contentHash, createdAt: row.createdAt, sourceTimelineId: scope.timelineId, source: 'current' as const,
    legacy: true as const }
}

/** Reject archived timeline writes before doing validation work. */
export async function assertTimelineSceneWritable(db: Db, scope: TimelineSceneScope): Promise<void> {
  const timeline = await db.select({ status: timelines.status }).from(timelines).where(and(
    eq(timelines.id, scope.timelineId), eq(timelines.worldId, scope.worldId),
  )).get()
  if (!timeline) throw new TimelineSceneRequestError('时间线不存在', 'timeline-missing', 404)
  if (timeline.status !== 'active') throw new TimelineSceneRequestError('归档时间线只支持查看历史，不能编辑或恢复', 'timeline-archived', 409)
}

/** Build first-write bindings from the candidate itself, never from legacy world scene data. */
export async function timelineSceneCandidateBindings(db: Db, worldId: string, document: unknown) {
  const world = await db.select({ locationsJson: worlds.locationsJson }).from(worlds).where(eq(worlds.id, worldId)).get()
  const people = await db.select({ personId: worldPersons.personId }).from(worldPersons).where(eq(worldPersons.worldId, worldId)).all()
  let locations: Array<{ name: string; stableId?: string }> = []
  try {
    const parsed: unknown = JSON.parse(world?.locationsJson ?? '[]')
    if (Array.isArray(parsed)) locations = parsed.flatMap(item => item && typeof item === 'object'
      && typeof (item as { name?: unknown }).name === 'string'
      ? [{ name: (item as { name: string }).name, ...(typeof (item as { stableId?: unknown }).stableId === 'string' ? { stableId: (item as { stableId: string }).stableId } : {}) }] : [])
  } catch { /* Invalid world locations are represented as empty candidate bindings and fail validation. */ }
  const candidate = isSerializedVoxelDocument(document) || isSerializedVoxelSpaces(document) ? document : null
  return deriveSceneBindings({ document: candidate, personIds: people.map(person => person.personId), locations })
}

/** Restore a visible immutable revision as a fresh, scoped A1-validated write. */
export async function restoreTimelineSceneRevision(db: Db, input: {
  worldId: string
  scope: TimelineSceneScope
  expectedVersion: number
  requestId: string
  target: { revisionId: string } | { version: number }
  access: SceneValidationAccess
  authority?: Parameters<typeof commitScene>[1]['authority']
}) {
  if (input.scope.worldId !== input.worldId
    || input.access.scope?.worldId !== input.scope.worldId
    || input.access.scope?.timelineId !== input.scope.timelineId
    || input.access.scope?.representation !== input.scope.representation) {
    throw new TimelineSceneRequestError('场景作用域不一致', 'invalid-scope', 400)
  }
  const target = await findVisibleTimelineSceneRevision(db, input.scope, input.target)
  if (!target) throw new SceneConflict('找不到当前时间线可见的场景版本')

  const validation = await validateStoredSceneCandidate(db, {
    worldId: input.worldId,
    document: target.document,
    access: input.access,
  })
  if (validation.status !== 'valid') {
    const status = validation.status === 'invalid' ? 'invalid' : 'incomplete'
    throw new SceneCompatibilityServiceError(
      status === 'invalid' ? '目标版本未通过完整校验，请先使用兼容修复流程' : '目标版本检查未完成，不能恢复',
      status === 'invalid' ? 'compatibility-required' : 'validation-incomplete',
      422,
      validation.report,
    )
  }

  return commitScene(db, {
    worldId: input.worldId,
    scope: input.scope,
    expectedVersion: input.expectedVersion,
    requestId: input.requestId,
    document: target.document,
    summary: `从 ${target.sourceTimelineId} 恢复场景修订 ${target.version}`,
    kind: 'ancestor-restore',
    compatibilityJson: JSON.stringify({ purpose: 'restore-history', targetRevisionId: target.id,
      sourceTimelineId: target.sourceTimelineId, sourceVersion: target.version, sourceContentHash: target.contentHash }),
    ...(input.authority ? { authority: input.authority } : {}),
  })
}

/**
 * 场景服务(S2 起):2D operations 增量通道已退役,体素信封走 voxel-revision。
 * 历史恢复走完整 A1 流程:先对目标版本做完整诊断,有效目标才允许提交;
 * 无效目标返回 compatibility-required 交给兼容修复流程,未完成检查一律拒绝。
 */
export async function restoreSceneVersion(db: Db, input: {
  worldId: string
  expectedVersion: number
  targetVersion: number
  requestId: string
  access: SceneValidationAccess
}) {
  const inspection = await inspectSceneCompatibility(db, {
    worldId: input.worldId,
    target: { kind: 'history', version: input.targetVersion },
    access: input.access,
  })
  if (inspection.status === 'missing') throw new SceneConflict('找不到要恢复的场景版本')
  if (inspection.status !== 'ready') {
    throw new SceneCompatibilityServiceError(inspection.error.message, inspection.error.code, 422)
  }
  if (inspection.report.status === 'invalid') {
    throw new SceneCompatibilityServiceError('目标版本未通过完整校验，请先使用兼容修复流程', 'compatibility-required', 422, inspection.report)
  }
  if (inspection.report.status === 'incomplete') {
    throw new SceneCompatibilityServiceError('目标版本检查未完成，不能恢复', 'validation-incomplete', 422, inspection.report)
  }
  const target = await readSceneVersion(db, input.worldId, input.targetVersion)
  if (!target) throw new SceneConflict('找不到要恢复的场景版本')
  const audit = {
    purpose: 'restore-history' as const,
    source: inspection.source,
    basis: inspection.basis,
    changes: [],
    draftId: null,
    requestId: input.requestId,
  }
  return commitScene(db, {
    worldId: input.worldId,
    expectedVersion: input.expectedVersion,
    requestId: input.requestId,
    document: target.document,
    summary: `恢复到场景 v${target.version}`,
    kind: 'restore',
    compatibilityJson: JSON.stringify(audit),
  })
}
