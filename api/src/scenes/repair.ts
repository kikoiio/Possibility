import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import { persons, worldPersons, worlds } from '../db/schema'
import { worldSnapshot } from '../worlds/queries'
import type { LocationDef } from '../agent/engine-context'
import type { Env } from '../index'
import { createFixedWorldVoxelSceneDraft, type FixedWorldVoxelSceneDraft } from './voxel-draft'
import { resolveTimelineSceneScope, readCurrentTimelineSceneInScope, assertTimelineSceneWritable, readImplicitMainLegacyScene, TimelineSceneRequestError } from './service'

export interface SceneRepairContext {
  scope: { worldId: string; timelineId: string; representation: string }
  timelineStatus: 'active' | 'archived'
  revisionId: string | null
  world: { id: string; name: string; description: string; locations: LocationDef[] }
  residents: { id: string; name: string }[]
  sceneStatus: 'missing' | 'ready'
}

export class SceneRepairError extends Error {
  constructor(readonly code: 'world_missing' | 'scene_exists' | 'world_structure_invalid', message: string) {
    super(message)
    this.name = 'SceneRepairError'
  }
}

/** Read only context for repairing a missing scene. The scene status is returned so a save retry
 * after a lost response can still be idempotent while the context endpoint can redirect users. */
export async function readSceneRepairContext(db: Db, userId: string, worldId: string, options: {
  timelineId?: string
  representation?: string
  /** Only old clients resolving an omitted timeline may see legacy world-scoped scenes. */
  allowLegacyBridge?: boolean
} = {}): Promise<SceneRepairContext> {
  const world = await db.select().from(worlds).where(and(eq(worlds.id, worldId), eq(worlds.userId, userId))).get()
  if (!world) throw new SceneRepairError('world_missing', '世界不存在或无权访问。')
  let resolved: Awaited<ReturnType<typeof resolveTimelineSceneScope>>
  try {
    resolved = await resolveTimelineSceneScope(db, {
      worldId: world.id, timelineId: options.timelineId, representation: options.representation,
    })
  } catch (error) {
    if (options.timelineId === undefined && error instanceof TimelineSceneRequestError && error.code === 'timeline-missing') {
      throw new SceneRepairError('world_structure_invalid', '这个世界缺少可用时间线，暂时无法补建场景。')
    }
    throw error
  }
  const { scope, timeline } = resolved
  const snapshot = await worldSnapshot(db, world.id, scope.timelineId)
  const locations = snapshot?.world.locations ?? []
  const uniqueLocations = new Set(locations.map(location => location.name.trim()).filter(Boolean))
  if (!snapshot || locations.length === 0 || uniqueLocations.size !== locations.length) {
    throw new SceneRepairError('world_structure_invalid', '这个世界的地点资料不完整，暂时无法补建场景。')
  }

  const bindings = await db.select({ personId: worldPersons.personId }).from(worldPersons)
    .where(eq(worldPersons.worldId, world.id)).all()
  const residentIds = bindings.map(binding => binding.personId)
  const residentRows = residentIds.length
    ? await db.select({ id: persons.id, name: persons.name }).from(persons)
      .where(and(eq(persons.userId, userId), inArray(persons.id, residentIds))).all()
    : []
  if (residentRows.length !== residentIds.length) {
    throw new SceneRepairError('world_structure_invalid', '这个世界包含无法读取的居民绑定，暂时无法补建场景。')
  }
  if (residentRows.length === 0) throw new SceneRepairError('world_structure_invalid', '这个世界没有可用于补建场景的居民。')

  const timelineScene = await readCurrentTimelineSceneInScope(db, scope)
  let revisionId = timelineScene?.id ?? null
  // Transitional old clients may bridge their resolved main timeline to a legacy
  // world scene. Explicit timeline requests always remain isolated from that data.
  const allowLegacyBridge = options.allowLegacyBridge ?? options.timelineId === undefined
  if (!timelineScene && allowLegacyBridge && options.timelineId === undefined) {
    revisionId = (await readImplicitMainLegacyScene(db, scope))?.id ?? null
  }
  return {
    scope, timelineStatus: timeline.status === 'archived' ? 'archived' : 'active', revisionId,
    world: { id: world.id, name: snapshot.world.name, description: snapshot.world.description, locations },
    residents: residentRows,
    sceneStatus: revisionId ? 'ready' : 'missing',
  }
}

export async function createSceneRepairDraft(
  env: Env,
  db: Db,
  userId: string,
  worldId: string,
  request: { requestId: string; prompt: string },
  scope: { timelineId?: string; representation?: string } = {},
): Promise<FixedWorldVoxelSceneDraft & { scope: SceneRepairContext['scope'] }> {
  const context = await readSceneRepairContext(db, userId, worldId, scope)
  await assertTimelineSceneWritable(db, context.scope)
  if (context.sceneStatus === 'ready') throw new SceneRepairError('scene_exists', '这个世界已经有场景，可以直接进入。')
  const draft = await createFixedWorldVoxelSceneDraft(env, db, userId, {
    requestId: request.requestId,
    prompt: request.prompt,
    world: context.world,
    residents: context.residents,
  })
  const refreshed = await readSceneRepairContext(db, userId, worldId, scope)
  await assertTimelineSceneWritable(db, refreshed.scope)
  if (refreshed.sceneStatus === 'ready') throw new SceneRepairError('scene_exists', '这个世界已经有场景，可以直接进入。')
  return { ...draft, scope: refreshed.scope }
}
