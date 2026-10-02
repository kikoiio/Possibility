import { and, eq, inArray } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../db/client'
import {
  chapters, commitments, conversations, dialogueTurns, dialogues, events, forkSnapshots, memories, messages, personaMessages,
  persons, personStates, schedules, timelines, universeEvidence, universeRevisions, voxelEventProjections, worldCommands, worldFacts,
  worldModelVersions, worldPersons, worlds, worldSceneRevisions, worldScenes, worldVisits,
} from '../db/schema'

export interface CloneWorldGraphInput {
  sourceWorldId: string
  targetOwnerId: string
  requestId: string
  name?: string
}

export interface CloneWorldGraphResult {
  worldId: string
  mainTimelineId: string
  personIds: Map<string, string>
  timelineIds: Map<string, string>
  eventIds: Map<string, string>
  commandIds: Map<string, string>
}

async function stableId(scope: string, kind: string, source: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${scope}\u0000${kind}\u0000${source}`))
  return `${kind}-${[...new Uint8Array(bytes)].slice(0, 16).map(value => value.toString(16).padStart(2, '0')).join('')}`
}

function remapArrayJson(json: string | null, map: Map<string, string>): string | null {
  if (json === null) return null
  try {
    const value = JSON.parse(json)
    if (!Array.isArray(value)) return json
    return JSON.stringify(value.map(item => typeof item === 'string' ? map.get(item) ?? item : item))
  } catch { return json }
}

function remapSceneJson(json: string, people: Map<string, string>): string {
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return people.get(value) ?? value
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]))
    return value
  }
  return JSON.stringify(visit(JSON.parse(json)))
}

/**
 * Copies one complete world graph with deterministic IDs. A repeated requestId targets the same IDs,
 * so callers can safely return an already-created destination rather than duplicating it.
 */

// SQLite/D1 limits bound variables per statement; one multi-row INSERT must stay well under it.
const MAX_VARS_PER_INSERT = 90

function pushInChunks<T>(statements: BatchItem<'sqlite'>[], rows: T[], make: (chunk: T[]) => BatchItem<'sqlite'>) {
  if (!rows.length) return
  const cols = Math.max(1, Object.keys(rows[0] as Record<string, unknown>).length)
  const size = Math.max(1, Math.floor(MAX_VARS_PER_INSERT / cols))
  for (let index = 0; index < rows.length; index += size) statements.push(make(rows.slice(index, index + size)))
}

export async function cloneWorldGraph(db: Db, input: CloneWorldGraphInput): Promise<CloneWorldGraphResult> {
  const source = await db.select().from(worlds).where(eq(worlds.id, input.sourceWorldId)).get()
  if (!source) throw new Error('复制源世界不存在')
  const worldId = await stableId(input.requestId, 'world', source.id)
  const existing = await db.select({ id: worlds.id }).from(worlds).where(eq(worlds.id, worldId)).get()

  const links = await db.select().from(worldPersons).where(eq(worldPersons.worldId, source.id)).all()
  const sourcePersonIds = links.map(row => row.personId)
  const sourcePeople = sourcePersonIds.length ? await db.select().from(persons).where(inArray(persons.id, sourcePersonIds)).all() : []
  const sourceTimelines = await db.select().from(timelines).where(eq(timelines.worldId, source.id)).all()
  const personIds = new Map<string, string>()
  const timelineIds = new Map<string, string>()
  for (const person of sourcePeople) personIds.set(person.id, await stableId(input.requestId, 'person', person.id))
  for (const timeline of sourceTimelines) timelineIds.set(timeline.id, await stableId(input.requestId, 'timeline', timeline.id))
  const mainTimeline = sourceTimelines.find(row => !row.parentTimelineId) ?? sourceTimelines[0]
  if (!mainTimeline) throw new Error('复制源世界没有时间线')
  const sourceTimelineIds = sourceTimelines.map(row => row.id)
  const [dialogueRows, stateRows, scheduleRows, evidenceRows, revisionRows, commandRows, factRows, eventRows,
    memoryRows, conversationRows, chapterRows, personaMessageRows, commitmentRows, visitRows, modelRows, universeRows, sceneRows, sceneRevisionRows,
    projectionRows, forkSnapshotRows] = await Promise.all([
    sourceTimelineIds.length ? db.select().from(dialogues).where(inArray(dialogues.timelineId, sourceTimelineIds)).all() : [],
    sourceTimelineIds.length ? db.select().from(personStates).where(inArray(personStates.timelineId, sourceTimelineIds)).all() : [],
    sourceTimelineIds.length ? db.select().from(schedules).where(inArray(schedules.timelineId, sourceTimelineIds)).all() : [],
    sourceTimelineIds.length ? db.select().from(universeEvidence).where(inArray(universeEvidence.timelineId, sourceTimelineIds)).all() : [],
    sourceTimelineIds.length ? db.select().from(universeRevisions).where(inArray(universeRevisions.timelineId, sourceTimelineIds)).all() : [],
    db.select().from(worldCommands).where(eq(worldCommands.worldId, source.id)).all(),
    sourceTimelineIds.length ? db.select().from(worldFacts).where(inArray(worldFacts.timelineId, sourceTimelineIds)).all() : [],
    sourceTimelineIds.length ? db.select().from(events).where(inArray(events.timelineId, sourceTimelineIds)).all() : [],
    sourcePersonIds.length ? db.select().from(memories).where(inArray(memories.personId, sourcePersonIds)).all() : [],
    sourceTimelineIds.length ? db.select().from(conversations).where(inArray(conversations.timelineId, sourceTimelineIds)).all() : [],
    db.select().from(chapters).where(eq(chapters.worldId, source.id)).all(),
    db.select().from(personaMessages).where(eq(personaMessages.worldId, source.id)).all(),
    db.select().from(commitments).where(eq(commitments.worldId, source.id)).all(),
    sourceTimelineIds.length ? db.select().from(worldVisits).where(inArray(worldVisits.timelineId, sourceTimelineIds)).all() : [],
    db.select().from(worldModelVersions).where(eq(worldModelVersions.worldId, source.id)).all(),
    sourceTimelineIds.length ? db.select().from(universeRevisions).where(inArray(universeRevisions.timelineId, sourceTimelineIds)).all() : [],
    db.select().from(worldScenes).where(eq(worldScenes.worldId, source.id)).all(),
    db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, source.id)).all(),
    // S2/F5：体素事件投影与分叉快照随克隆复制;日界锚点不复制(可全量回放兜住,日界翻转时再捕获)
    sourceTimelineIds.length ? db.select().from(voxelEventProjections).where(inArray(voxelEventProjections.timelineId, sourceTimelineIds)).all() : [],
    sourceTimelineIds.length ? db.select().from(forkSnapshots).where(inArray(forkSnapshots.timelineId, sourceTimelineIds)).all() : [],
  ])

  const dialogueIds = new Map<string, string>()
  const commandIds = new Map<string, string>()
  const factIds = new Map<string, string>()
  const conversationIds = new Map<string, string>()
  const eventIds = new Map<string, string>()
  for (const row of dialogueRows) dialogueIds.set(row.id, await stableId(input.requestId, 'dialogue', row.id))
  for (const row of commandRows) commandIds.set(row.id, await stableId(input.requestId, 'command', row.id))
  for (const row of factRows) factIds.set(row.id, await stableId(input.requestId, 'fact', row.id))
  for (const row of conversationRows) conversationIds.set(row.id, await stableId(input.requestId, 'conversation', row.id))
  for (const row of eventRows) eventIds.set(row.id, await stableId(input.requestId, 'event', row.id))

  // 世界已克隆过(同 requestId 重放):直接返回全量映射,调用方据此做幂等/核验
  if (existing) return { worldId, mainTimelineId: timelineIds.get(mainTimeline.id)!, personIds, timelineIds, eventIds, commandIds }

  // S2/F3(D1 修复)：历史指令的 expected_version 重定基到该线证据当前已评版本。
  // 0021 触发器要求插入 world_commands 时 evidence level='complete' 且 assessed_version = expected_version;
  // 源世界里指令落库后 evidence 会被后续提交重评,原样重放必然版本失配 → 克隆重定基,线上新写门禁不变。
  // 无 complete 证据的时间线保持原值(源世界本不该存在此状态,让触发器拒绝并走核验失败路径)。
  const evidenceVersionByTimeline = new Map<string, number>()
  for (const row of evidenceRows) {
    if (row.level === 'complete') evidenceVersionByTimeline.set(row.timelineId, row.assessedVersion ?? 0)
  }
  const messageRows = conversationRows.length
    ? await db.select().from(messages).where(inArray(messages.conversationId, conversationRows.map(row => row.id))).all() : []
  const turnRows = dialogueRows.length
    ? await db.select().from(dialogueTurns).where(inArray(dialogueTurns.dialogueId, dialogueRows.map(row => row.id))).all() : []

  const statements: BatchItem<'sqlite'>[] = []
  statements.push(db.insert(worlds).values({ ...source, id: worldId, userId: input.targetOwnerId, name: input.name ?? source.name, isDemo: false }))
  pushInChunks(statements, sourcePeople.map(row => ({ ...row, id: personIds.get(row.id)!, userId: input.targetOwnerId })), chunk => db.insert(persons).values(chunk))
  pushInChunks(statements, links.map(row => ({ ...row, worldId, personId: personIds.get(row.personId)! })), chunk => db.insert(worldPersons).values(chunk))
  pushInChunks(statements, sourceTimelines.map(row => ({
    ...row, id: timelineIds.get(row.id)!, worldId,
    parentTimelineId: row.parentTimelineId ? timelineIds.get(row.parentTimelineId) ?? null : null,
    ancestorIdsJson: remapArrayJson(row.ancestorIdsJson, timelineIds) ?? '[]',
  })), chunk => db.insert(timelines).values(chunk))
  pushInChunks(statements, dialogueRows.map(row => ({
    ...row, id: dialogueIds.get(row.id)!, timelineId: timelineIds.get(row.timelineId)!,
    participantIdsJson: remapArrayJson(row.participantIdsJson, personIds)!, visitorId: row.visitorId ? personIds.get(row.visitorId) ?? null : null,
  })), chunk => db.insert(dialogues).values(chunk))
  pushInChunks(statements, stateRows.map(row => ({ ...row,
    personId: personIds.get(row.personId)!, timelineId: timelineIds.get(row.timelineId)!,
    currentDialogueId: row.currentDialogueId ? dialogueIds.get(row.currentDialogueId) ?? null : null,
  })), chunk => db.insert(personStates).values(chunk))
  pushInChunks(statements, scheduleRows.map(row => ({ ...row, personId: personIds.get(row.personId)!, timelineId: timelineIds.get(row.timelineId)! })), chunk => db.insert(schedules).values(chunk))
  pushInChunks(statements, evidenceRows.map(row => ({ ...row, timelineId: timelineIds.get(row.timelineId)! })), chunk => db.insert(universeEvidence).values(chunk))
  pushInChunks(statements, revisionRows.map(row => ({ ...row, timelineId: timelineIds.get(row.timelineId)! })), chunk => db.insert(universeRevisions).values(chunk))
  pushInChunks(statements, modelRows.map(row => ({ ...row, worldId })), chunk => db.insert(worldModelVersions).values(chunk))
  if (universeRows.length && !revisionRows.length) pushInChunks(statements, universeRows.map(row => ({ ...row, timelineId: timelineIds.get(row.timelineId)! })), chunk => db.insert(universeRevisions).values(chunk))
  pushInChunks(statements, commandRows.map(row => ({
    ...row, id: commandIds.get(row.id)!, worldId, timelineId: timelineIds.get(row.timelineId)!,
    expectedVersion: evidenceVersionByTimeline.get(row.timelineId) ?? row.expectedVersion,
    actorId: row.actorId ? personIds.get(row.actorId) ?? row.actorId : null, tickLeaseToken: null,
  })), chunk => db.insert(worldCommands).values(chunk))
  pushInChunks(statements, factRows.map(row => ({
    ...row, id: factIds.get(row.id)!, timelineId: timelineIds.get(row.timelineId)!,
    subjectId: personIds.get(row.subjectId) ?? row.subjectId, sourceCommandId: commandIds.get(row.sourceCommandId)!,
    supersedesId: row.supersedesId ? factIds.get(row.supersedesId) ?? null : null,
  })), chunk => db.insert(worldFacts).values(chunk))
  pushInChunks(statements, await Promise.all(turnRows.map(async row => ({
    ...row, id: await stableId(input.requestId, 'turn', row.id), dialogueId: dialogueIds.get(row.dialogueId)!, personId: personIds.get(row.personId)!,
  }))), chunk => db.insert(dialogueTurns).values(chunk))
  pushInChunks(statements, await Promise.all(eventRows.map(async row => ({
    ...row, id: eventIds.get(row.id)!, timelineId: timelineIds.get(row.timelineId)!,
    actorPersonId: row.actorPersonId ? personIds.get(row.actorPersonId) ?? null : null,
    dialogueId: row.dialogueId ? dialogueIds.get(row.dialogueId) ?? null : null,
  }))), chunk => db.insert(events).values(chunk))
  pushInChunks(statements, await Promise.all(memoryRows.map(async row => ({
    ...row, id: await stableId(input.requestId, 'memory', row.id), personId: personIds.get(row.personId)!,
    timelineId: row.timelineId ? timelineIds.get(row.timelineId) ?? null : null,
  }))), chunk => db.insert(memories).values(chunk))
  pushInChunks(statements, conversationRows.map(row => ({
    ...row, id: conversationIds.get(row.id)!, userId: input.targetOwnerId, personId: personIds.get(row.personId)!, timelineId: timelineIds.get(row.timelineId)!,
  })), chunk => db.insert(conversations).values(chunk))
  pushInChunks(statements, await Promise.all(messageRows.map(async row => ({ ...row,
    id: await stableId(input.requestId, 'message', row.id), conversationId: conversationIds.get(row.conversationId)!,
  }))), chunk => db.insert(messages).values(chunk))
  pushInChunks(statements, await Promise.all(chapterRows.map(async row => ({ ...row,
    id: await stableId(input.requestId, 'chapter', row.id), worldId, timelineId: timelineIds.get(row.timelineId)!,
  }))), chunk => db.insert(chapters).values(chunk))
  pushInChunks(statements, await Promise.all(personaMessageRows.map(async row => ({ ...row,
    id: await stableId(input.requestId, 'persona-message', row.id), worldId, timelineId: timelineIds.get(row.timelineId)!,
    senderPersonId: personIds.get(row.senderPersonId)!, recipientPersonId: personIds.get(row.recipientPersonId)!,
  }))), chunk => db.insert(personaMessages).values(chunk))
  pushInChunks(statements, await Promise.all(commitmentRows.map(async row => ({ ...row,
    id: await stableId(input.requestId, 'commitment', row.id), worldId, timelineId: timelineIds.get(row.timelineId)!,
    personId: personIds.get(row.personId)!, visitorId: personIds.get(row.visitorId)!,
    sourceDialogueId: row.sourceDialogueId ? dialogueIds.get(row.sourceDialogueId) ?? null : null,
  }))), chunk => db.insert(commitments).values(chunk))
  pushInChunks(statements, visitRows.map(row => ({ ...row, userId: input.targetOwnerId, timelineId: timelineIds.get(row.timelineId)! })), chunk => db.insert(worldVisits).values(chunk))
  pushInChunks(statements, sceneRows.map(row => ({ ...row, worldId })), chunk => db.insert(worldScenes).values(chunk))
  pushInChunks(statements, await Promise.all(sceneRevisionRows.map(async row => ({ ...row,
    id: await stableId(input.requestId, 'scene-revision', row.id), worldId,
    requestId: await stableId(input.requestId, 'scene-request', row.requestId), documentJson: remapSceneJson(row.documentJson, personIds),
  }))), chunk => db.insert(worldSceneRevisions).values(chunk))
  // S2/F5：体素事件投影(ID 重键 vep:{新时间线}:{clusterKey})与分叉快照,载荷内人物/时间线/事件引用统一重映射
  const refIds = new Map<string, string>([...personIds, ...timelineIds, ...eventIds])
  pushInChunks(statements, projectionRows.map(row => ({
    ...row,
    id: `vep:${timelineIds.get(row.timelineId)!}:${row.id.split(':').slice(2).join(':')}`,
    timelineId: timelineIds.get(row.timelineId)!,
    payloadJson: remapSceneJson(row.payloadJson, refIds),
  })), chunk => db.insert(voxelEventProjections).values(chunk))
  pushInChunks(statements, forkSnapshotRows.map(row => ({
    ...row,
    timelineId: timelineIds.get(row.timelineId)!,
    payloadJson: remapSceneJson(row.payloadJson, refIds),
  })), chunk => db.insert(forkSnapshots).values(chunk))

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  return { worldId, mainTimelineId: timelineIds.get(mainTimeline.id)!, personIds, timelineIds, eventIds, commandIds }
}

/**
 * S2/F4：核验失败时删除半成品克隆图。稳定 ID 下不删除会让同 requestId 重试幂等早退到坏世界;
 * 删除后重试可干净重建同一 worldId。先子后父删除(外键),会话/源世界行不在删除范围。
 */
export async function deleteClonedWorldGraph(db: Db, cloned: CloneWorldGraphResult): Promise<void> {
  const worldId = cloned.worldId
  const personIdList = [...cloned.personIds.values()]
  const timelineIdList = [...cloned.timelineIds.values()]
  const conversationIdList = timelineIdList.length
    ? (await db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.timelineId, timelineIdList)).all()).map(row => row.id)
    : []
  const dialogueIdList = timelineIdList.length
    ? (await db.select({ id: dialogues.id }).from(dialogues).where(inArray(dialogues.timelineId, timelineIdList)).all()).map(row => row.id)
    : []

  const statements: BatchItem<'sqlite'>[] = []
  const del = (condition: boolean, statement: BatchItem<'sqlite'>) => { if (condition) statements.push(statement) }
  del(conversationIdList.length > 0, db.delete(messages).where(inArray(messages.conversationId, conversationIdList)))
  del(dialogueIdList.length > 0, db.delete(dialogueTurns).where(inArray(dialogueTurns.dialogueId, dialogueIdList)))
  del(timelineIdList.length > 0, db.delete(events).where(inArray(events.timelineId, timelineIdList)))
  del(timelineIdList.length > 0, db.delete(worldFacts).where(inArray(worldFacts.timelineId, timelineIdList)))
  del(true, db.delete(commitments).where(eq(commitments.worldId, worldId)))
  del(true, db.delete(personaMessages).where(eq(personaMessages.worldId, worldId)))
  del(personIdList.length > 0, db.delete(memories).where(inArray(memories.personId, personIdList)))
  del(timelineIdList.length > 0, db.delete(conversations).where(inArray(conversations.timelineId, timelineIdList)))
  del(timelineIdList.length > 0, db.delete(dialogues).where(inArray(dialogues.timelineId, timelineIdList)))
  del(timelineIdList.length > 0, db.delete(worldVisits).where(inArray(worldVisits.timelineId, timelineIdList)))
  del(timelineIdList.length > 0, db.delete(schedules).where(inArray(schedules.timelineId, timelineIdList)))
  del(timelineIdList.length > 0, db.delete(personStates).where(inArray(personStates.timelineId, timelineIdList)))
  del(timelineIdList.length > 0, db.delete(universeEvidence).where(inArray(universeEvidence.timelineId, timelineIdList)))
  del(timelineIdList.length > 0, db.delete(universeRevisions).where(inArray(universeRevisions.timelineId, timelineIdList)))
  del(timelineIdList.length > 0, db.delete(forkSnapshots).where(inArray(forkSnapshots.timelineId, timelineIdList)))
  del(timelineIdList.length > 0, db.delete(voxelEventProjections).where(inArray(voxelEventProjections.timelineId, timelineIdList)))
  del(true, db.delete(worldCommands).where(eq(worldCommands.worldId, worldId)))
  del(true, db.delete(chapters).where(eq(chapters.worldId, worldId)))
  del(true, db.delete(worldModelVersions).where(eq(worldModelVersions.worldId, worldId)))
  del(true, db.delete(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, worldId)))
  del(true, db.delete(worldScenes).where(eq(worldScenes.worldId, worldId)))
  del(true, db.delete(worldPersons).where(eq(worldPersons.worldId, worldId)))
  del(true, db.delete(timelines).where(eq(timelines.worldId, worldId)))
  del(personIdList.length > 0, db.delete(persons).where(inArray(persons.id, personIdList)))
  del(true, db.delete(worlds).where(eq(worlds.id, worldId)))
  if (statements.length) await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
}
