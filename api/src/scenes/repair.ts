import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { persons, timelines, worldPersons, worldScenes, worlds } from '../db/schema'
import { worldSnapshot } from '../worlds/queries'
import type { LocationDef } from '../agent/engine-context'
import type { Env } from '../index'
import { createFixedWorldVoxelSceneDraft, type FixedWorldVoxelSceneDraft } from './voxel-draft'

export interface SceneRepairContext {
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
export async function readSceneRepairContext(db: Db, userId: string, worldId: string): Promise<SceneRepairContext> {
  const world = await db.select().from(worlds).where(and(eq(worlds.id, worldId), eq(worlds.userId, userId))).get()
  if (!world) throw new SceneRepairError('world_missing', '世界不存在或无权访问。')

  const timeline = await db.select({ id: timelines.id }).from(timelines).where(and(
    eq(timelines.worldId, world.id), isNull(timelines.parentTimelineId),
  )).get()
  if (!timeline) throw new SceneRepairError('world_structure_invalid', '这个世界缺少可用时间线，暂时无法补建场景。')

  const snapshot = await worldSnapshot(db, world.id, timeline.id)
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

  const scene = await db.select({ worldId: worldScenes.worldId }).from(worldScenes)
    .where(eq(worldScenes.worldId, world.id)).get()
  return {
    world: { id: world.id, name: snapshot.world.name, description: snapshot.world.description, locations },
    residents: residentRows,
    sceneStatus: scene ? 'ready' : 'missing',
  }
}

export async function createSceneRepairDraft(
  env: Env,
  db: Db,
  userId: string,
  worldId: string,
  request: { requestId: string; prompt: string },
): Promise<FixedWorldVoxelSceneDraft> {
  const context = await readSceneRepairContext(db, userId, worldId)
  if (context.sceneStatus === 'ready') throw new SceneRepairError('scene_exists', '这个世界已经有场景，可以直接进入。')
  return createFixedWorldVoxelSceneDraft(env, db, userId, {
    requestId: request.requestId,
    prompt: request.prompt,
    world: context.world,
    residents: context.residents,
  })
}
