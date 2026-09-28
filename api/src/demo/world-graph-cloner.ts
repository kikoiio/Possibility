import { and, eq, inArray } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../db/client'
import {
  chapters, commitments, conversations, dialogueTurns, dialogues, events, memories, messages, personaMessages,
  persons, personStates, schedules, timelines, universeEvidence, universeRevisions, worldCommands, worldFacts,
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
  if (existing) return { worldId, mainTimelineId: timelineIds.get(mainTimeline.id)!, personIds, timelineIds }

  const sourceTimelineIds = sourceTimelines.map(row => row.id)
  const [dialogueRows, stateRows, scheduleRows, evidenceRows, revisionRows, commandRows, factRows, eventRows,
    memoryRows, conversationRows, chapterRows, personaMessageRows, commitmentRows, visitRows, modelRows, universeRows, sceneRows, sceneRevisionRows] = await Promise.all([
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
  ])

  const dialogueIds = new Map<string, string>()
  const commandIds = new Map<string, string>()
  const factIds = new Map<string, string>()
  const conversationIds = new Map<string, string>()
  for (const row of dialogueRows) dialogueIds.set(row.id, await stableId(input.requestId, 'dialogue', row.id))
  for (const row of commandRows) commandIds.set(row.id, await stableId(input.requestId, 'command', row.id))
  for (const row of factRows) factIds.set(row.id, await stableId(input.requestId, 'fact', row.id))
  for (const row of conversationRows) conversationIds.set(row.id, await stableId(input.requestId, 'conversation', row.id))
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
    ...row, id: await stableId(input.requestId, 'event', row.id), timelineId: timelineIds.get(row.timelineId)!,
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

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  return { worldId, mainTimelineId: timelineIds.get(mainTimeline.id)!, personIds, timelineIds }
}
