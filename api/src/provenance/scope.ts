import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import type { AccessContext } from '../access/types'
import { resolveWorldScope } from '../access/world-scope'
import { persons, provenanceRepairItems, provenanceRepairRuns, timelines, universeRevisions, worldPersons, worlds } from '../db/schema'
import { hydrateTimelines } from '../life/snapshot-store'
import { readForkSnapshot } from '../agent/visibility'
import type { EvidenceScope, EvidenceTarget, ForkBoundary, ProvenancePermission } from './types'

export type ProvenanceAccess = Exclude<AccessContext, { kind: 'anonymous' }>

export class ProvenanceScopeError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string, readonly reasonCode = 'provenance_scope_invalid') {
    super(message)
    this.name = 'ProvenanceScopeError'
  }
}
function principalFor(access: ProvenanceAccess): string {
  return access.kind === 'user' ? `user:${access.userId}` : `guest:${access.sessionId}`
}
function permissionFor(access: ProvenanceAccess, ownsWorld: boolean): ProvenancePermission {
  if (access.kind === 'guest') return 'guest_sandbox'
  if (access.role === 'admin' && !ownsWorld) return 'admin_repair'
  return 'owner'
}

function parseStartTime(timeline: typeof timelines.$inferSelect): string | null {
  try {
    const value = JSON.parse(timeline.forkScenarioJson ?? 'null') as { startTime?: unknown } | null
    return typeof value?.startTime === 'string' && Number.isFinite(Date.parse(value.startTime))
      ? new Date(value.startTime).toISOString() : null
  } catch { return null }
}

