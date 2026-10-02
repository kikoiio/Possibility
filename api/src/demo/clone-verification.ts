import { desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  events, forkSnapshots, personStates, timelines, universeEvidence, voxelEventProjections,
  worldCommands, worldFacts, worldPersons, worlds, worldSceneRevisions, worldScenes,
} from '../db/schema'

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

export async function verifyClonedWorld(db: Db, input: VerifyClonedWorldInput): Promise<CloneVerification> {
  const issues: CloneVerificationIssue[] = []
  const push = (code: string, detail: string) => issues.push({ code, detail })
  const sourceTimelineIdList = [...input.timelineIds.keys()]
  const clonedTimelineIdList = [...input.timelineIds.values()]

  const [clonedWorld, sourceTimelines, clonedTimelines, sourceLinks, clonedLinks,
    sourceStateCount, clonedStateCount, sourceEventCount, clonedEventCount,
    sourceProjectionCount, clonedProjectionCount, sourceSnapshotCount, clonedSnapshotCount,
    scene, latestSceneRevision, clonedStateRows, clonedFactRows, clonedEventRows, evidenceRows, clonedCommandRows] = await Promise.all([
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

  if (!scene) push('scene_revision_missing', `world scene missing for ${input.worldId}`)
  if (!latestSceneRevision) push('scene_revision_missing', `no scene revision for ${input.worldId}`)

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
