import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { demoBaselines, worldSceneRevisions, worldScenes } from '../db/schema'

export async function readActiveBaseline(db: Db) {
  const rows = await db.select().from(demoBaselines).where(eq(demoBaselines.status, 'active'))
    .orderBy(desc(demoBaselines.createdAt)).limit(2).all()
  if (rows.length > 1) throw new Error('存在多个 active 演示基线')
  const baseline = rows[0]
  if (!baseline) return null
  const [scene, revision] = await Promise.all([
    db.select().from(worldScenes).where(eq(worldScenes.worldId, baseline.worldId)).get(),
    db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, baseline.worldId), eq(worldSceneRevisions.version, baseline.sceneVersion))).get(),
  ])
  if (!scene || !revision || revision.contentHash !== baseline.contentHash) throw new Error('演示基线场景版本不完整')
  return { ...baseline, scene, revision }
}

export async function isActiveBaselineWorld(db: Db, worldId: string): Promise<boolean> {
  return !!await db.select({ id: demoBaselines.id }).from(demoBaselines)
    .where(and(eq(demoBaselines.worldId, worldId), eq(demoBaselines.status, 'active'))).get()
}