function parsedAncestors(timeline: typeof timelines.$inferSelect): string[] {
  try {
    const value = JSON.parse(timeline.ancestorIdsJson || '[]') as unknown
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch { return [] }
}

async function repairWatermark(db: Db, target: EvidenceTarget): Promise<number> {
  const runs = await db.select().from(provenanceRepairRuns).where(and(
    eq(provenanceRepairRuns.worldId, target.worldId),
    eq(provenanceRepairRuns.timelineId, target.timelineId),
    eq(provenanceRepairRuns.residentId, target.residentId),
  )).all()
  if (!runs.length) return 0
  const runIds = new Set(runs.map(run => run.runId))
  const items = await db.select({ sequence: provenanceRepairItems.committedSequence, runId: provenanceRepairItems.runId })
    .from(provenanceRepairItems).all()
  return items.reduce((max, item) => runIds.has(item.runId) ? Math.max(max, item.sequence) : max, 0)
}

/**
 * Resolve an immutable, server-authorized read context. The target may narrow
 * the current clock/version, but can never move the read into the future.
 */
export async function resolveEvidenceScope(db: Db, access: ProvenanceAccess, target: EvidenceTarget): Promise<EvidenceScope> {
  if (!access) throw new ProvenanceScopeError(403, '来源读取需要登录', 'unauthenticated')
  if (!target.worldId || !target.timelineId || !target.residentId) {
    throw new ProvenanceScopeError(400, '来源范围参数无效', 'invalid_input')
  }
  const worldScope = await resolveWorldScope(db, access, target.worldId)
  // Maintenance administrators are deliberately resolved separately from the
  // normal owner/guest world scope. They may inspect a repair target, while
  // ordinary users still receive the same not-found response for other worlds.
  const adminRepairWorld = !worldScope && access.kind === 'user' && access.role === 'admin'
    ? await db.select({ id: worlds.id }).from(worlds).where(eq(worlds.id, target.worldId)).get()
    : null
  if (!worldScope && !adminRepairWorld) throw new ProvenanceScopeError(404, '世界或来源不存在', 'not_found')
  const timeline = await db.select().from(timelines).where(and(
    eq(timelines.id, target.timelineId), eq(timelines.worldId, target.worldId),
  )).get()
  const member = await db.select({ personId: worldPersons.personId }).from(worldPersons).where(and(
    eq(worldPersons.worldId, target.worldId), eq(worldPersons.personId, target.residentId),
  )).get()
  const person = await db.select({ id: persons.id }).from(persons).where(eq(persons.id, target.residentId)).get()
  if (!timeline || !member || !person) throw new ProvenanceScopeError(404, '世界或来源不存在', 'not_found')

  // An owner can inspect their own world. Admin maintenance may inspect a
  // world only when the normal world-scope resolver already permits it.
  const ownsWorld = worldScope?.ownsWorld ?? false
  const permission = permissionFor(access, ownsWorld)
  if (!ownsWorld && permission !== 'admin_repair') throw new ProvenanceScopeError(404, '世界或来源不存在', 'not_found')
  if (access.kind === 'guest' && access.worldId !== target.worldId) {
    throw new ProvenanceScopeError(404, '世界或来源不存在', 'not_found')
  }

  const revision = await db.select().from(universeRevisions)
    .where(eq(universeRevisions.timelineId, timeline.id)).get()
  const currentVersion = revision?.version ?? 0
  const currentSimNow = revision?.simTime ?? timeline.simNow
  const requestedVersion = target.revisionVersion ?? currentVersion
  const requestedSimNow = target.simNow ? new Date(target.simNow).toISOString() : currentSimNow
  if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 0 || requestedVersion > currentVersion) {
    throw new ProvenanceScopeError(409, '世界版本已变化，请刷新后重试', 'context_changed')
  }
  if (!Number.isFinite(Date.parse(requestedSimNow)) || Date.parse(requestedSimNow) > Date.parse(currentSimNow)) {
    throw new ProvenanceScopeError(409, '世界时间已变化，请刷新后重试', 'context_changed')
  }

  const worldTimelines = await db.select().from(timelines).where(eq(timelines.worldId, target.worldId)).all()
  const byId = new Map(worldTimelines.map(item => [item.id, item]))
  const hydrated = await hydrateTimelines(db, worldTimelines)
  const hydratedById = new Map(hydrated.map(item => [item.id, item]))
  const ancestors: ForkBoundary[] = []
  const seen = new Set<string>([timeline.id])
  let child = timeline
  let fallbackIndex = parsedAncestors(timeline).length
  while (child.parentTimelineId && !seen.has(child.parentTimelineId)) {
    const parent = byId.get(child.parentTimelineId)
    if (!parent) break
    seen.add(parent.id)
    const hydratedChild = hydratedById.get(child.id) ?? child
    let snapshot: ReturnType<typeof readForkSnapshot> = null
    try { snapshot = readForkSnapshot(hydratedChild) } catch { snapshot = null }
    const start = parseStartTime(child)
    const maxSimTime = snapshot?.sourceSimTime ?? start ?? child.createdAt
    // Legacy checkpoints do not persist the source revision. Their sim-time
    // cutoff is still useful for bounded reads, but a zero version would hide
    // every ordinary parent fact. Use the time bound and mark the read partial
    // in read.ts instead of pretending the history is complete.
    const maxVersion = snapshot?.sourceStateVersion ?? snapshot?.reconstruction?.throughVersion ?? Number.MAX_SAFE_INTEGER
    ancestors.push({
      timelineId: parent.id,
      maxVersion: Number.isSafeInteger(maxVersion) && maxVersion >= 0 ? maxVersion : 0,
      maxSimTime,
      // This is intentionally opaque to callers; it is only used to explain
      // whether the boundary came from a persisted fork checkpoint.
      snapshotRef: snapshot
        ? `fork-snapshot:${child.id}:v${snapshot.version}`
        : `legacy:${parent.id}:${fallbackIndex--}`,
    })
    child = parent
  }

  return {
    worldId: target.worldId,
    timelineId: target.timelineId,
    residentId: target.residentId,
    simNow: requestedSimNow,
    revisionVersion: requestedVersion,
    repairWatermark: await repairWatermark(db, target),
    principalKey: principalFor(access),
    permission,
    ancestors,
  }
}

/** Validate that a scope was created for this principal and is still readable. */
export async function assertEvidenceScope(db: Db, access: ProvenanceAccess, scope: EvidenceScope): Promise<void> {
  if (!scope.principalKey || scope.principalKey !== principalFor(access)) {
    throw new ProvenanceScopeError(403, '来源上下文无权访问', 'forbidden')
  }
  const fresh = await resolveEvidenceScope(db, access, {
    worldId: scope.worldId, timelineId: scope.timelineId, residentId: scope.residentId,
    simNow: scope.simNow, revisionVersion: scope.revisionVersion,
  })
  if (fresh.permission !== scope.permission || fresh.worldId !== scope.worldId
    || fresh.timelineId !== scope.timelineId || fresh.residentId !== scope.residentId) {
    throw new ProvenanceScopeError(409, '来源上下文已变化，请重新读取', 'context_changed')
  }
}
