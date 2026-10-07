import { desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  events, forkSnapshots, personStates, timelines, universeEvidence, voxelEventProjections,
  worldCommands, worldFacts, worldPersons, worlds, worldSceneRevisions, worldScenes,
  timelineSceneHeads, timelineSceneRevisions,
  native2dLayoutHeads, native2dLayoutRevisions,
} from '../db/schema'
import { native2dContentHash } from '../native2d/repository'
import type { Native2dLayout } from '../native2d/schema'

/** S2/F4：克隆完整性核验——克隆批提交后、会话状态变更前执行；全部批量查询,无逐行往返(N3) */

export interface CloneVerificationIssue { code: string; detail: string }
export interface CloneVerification { ok: boolean; issues: CloneVerificationIssue[] }

export interface VerifyClonedWorldInput {
  sourceWorldId: string
  targetOwnerId: string
  worldId: string
  mainTimelineId: string
  personIds: Map<string, string>
  timelineIds: Map<string, string>
  commandIds: Map<string, string>
}

async function countIn(db: Db, table: 'states' | 'events' | 'projections' | 'snapshots' | 'facts', timelineIdList: string[]): Promise<number> {
  if (!timelineIdList.length) return 0
  if (table === 'states') return (await db.select({ personId: personStates.personId }).from(personStates).where(inArray(personStates.timelineId, timelineIdList)).all()).length
  if (table === 'events') return (await db.select({ id: events.id }).from(events).where(inArray(events.timelineId, timelineIdList)).all()).length
  if (table === 'projections') return (await db.select({ id: voxelEventProjections.id }).from(voxelEventProjections).where(inArray(voxelEventProjections.timelineId, timelineIdList)).all()).length
  if (table === 'snapshots') return (await db.select({ timelineId: forkSnapshots.timelineId }).from(forkSnapshots).where(inArray(forkSnapshots.timelineId, timelineIdList)).all()).length
  return (await db.select({ id: worldFacts.id }).from(worldFacts).where(inArray(worldFacts.timelineId, timelineIdList)).all()).length
}

function remapJsonReferences(json: string, identities: Map<string, string>): string {
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return identities.get(value) ?? value
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]))
    return value
  }
  return JSON.stringify(visit(JSON.parse(json)))
}

async function timelineSceneHash(document: unknown, version: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ document, version })))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function containsAnyString(value: unknown, expected: Set<string>): string | null {
  if (typeof value === 'string') return expected.has(value) ? value : null
  if (Array.isArray(value)) {
    for (const item of value) { const found = containsAnyString(item, expected); if (found) return found }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) { const found = containsAnyString(item, expected); if (found) return found }
  }
  return null
}

