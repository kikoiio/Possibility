import { and, desc, eq } from 'drizzle-orm'
import type { SceneDocument } from '@possibility/scene-contract'
import { hashScene } from '@possibility/scene-contract'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../db/client'
import { demoBaselines, worldSceneRevisions, worldScenes } from '../db/schema'
import { ensureSceneObjectIds, ensureScenePathIds } from './normalize'

export interface StoredScene { document: SceneDocument; version: number; contentHash: string; createdAt: string }
export class SceneConflict extends Error { constructor(message = '场景已被其他操作更新，请重新加载') { super(message); this.name = 'SceneConflict' } }
export async function readCurrentScene(db: Db, worldId: string): Promise<StoredScene | null> {
  const current = await db.select().from(worldScenes).where(eq(worldScenes.worldId, worldId)).get()
  if (!current) return null
  const row = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, worldId), eq(worldSceneRevisions.version, current.currentVersion))).get()
  if (!row) throw new Error('场景版本索引损坏：当前版本记录不存在')
  try { return { document: JSON.parse(row.documentJson) as SceneDocument, version: row.version, contentHash: row.contentHash, createdAt: row.createdAt } }
  catch { throw new Error('场景文档损坏：无法解析已保存版本') }
}
export async function readSceneVersion(db: Db, worldId: string, version: number): Promise<StoredScene | null> {
  const row = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, worldId), eq(worldSceneRevisions.version, version))).get()
  if (!row) return null
  try { return { document: JSON.parse(row.documentJson) as SceneDocument, version: row.version, contentHash: row.contentHash, createdAt: row.createdAt } }
  catch { throw new Error('场景历史文档损坏：无法解析指定版本') }
}
export async function readSceneRequest(db: Db, worldId: string, requestId: string): Promise<StoredScene | null> {
  const row = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, worldId), eq(worldSceneRevisions.requestId, requestId))).get()
  if (!row) return null
  try { return { document: JSON.parse(row.documentJson) as SceneDocument, version: row.version, contentHash: row.contentHash, createdAt: row.createdAt } }
  catch { throw new Error('场景请求记录损坏：无法解析版本') }
}
export async function listSceneVersions(db: Db, worldId: string, limit = 30) {
  const rows = await db.select({ version: worldSceneRevisions.version, parentVersion: worldSceneRevisions.parentVersion, summary: worldSceneRevisions.summary, kind: worldSceneRevisions.kind, createdAt: worldSceneRevisions.createdAt, contentHash: worldSceneRevisions.contentHash })
    .from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, worldId)).orderBy(desc(worldSceneRevisions.version)).limit(Math.max(1, Math.min(100, limit))).all()
  return rows
}
export async function commitScene(db: Db, input: { worldId: string; expectedVersion: number; requestId: string; document: SceneDocument; summary: string; kind: string }): Promise<StoredScene> {
  const baseline = await db.select({ id: demoBaselines.id }).from(demoBaselines)
    .where(and(eq(demoBaselines.worldId, input.worldId), eq(demoBaselines.status, 'active'))).get()
  if (baseline) throw new SceneConflict('公共演示基线只读，请先进入访客体验副本')
  const prior = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, input.worldId), eq(worldSceneRevisions.requestId, input.requestId))).get()
  const normalized = structuredClone(input.document)
  ensureSceneObjectIds(normalized)
  ensureScenePathIds(normalized)
  const contentHash = await hashScene({ ...normalized, version: input.expectedVersion + 1 })
  if (prior) {
    if (prior.contentHash !== contentHash) throw new SceneConflict('同一 request ID 不能提交不同场景内容')
    return { document: JSON.parse(prior.documentJson) as SceneDocument, version: prior.version, contentHash: prior.contentHash, createdAt: prior.createdAt }
  }
  const current = await db.select().from(worldScenes).where(eq(worldScenes.worldId, input.worldId)).get()
  const actual = current?.currentVersion ?? 0
  if (actual !== input.expectedVersion) throw new SceneConflict()
  const version = actual + 1; const now = new Date().toISOString(); const id = crypto.randomUUID()
  const document = { ...normalized, version }
  const serialized = JSON.stringify(document)
  try {
    if (current) await db.batch([
      db.insert(worldSceneRevisions).values({ id, worldId: input.worldId, version, parentVersion: actual, requestId: input.requestId, contentHash, documentJson: serialized, summary: input.summary, kind: input.kind, createdAt: now }),
      db.update(worldScenes).set({ currentVersion: version, themeId: document.themeId, updatedAt: now }).where(and(eq(worldScenes.worldId, input.worldId), eq(worldScenes.currentVersion, actual))),
    ])
    else await db.batch([
      db.insert(worldScenes).values({ worldId: input.worldId, currentVersion: version, themeId: document.themeId, updatedAt: now }),
      db.insert(worldSceneRevisions).values({ id, worldId: input.worldId, version, parentVersion: null, requestId: input.requestId, contentHash, documentJson: serialized, summary: input.summary, kind: input.kind, createdAt: now }),
    ])
  } catch (error) { throw new SceneConflict(error instanceof Error ? error.message : undefined) }
  return { document, version, contentHash, createdAt: now }
}
export async function initialSceneStatements(db: Db, worldId: string, document: SceneDocument, requestId: string): Promise<[BatchItem<'sqlite'>, BatchItem<'sqlite'>]> {
  const now = new Date().toISOString(); const doc = structuredClone(document); ensureSceneObjectIds(doc); ensureScenePathIds(doc); doc.version = 1; const contentHash = await hashScene(doc)
  return [
    db.insert(worldScenes).values({ worldId, currentVersion: 1, themeId: doc.themeId, updatedAt: now }),
    db.insert(worldSceneRevisions).values({ id: crypto.randomUUID(), worldId, version: 1, parentVersion: null, requestId, contentHash, documentJson: JSON.stringify(doc), summary: '开始生活时的场景', kind: 'initial', createdAt: now }),
  ]
}
