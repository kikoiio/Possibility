import { and, eq, isNull } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../../db/client'
import { buildCommitGuardStatement, buildCommitWriteProof, type SceneWriteAuthority } from '../compatibility/write-proof'
import { timelineSceneHeads, timelineSceneRevisions, timelines, worldSceneRevisions, worldScenes } from '../../db/schema'
import { hashStoredDocument, storedSceneThemeId } from './document'
import type { StoredSceneDocument, TimelineSceneCommitInput, TimelineSceneScope } from './types'

export async function scopedMainLegacyStatements(db: Db, options: {
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
      ? db.update(worldScenes).set({ currentVersion: version, themeId: storedSceneThemeId(input.document), updatedAt: createdAt })
        .where(and(eq(worldScenes.worldId, scope.worldId), eq(worldScenes.currentVersion, actual)))
      : db.insert(worldScenes).values({ worldId: scope.worldId, currentVersion: version,
        themeId: storedSceneThemeId(input.document), updatedAt: createdAt }),
    buildCommitGuardStatement(db, { revisionId: id, worldId: scope.worldId, version,
      requestId: input.requestId, baseline: proof.baseline, authority: input.authority }),
  ]
}

export async function legacyMainSceneStatements(db: Db, input: {
  worldId: string; timelineId?: string; document: StoredSceneDocument; version: number; expectedVersion: number
  requestId: string; summary: string; kind: string; validationJson: string; createdAt: string
}): Promise<BatchItem<'sqlite'>[]> {
  const timelineId = input.timelineId ?? (await db.select({ id: timelines.id }).from(timelines)
    .where(and(eq(timelines.worldId, input.worldId), isNull(timelines.parentTimelineId))).get())?.id
  if (!timelineId) return []
  const scope = { worldId: input.worldId, timelineId, representation: 'voxel' }
  const head = await db.select().from(timelineSceneHeads).where(and(
    eq(timelineSceneHeads.worldId, scope.worldId),
    eq(timelineSceneHeads.timelineId, scope.timelineId),
    eq(timelineSceneHeads.representation, scope.representation),
  )).get()
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