export async function verifyClonedWorld(db: Db, input: VerifyClonedWorldInput): Promise<CloneVerification> {
  const issues: CloneVerificationIssue[] = []
  const push = (code: string, detail: string) => issues.push({ code, detail })
  const sourceTimelineIdList = [...input.timelineIds.keys()]
  const clonedTimelineIdList = [...input.timelineIds.values()]

  const [clonedWorld, sourceTimelines, clonedTimelines, sourceLinks, clonedLinks,
    sourceStateCount, clonedStateCount, sourceEventCount, clonedEventCount,
    sourceProjectionCount, clonedProjectionCount, sourceSnapshotCount, clonedSnapshotCount,
    scene, latestSceneRevision, sourceTimelineSceneRevisionRows, clonedTimelineSceneRevisionRows,
    sourceTimelineSceneHeadRows, clonedTimelineSceneHeadRows,
    sourceNative2dRevisionRows, clonedNative2dRevisionRows,
    sourceNative2dHeadRows, clonedNative2dHeadRows,
    clonedStateRows, clonedFactRows, clonedEventRows, evidenceRows, clonedCommandRows] = await Promise.all([
    db.select().from(worlds).where(eq(worlds.id, input.worldId)).get(),
    db.select({ id: timelines.id }).from(timelines).where(eq(timelines.worldId, input.sourceWorldId)).all(),
    db.select().from(timelines).where(eq(timelines.worldId, input.worldId)).all(),
    db.select({ personId: worldPersons.personId }).from(worldPersons).where(eq(worldPersons.worldId, input.sourceWorldId)).all(),
    db.select({ personId: worldPersons.personId }).from(worldPersons).where(eq(worldPersons.worldId, input.worldId)).all(),
    countIn(db, 'states', sourceTimelineIdList),
    countIn(db, 'states', clonedTimelineIdList),
    countIn(db, 'events', sourceTimelineIdList),
    countIn(db, 'events', clonedTimelineIdList),
    countIn(db, 'projections', sourceTimelineIdList),
    countIn(db, 'projections', clonedTimelineIdList),
    countIn(db, 'snapshots', sourceTimelineIdList),
    countIn(db, 'snapshots', clonedTimelineIdList),
    db.select().from(worldScenes).where(eq(worldScenes.worldId, input.worldId)).get(),
    db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, input.worldId))
      .orderBy(desc(worldSceneRevisions.version)).limit(1).get(),
    sourceTimelineIdList.length
      ? db.select().from(timelineSceneRevisions).where(inArray(timelineSceneRevisions.timelineId, sourceTimelineIdList)).all()
      : [],
    clonedTimelineIdList.length
      ? db.select().from(timelineSceneRevisions).where(inArray(timelineSceneRevisions.timelineId, clonedTimelineIdList)).all()
      : [],
    sourceTimelineIdList.length
      ? db.select().from(timelineSceneHeads).where(inArray(timelineSceneHeads.timelineId, sourceTimelineIdList)).all()
      : [],
    clonedTimelineIdList.length
      ? db.select().from(timelineSceneHeads).where(inArray(timelineSceneHeads.timelineId, clonedTimelineIdList)).all()
      : [],
    db.select().from(native2dLayoutRevisions).where(eq(native2dLayoutRevisions.worldId, input.sourceWorldId)).all(),
    db.select().from(native2dLayoutRevisions).where(eq(native2dLayoutRevisions.worldId, input.worldId)).all(),
    db.select().from(native2dLayoutHeads).where(eq(native2dLayoutHeads.worldId, input.sourceWorldId)).all(),
    db.select().from(native2dLayoutHeads).where(eq(native2dLayoutHeads.worldId, input.worldId)).all(),
    clonedTimelineIdList.length ? db.select({ personId: personStates.personId }).from(personStates).where(inArray(personStates.timelineId, clonedTimelineIdList)).all() : [],
    clonedTimelineIdList.length ? db.select({ sourceCommandId: worldFacts.sourceCommandId }).from(worldFacts).where(inArray(worldFacts.timelineId, clonedTimelineIdList)).all() : [],
    clonedTimelineIdList.length ? db.select({ actorPersonId: events.actorPersonId }).from(events).where(inArray(events.timelineId, clonedTimelineIdList)).all() : [],
    clonedTimelineIdList.length ? db.select().from(universeEvidence).where(inArray(universeEvidence.timelineId, clonedTimelineIdList)).all() : [],
    db.select({ id: worldCommands.id }).from(worldCommands).where(eq(worldCommands.worldId, input.worldId)).all(),
  ])

  if (!clonedWorld) push('missing_world', `cloned world ${input.worldId} not found`)
  else if (clonedWorld.userId !== input.targetOwnerId) push('owner_mismatch', `world ${input.worldId} owner ${clonedWorld.userId}, expected ${input.targetOwnerId}`)

  if (!clonedTimelines.some(row => row.id === input.mainTimelineId)) push('missing_main_timeline', `main timeline ${input.mainTimelineId} not found in cloned world`)

  const expectCount = (code: string, label: string, source: number, cloned: number) => {
    if (source !== cloned) push(code, `${label}: source ${source}, cloned ${cloned}`)
  }
  expectCount('timeline_count_mismatch', 'timelines', sourceTimelines.length, clonedTimelines.length)
  expectCount('person_count_mismatch', 'world persons', sourceLinks.length, clonedLinks.length)
  expectCount('person_state_count_mismatch', 'person states', sourceStateCount, clonedStateCount)
  expectCount('events_count_mismatch', 'events', sourceEventCount, clonedEventCount)
  expectCount('projection_count_mismatch', 'voxel event projections', sourceProjectionCount, clonedProjectionCount)
  expectCount('fork_snapshot_missing', 'fork snapshots', sourceSnapshotCount, clonedSnapshotCount)
  expectCount('timeline_scene_revision_count_mismatch', 'timeline scene revisions', sourceTimelineSceneRevisionRows.length, clonedTimelineSceneRevisionRows.length)
  expectCount('timeline_scene_head_count_mismatch', 'timeline scene heads', sourceTimelineSceneHeadRows.length, clonedTimelineSceneHeadRows.length)
  expectCount('native2d_revision_count_mismatch', 'native2d layout revisions', sourceNative2dRevisionRows.length, clonedNative2dRevisionRows.length)
  expectCount('native2d_head_count_mismatch', 'native2d layout heads', sourceNative2dHeadRows.length, clonedNative2dHeadRows.length)

  if (!scene) push('scene_revision_missing', `world scene missing for ${input.worldId}`)
  if (!latestSceneRevision) push('scene_revision_missing', `no scene revision for ${input.worldId}`)

  // X1 scene history must be wholly remapped into the cloned world. In
  // particular, a copied parent or head revision must never point to a source
  // revision, even when the source history itself contains a broken link.
  const sourceTimelineSet = new Set(sourceTimelineIdList)
  const clonedTimelineSet = new Set(clonedTimelineIdList)
  const sourceSceneRevisionIdSet = new Set(sourceTimelineSceneRevisionRows.map(row => row.id))
  const clonedSceneRevisionIdSet = new Set(clonedTimelineSceneRevisionRows.map(row => row.id))
  const sourceRevisionFor = new Map(sourceTimelineSceneRevisionRows.map(row => [`${row.timelineId}\u0000${row.representation}\u0000${row.version}`, row]))
  const sourceRevisionIdsByCloneId = new Map<string, string>()
  const clonedTimelineToSource = new Map([...input.timelineIds].map(([sourceId, cloneId]) => [cloneId, sourceId]))
  for (const cloned of clonedTimelineSceneRevisionRows) {
    const sourceTimelineId = clonedTimelineToSource.get(cloned.timelineId)
    if (!sourceTimelineId) continue
    const sourceRevision = sourceRevisionFor.get(`${sourceTimelineId}\u0000${cloned.representation}\u0000${cloned.version}`)
    if (sourceRevision) sourceRevisionIdsByCloneId.set(sourceRevision.id, cloned.id)
  }
  const scopeIdentityMap = new Map<string, string>([...input.personIds, ...input.timelineIds, ...sourceRevisionIdsByCloneId])
  const sourcePersonIdSet = new Set(sourceLinks.map(row => row.personId))
  for (const row of clonedTimelineSceneRevisionRows) {
    if (row.worldId !== input.worldId || !clonedTimelineSet.has(row.timelineId)) {
      push('timeline_scene_revision_scope_mismatch', `revision ${row.id} is outside cloned world/timeline scope`)
    }
    if (sourceSceneRevisionIdSet.has(row.id)) {
      push('timeline_scene_revision_source_leak', `cloned revision ${row.id} reuses a source revision id`)
    }
    if (row.historyParentRevisionId && !clonedSceneRevisionIdSet.has(row.historyParentRevisionId)) {
      push('timeline_scene_revision_dangling_parent', `revision ${row.id} references unknown cloned parent ${row.historyParentRevisionId}`)
    }
    const sourceTimelineId = clonedTimelineToSource.get(row.timelineId)
    const sourceRevision = sourceTimelineId
      ? sourceRevisionFor.get(`${sourceTimelineId}\u0000${row.representation}\u0000${row.version}`)
      : undefined
    if (!sourceRevision) {
      push('timeline_scene_revision_source_missing', `revision ${row.id} has no matching source timeline revision`)
      continue
    }
    const expectedParentId = sourceRevision.historyParentRevisionId
      ? sourceRevisionIdsByCloneId.get(sourceRevision.historyParentRevisionId) ?? null
      : null
    if (row.historyParentRevisionId !== expectedParentId) {
      push('timeline_scene_revision_parent_mismatch', `revision ${row.id} does not preserve its remapped source parent`)
    }
    try {
      const sourceDocument = JSON.parse(sourceRevision.snapshotJson) as unknown
      const clonedDocument = JSON.parse(row.snapshotJson) as unknown
      const expectedDocument = JSON.parse(remapJsonReferences(sourceRevision.snapshotJson, scopeIdentityMap)) as unknown
      if (JSON.stringify(clonedDocument) !== JSON.stringify(expectedDocument)) {
        push('timeline_scene_snapshot_remap_mismatch', `revision ${row.id} snapshot does not match remapped source content`)
      }
      const stalePersonId = containsAnyString(clonedDocument, sourcePersonIdSet)
      if (stalePersonId) push('timeline_scene_source_person_leak', `revision ${row.id} still references source person ${stalePersonId}`)
      if (row.contentHash !== await timelineSceneHash(clonedDocument, row.version)) {
        push('timeline_scene_hash_mismatch', `revision ${row.id} hash does not match its cloned snapshot`)
      }
      if (row.validationJson) {
        const validation = JSON.parse(row.validationJson) as { scope?: { worldId?: string; timelineId?: string; representation?: string } }
        if (validation.scope?.worldId !== input.worldId || validation.scope?.timelineId !== row.timelineId
          || validation.scope?.representation !== row.representation) {
          push('timeline_scene_validation_scope_mismatch', `revision ${row.id} validation scope does not match clone`)
        }
        const staleProofPersonId = containsAnyString(validation, sourcePersonIdSet)
        if (staleProofPersonId) push('timeline_scene_validation_person_leak', `revision ${row.id} validation still references source person ${staleProofPersonId}`)
      } else {
        push('timeline_scene_validation_missing', `revision ${row.id} has no validation scope`)
      }
      // Also reject source timeline references inside the serialized scene payload.
      const staleTimelineId = containsAnyString(sourceDocument, new Set(sourceTimelineIdList))
      if (staleTimelineId && containsAnyString(clonedDocument, new Set(sourceTimelineIdList))) {
        push('timeline_scene_source_timeline_leak', `revision ${row.id} still references source timeline ${staleTimelineId}`)
      }
    } catch {
      push('timeline_scene_snapshot_invalid', `revision ${row.id} has invalid snapshot or validation JSON`)
    }
  }
  for (const row of clonedTimelineSceneHeadRows) {
    if (row.worldId !== input.worldId || !clonedTimelineSet.has(row.timelineId)) {
      push('timeline_scene_head_scope_mismatch', `head for ${row.timelineId} is outside cloned world/timeline scope`)
    }
    if (!clonedSceneRevisionIdSet.has(row.currentRevisionId)) {
      push('timeline_scene_head_dangling_revision', `head for ${row.timelineId} references unknown revision ${row.currentRevisionId}`)
    }
    if (sourceSceneRevisionIdSet.has(row.currentRevisionId)) {
      push('timeline_scene_head_source_leak', `head for ${row.timelineId} references source revision ${row.currentRevisionId}`)
    }
    const revision = clonedTimelineSceneRevisionRows.find(candidate => candidate.id === row.currentRevisionId)
    if (revision && (revision.timelineId !== row.timelineId || revision.representation !== row.representation || revision.version !== row.currentVersion)) {
      push('timeline_scene_head_version_mismatch', `head for ${row.timelineId} does not match its current revision`)
    }
    const sourceTimelineId = clonedTimelineToSource.get(row.timelineId)
    const sourceHead = sourceTimelineId ? sourceTimelineSceneHeadRows.find(candidate => candidate.timelineId === sourceTimelineId
      && candidate.representation === row.representation) : undefined
    if (!sourceHead || sourceRevisionIdsByCloneId.get(sourceHead.currentRevisionId) !== row.currentRevisionId) {
      push('timeline_scene_head_pointer_mismatch', `head for ${row.timelineId} does not point to the remapped source head`)
    }
  }
  const sourceNativeRevisionIds = new Set(sourceNative2dRevisionRows.map(row => row.id))
  const sourceNativeHeadIds = new Set(sourceNative2dHeadRows.map(row => row.currentRevisionId))
  const sourceNativeRevisionFor = (timelineId: string, sceneId: string, version: number) =>
    sourceNative2dRevisionRows.find(row => row.timelineId === timelineId && row.sceneId === sceneId && row.version === version)
  for (const row of clonedNative2dRevisionRows) {
    if (row.worldId !== input.worldId || !clonedTimelineSet.has(row.timelineId)) {
      push('native2d_revision_scope_mismatch', `native2d revision ${row.id} is outside cloned world/timeline scope`)
    }
    if (sourceNativeRevisionIds.has(row.id)) push('native2d_revision_source_leak', `native2d revision ${row.id} reuses a source revision id`)
    const sourceTimelineId = clonedTimelineToSource.get(row.timelineId)
    const sourceRevision = sourceTimelineId ? sourceNativeRevisionFor(sourceTimelineId, row.sceneId, row.version) : undefined
    if (!sourceRevision) {
      push('native2d_revision_source_missing', `native2d revision ${row.id} has no matching source revision`)
      continue
    }
    try {
      const sourceLayout = JSON.parse(sourceRevision.layoutJson) as Native2dLayout
      const clonedLayout = JSON.parse(row.layoutJson) as Native2dLayout
      const expectedLayout: Native2dLayout = {
        ...sourceLayout,
        metadata: { ...sourceLayout.metadata, worldId: input.worldId, timelineId: row.timelineId },
      }
      if (JSON.stringify(clonedLayout) !== JSON.stringify(expectedLayout)) {
        push('native2d_layout_scope_remap_mismatch', `native2d revision ${row.id} layout metadata/content was not copied exactly`)
      }
      if (clonedLayout.metadata.worldId !== input.worldId || clonedLayout.metadata.timelineId !== row.timelineId) {
        push('native2d_layout_metadata_scope_mismatch', `native2d revision ${row.id} metadata does not match clone scope`)
      }
      if (row.contentHash !== native2dContentHash(clonedLayout)) {
        push('native2d_layout_hash_mismatch', `native2d revision ${row.id} hash does not match cloned layout`)
      }
      if (row.parentVersion !== sourceRevision.parentVersion) {
        push('native2d_layout_parent_mismatch', `native2d revision ${row.id} changed its parent version`)
      }
      if (row.parentVersion !== null && !clonedNative2dRevisionRows.some(parent =>
        parent.timelineId === row.timelineId && parent.sceneId === row.sceneId && parent.version === row.parentVersion)) {
        push('native2d_layout_dangling_parent', `native2d revision ${row.id} has no cloned parent version`)
      }
    } catch {
      push('native2d_layout_invalid', `native2d revision ${row.id} has invalid layout JSON`)
    }
  }
  for (const row of clonedNative2dHeadRows) {
    if (row.worldId !== input.worldId || !clonedTimelineSet.has(row.timelineId)) {
      push('native2d_head_scope_mismatch', `native2d head for ${row.timelineId}/${row.sceneId} is outside clone scope`)
    }
    if (sourceNativeHeadIds.has(row.currentRevisionId)) {
      push('native2d_head_source_leak', `native2d head for ${row.timelineId}/${row.sceneId} points to a source revision`)
    }
    const revision = clonedNative2dRevisionRows.find(candidate => candidate.id === row.currentRevisionId)
    if (!revision) {
      push('native2d_head_dangling_revision', `native2d head for ${row.timelineId}/${row.sceneId} references unknown revision ${row.currentRevisionId}`)
    } else if (revision.worldId !== row.worldId || revision.timelineId !== row.timelineId || revision.sceneId !== row.sceneId || revision.version !== row.currentVersion) {
      push('native2d_head_revision_mismatch', `native2d head for ${row.timelineId}/${row.sceneId} does not match its revision`)
    }
    const sourceTimelineId = clonedTimelineToSource.get(row.timelineId)
    const sourceHead = sourceTimelineId ? sourceNative2dHeadRows.find(candidate => candidate.timelineId === sourceTimelineId
      && candidate.sceneId === row.sceneId) : undefined
    const sourceHeadRevision = sourceHead ? sourceNative2dRevisionFor(sourceHead.timelineId, sourceHead.sceneId, sourceHead.currentVersion) : undefined
    const expectedCloneHeadRevision = sourceHeadRevision ? clonedNative2dRevisionRows.find(candidate =>
      candidate.timelineId === row.timelineId && candidate.sceneId === row.sceneId && candidate.version === sourceHeadRevision.version) : undefined
    if (!sourceHead || sourceHead.currentVersion !== row.currentVersion || expectedCloneHeadRevision?.id !== row.currentRevisionId) {
      push('native2d_head_source_missing', `native2d head for ${row.timelineId}/${row.sceneId} has no matching source head`)
    }
  }
  // Keep this explicit so a malformed map cannot silently make source rows
  // appear to be part of the clone while still passing count checks.
  if (sourceTimelineSet.size !== sourceTimelineIdList.length || clonedTimelineSet.size !== clonedTimelineIdList.length) {
    push('timeline_scope_mapping_invalid', 'timeline scope contains duplicate ids')
  }

  const evidenceByTimeline = new Map(evidenceRows.map(row => [row.timelineId, row]))
  for (const timeline of clonedTimelines) {
    if (timeline.status !== 'active') continue
    const evidence = evidenceByTimeline.get(timeline.id)
    if (!evidence || evidence.level !== 'complete') {
      push('evidence_incomplete', `active timeline ${timeline.id} evidence ${evidence?.level ?? 'missing'}`)
    }
  }

  // 悬空引用以克隆世界数据库实存行为准(捕捉部分插入失败与映射错误两类问题)
  const clonedPersonIdSet = new Set(clonedLinks.map(row => row.personId))
  const clonedCommandIdSet = new Set(clonedCommandRows.map(row => row.id))
  for (const row of clonedStateRows) {
    if (!clonedPersonIdSet.has(row.personId)) push('dangling_person_state', `person state references unknown person ${row.personId}`)
  }
  for (const row of clonedFactRows) {
    if (!clonedCommandIdSet.has(row.sourceCommandId)) push('dangling_fact_command', `fact references unknown command ${row.sourceCommandId}`)
  }
  for (const row of clonedEventRows) {
    if (row.actorPersonId && !clonedPersonIdSet.has(row.actorPersonId)) push('dangling_event_actor', `event references unknown person ${row.actorPersonId}`)
  }

  return { ok: issues.length === 0, issues }
}
