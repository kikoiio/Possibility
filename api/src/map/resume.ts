import { and, desc, eq, isNull } from 'drizzle-orm'
import { isSerializedVoxelSpaces } from '@possibility/voxel-contract'
import type { Db } from '../db/client'
import { guestSessions, timelines, userWorldPreferences, worlds } from '../db/schema'
import { readCurrentScene, type StoredSceneDocument } from '../scenes/repository'

export type MapMode = 'create' | 'life' | 'possibility'

/** 场景文档的空间索引（体素多空间包）；单空间场景返回 null */
function sceneSpaceIndex(document: StoredSceneDocument | undefined): { defaultSpaceId: string; spaceIds: string[] } | null {
  if (!document) return null
  if (isSerializedVoxelSpaces(document)) return { defaultSpaceId: document.defaultSpaceId, spaceIds: document.spaces.map((space) => space.id) }
  return null
}

export async function readMapResume(db: Db, userId: string, worldId: string) {
  return db.select().from(userWorldPreferences)
    .where(and(eq(userWorldPreferences.userId, userId), eq(userWorldPreferences.worldId, worldId))).get()
}

export async function readMostRecentMapWorld(db: Db, userId: string) {
  const rows = await db.select({ worldId: userWorldPreferences.worldId, updatedAt: userWorldPreferences.updatedAt })
    .from(userWorldPreferences).where(eq(userWorldPreferences.userId, userId))
    .orderBy(desc(userWorldPreferences.updatedAt)).limit(1).all()
  const row = rows[0]
  if (!row) return null
  const owned = await db.select({ id: worlds.id }).from(worlds)
    .where(and(eq(worlds.id, row.worldId), eq(worlds.userId, userId))).get()
  return owned ? { worldId: owned.id, updatedAt: row.updatedAt } : null
}

export async function saveMapResume(db: Db, input: { userId: string; worldId: string; timelineId: string; spaceId: string; mode: MapMode }) {
  const [ownedWorld, timeline] = await Promise.all([
    db.select({ id: worlds.id }).from(worlds).where(and(eq(worlds.id, input.worldId), eq(worlds.userId, input.userId))).get(),
    db.select({ id: timelines.id }).from(timelines).where(and(eq(timelines.id, input.timelineId), eq(timelines.worldId, input.worldId))).get(),
  ])
  if (!ownedWorld || !timeline) return false
  const stored = await readCurrentScene(db, input.worldId)
  const index = sceneSpaceIndex(stored?.document)
  if (index ? !index.spaceIds.includes(input.spaceId) : input.spaceId !== 'exterior') return false
  const updatedAt = new Date().toISOString()
  await db.insert(userWorldPreferences).values({ ...input, updatedAt })
    .onConflictDoUpdate({ target: userWorldPreferences.userId, set: { ...input, updatedAt } })
  return true
}

export async function readGuestMapResume(db: Db, sessionId: string) {
  const session = await db.select().from(guestSessions).where(eq(guestSessions.id, sessionId)).get()
  if (!session?.currentSandboxWorldId) return null
  const timeline = session.resumeTimelineId
    ? await db.select({ id: timelines.id }).from(timelines).where(and(eq(timelines.id, session.resumeTimelineId), eq(timelines.worldId, session.currentSandboxWorldId))).get()
    : null
  const fallback = timeline ?? await db.select({ id: timelines.id }).from(timelines)
    .where(and(eq(timelines.worldId, session.currentSandboxWorldId), isNull(timelines.parentTimelineId))).get()
  if (!fallback) return null
  const stored = await readCurrentScene(db, session.currentSandboxWorldId)
  const index = sceneSpaceIndex(stored?.document)
  const defaultSpaceId = index?.defaultSpaceId ?? 'exterior'
  const spaceId = index?.spaceIds.includes(session.resumeSpaceId ?? '') ? session.resumeSpaceId! : defaultSpaceId
  const mode: MapMode = session.resumeMode === 'create' || session.resumeMode === 'possibility' ? session.resumeMode : 'life'
  return { worldId: session.currentSandboxWorldId, timelineId: fallback.id, spaceId, mode, updatedAt: session.updatedAt }
}

export async function saveGuestMapResume(db: Db, input: { sessionId: string; worldId: string; timelineId: string; spaceId: string; mode: MapMode }) {
  const session = await db.select().from(guestSessions).where(eq(guestSessions.id, input.sessionId)).get()
  if (!session || session.status !== 'active' || session.currentSandboxWorldId !== input.worldId) return false
  const timeline = await db.select({ id: timelines.id }).from(timelines)
    .where(and(eq(timelines.id, input.timelineId), eq(timelines.worldId, input.worldId))).get()
  if (!timeline) return false
  const stored = await readCurrentScene(db, input.worldId)
  const index = sceneSpaceIndex(stored?.document)
  if (index ? !index.spaceIds.includes(input.spaceId) : input.spaceId !== 'exterior') return false
  await db.update(guestSessions).set({
    resumeTimelineId: input.timelineId, resumeSpaceId: input.spaceId, resumeMode: input.mode, updatedAt: new Date().toISOString(),
  }).where(eq(guestSessions.id, input.sessionId))
  return true
}
