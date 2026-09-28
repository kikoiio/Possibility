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
  if (sourcePeople.length) statements.push(db.insert(persons).values(sourcePeople.map(row => ({ ...row, id: personIds.get(row.id)!, userId: input.targetOwnerId }))))
  if (links.length) statements.push(db.insert(worldPersons).values(links.map(row => ({ ...row, worldId, personId: personIds.get(row.personId)! }))))
  statements.push(db.insert(timelines).values(sourceTimelines.map(row => ({
    ...row, id: timelineIds.get(row.id)!, worldId,
    parentTimelineId: row.parentTimelineId ? timelineIds.get(row.parentTimelineId) ?? null : null,
    ancestorIdsJson: remapArrayJson(row.ancestorIdsJson, timelineIds) ?? '[]',
  }))))
  if (dialogueRows.length) statements.push(db.insert(dialogues).values(dialogueRows.map(row => ({
    ...row, id: dialogueIds.get(row.id)!, timelineId: timelineIds.get(row.timelineId)!,
    participantIdsJson: remapArrayJson(row.participantIdsJson, personIds)!, visitorId: row.visitorId ? personIds.get(row.visitorId) ?? null : null,
  }))))
  if (stateRows.length) statements.push(db.insert(personStates).values(stateRows.map(row => ({ ...row,
    personId: personIds.get(row.personId)!, timelineId: timelineIds.get(row.timelineId)!,
    currentDialogueId: row.currentDialogueId ? dialogueIds.get(row.currentDialogueId) ?? null : null,
  }))))
  if (scheduleRows.length) statements.push(db.insert(schedules).values(scheduleRows.map(row => ({ ...row, personId: personIds.get(row.personId)!, timelineId: timelineIds.get(row.timelineId)! }))))
  if (evidenceRows.length) statements.push(db.insert(universeEvidence).values(evidenceRows.map(row => ({ ...row, timelineId: timelineIds.get(row.timelineId)! }))))
  if (revisionRows.length) statements.push(db.insert(universeRevisions).values(revisionRows.map(row => ({ ...row, timelineId: timelineIds.get(row.timelineId)! }))))
  if (modelRows.length) statements.push(db.insert(worldModelVersions).values(modelRows.map(row => ({ ...row, worldId }))))
  if (universeRows.length && !revisionRows.length) statements.push(db.insert(universeRevisions).values(universeRows.map(row => ({ ...row, timelineId: timelineIds.get(row.timelineId)! }))))
  if (commandRows.length) statements.push(db.insert(worldCommands).values(commandRows.map(row => ({
    ...row, id: commandIds.get(row.id)!, worldId, timelineId: timelineIds.get(row.timelineId)!,
    actorId: row.actorId ? personIds.get(row.actorId) ?? row.actorId : null, tickLeaseToken: null,
  }))))
  if (factRows.length) statements.push(db.insert(worldFacts).values(factRows.map(row => ({
    ...row, id: factIds.get(row.id)!, timelineId: timelineIds.get(row.timelineId)!,
    subjectId: personIds.get(row.subjectId) ?? row.subjectId, sourceCommandId: commandIds.get(row.sourceCommandId)!,
    supersedesId: row.supersedesId ? factIds.get(row.supersedesId) ?? null : null,
  }))))
  if (turnRows.length) statements.push(db.insert(dialogueTurns).values(await Promise.all(turnRows.map(async row => ({
    ...row, id: await stableId(input.requestId, 'turn', row.id), dialogueId: dialogueIds.get(row.dialogueId)!, personId: personIds.get(row.personId)!,
  })))))
  if (eventRows.length) statements.push(db.insert(events).values(await Promise.all(eventRows.map(async row => ({
    ...row, id: await stableId(input.requestId, 'event', row.id), timelineId: timelineIds.get(row.timelineId)!,
    actorPersonId: row.actorPersonId ? personIds.get(row.actorPersonId) ?? null : null,
    dialogueId: row.dialogueId ? dialogueIds.get(row.dialogueId) ?? null : null,
  })))))
  if (memoryRows.length) statements.push(db.insert(memories).values(await Promise.all(memoryRows.map(async row => ({
    ...row, id: await stableId(input.requestId, 'memory', row.id), personId: personIds.get(row.personId)!,
    timelineId: row.timelineId ? timelineIds.get(row.timelineId) ?? null : null,
  })))))
  if (conversationRows.length) statements.push(db.insert(conversations).values(conversationRows.map(row => ({
    ...row, id: conversationIds.get(row.id)!, userId: input.targetOwnerId, personId: personIds.get(row.personId)!, timelineId: timelineIds.get(row.timelineId)!,
  }))))
  if (messageRows.length) statements.push(db.insert(messages).values(await Promise.all(messageRows.map(async row => ({ ...row,
    id: await stableId(input.requestId, 'message', row.id), conversationId: conversationIds.get(row.conversationId)!,
  })))))
  if (chapterRows.length) statements.push(db.insert(chapters).values(await Promise.all(chapterRows.map(async row => ({ ...row,
    id: await stableId(input.requestId, 'chapter', row.id), worldId, timelineId: timelineIds.get(row.timelineId)!,
  })))))
  if (personaMessageRows.length) statements.push(db.insert(personaMessages).values(await Promise.all(personaMessageRows.map(async row => ({ ...row,
    id: await stableId(input.requestId, 'persona-message', row.id), worldId, timelineId: timelineIds.get(row.timelineId)!,
    senderPersonId: personIds.get(row.senderPersonId)!, recipientPersonId: personIds.get(row.recipientPersonId)!,
  })))))
  if (commitmentRows.length) statements.push(db.insert(commitments).values(await Promise.all(commitmentRows.map(async row => ({ ...row,
    id: await stableId(input.requestId, 'commitment', row.id), worldId, timelineId: timelineIds.get(row.timelineId)!,
    personId: personIds.get(row.personId)!, visitorId: personIds.get(row.visitorId)!,
    sourceDialogueId: row.sourceDialogueId ? dialogueIds.get(row.sourceDialogueId) ?? null : null,
  })))))
  if (visitRows.length) statements.push(db.insert(worldVisits).values(visitRows.map(row => ({ ...row, userId: input.targetOwnerId, timelineId: timelineIds.get(row.timelineId)! }))))
  if (sceneRows.length) statements.push(db.insert(worldScenes).values(sceneRows.map(row => ({ ...row, worldId }))))
  if (sceneRevisionRows.length) statements.push(db.insert(worldSceneRevisions).values(await Promise.all(sceneRevisionRows.map(async row => ({ ...row,
    id: await stableId(input.requestId, 'scene-revision', row.id), worldId,
    requestId: await stableId(input.requestId, 'scene-request', row.requestId), documentJson: remapSceneJson(row.documentJson, personIds),
  })))))

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  return { worldId, mainTimelineId: timelineIds.get(mainTimeline.id)!, personIds, timelineIds }
}
