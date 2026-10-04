import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  commitments, events, persons, timelines, universeRevisions, worldCommands, worldFacts, worldPersons,
} from '../db/schema'
import { checkMoment, reconstructAt, versionAtTime } from '../world-state/reconstruct'

export interface ReturnChange {
  id: string
  kind: 'event' | 'fact'
  simTime: string
  title: string
  description: string
  eventId: string | null
  eventCursor: number | null
  factId: string | null
  revisionVersion: number | null
  sourceCommandId: string | null
  actorPersonId: string | null
  actorName: string | null
  highlight: 'state_change' | 'commitment_change' | null
}

export interface ReturnPage {
  events: Array<typeof events.$inferSelect & { cursor: number; actorName: string | null }>
  changes: ReturnChange[]
  nextEventCursor: number
  nextRevisionVersion: number
  hasMoreEvents: boolean
  hasMoreFacts: boolean
  revisionVersion: number
}

const safeJson = (value: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

function displayFact(fact: typeof worldFacts.$inferSelect, actorName: string | null, commitmentTitle?: string) {
  const value = safeJson(fact.valueJson)
  if (fact.factType === 'environment') {
    const location = typeof value.location === 'string' ? value.location : '地点'
    const condition = typeof value.condition === 'string' ? value.condition : '环境'
    const target = typeof value.value === 'string' ? value.value : '已改变'
    return { title: `${location} · ${condition}已变化`, description: `记录值：${target}`, highlight: 'state_change' as const }
  }
  if (fact.factType === 'location') {
    return { title: `${actorName ?? '居民'}的位置已更新`, description: '居民位置已记录为一项世界状态。', highlight: 'state_change' as const }
  }
  if (fact.factType === 'resident_state') {
    return { title: `${actorName ?? '居民'}的状态已更新`, description: '居民状态已记录为一项世界事实。', highlight: 'state_change' as const }
  }
  if (fact.factType === 'commitment') {
    const status = typeof value.to === 'string' ? value.to : '已更新'
    const labels: Record<string, string> = { proposed: '收到邀请', accepted: '已经约好', declined: '婉拒', fulfilled: '如约完成', missed: '未能赴约', expired: '邀请已过期', explained: '已解释失约' }
    return { title: `${commitmentTitle ?? '一项约定'} · ${labels[status] ?? '状态已更新'}`,
      description: '约定状态变化有版本化记录。', highlight: 'commitment_change' as const }
  }
  if (fact.factType === 'knowledge') {
    const recipient = typeof value.recipientId === 'string' ? value.recipientId : ''
    return { title: '一条消息被转告', description: recipient ? `${actorName ?? '一位居民'}收到了一条私人消息。` : '一位居民获得一条消息；正文仅向获准观察者展示。', highlight: null }
  }
  return { title: '世界状态已更新', description: '已保存一项带来源的世界事实。', highlight: null }
}

export async function getReturnPage(
  db: Db,
  worldId: string,
  timelineId: string,
  simNow: string,
  eventCursor: number,
  revisionCursor: number,
  requestedLimit = 30,
): Promise<ReturnPage> {
  const limit = Math.min(50, Math.max(1, Math.trunc(requestedLimit) || 30))
  const [eventRows, factRows, revisionRows, nameRows, commitmentRows] = await db.batch([
    db.select({ event: events, cursor: sql<number>`rowid` }).from(events)
      .where(and(eq(events.timelineId, timelineId), sql`rowid > ${eventCursor}`, lte(events.simTime, simNow)))
      .orderBy(asc(sql`rowid`)).limit(limit + 1),
    db.select().from(worldFacts).where(and(eq(worldFacts.timelineId, timelineId), sql`${worldFacts.version} > ${revisionCursor}`, lte(worldFacts.simTime, simNow)))
      .orderBy(asc(worldFacts.version)).limit(limit + 1),
    db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timelineId)),
    db.select({ id: persons.id, name: persons.name }).from(worldPersons).innerJoin(persons, eq(worldPersons.personId, persons.id)).where(eq(worldPersons.worldId, worldId)),
    db.select({ id: commitments.id, title: commitments.title }).from(commitments).where(and(eq(commitments.worldId, worldId), eq(commitments.timelineId, timelineId))),
  ])
  const hasMoreEvents = eventRows.length > limit
  const hasMoreFacts = factRows.length > limit
  const pageEvents = eventRows.slice(0, limit).map(row => ({ ...row.event, cursor: row.cursor }))
  const pageFacts = factRows.slice(0, limit)
  const names = new Map(nameRows.map(row => [row.id, row.name]))
  const titles = new Map(commitmentRows.map(row => [row.id, row.title]))
  const commands = pageFacts.length
    ? await db.select().from(worldCommands).where(and(eq(worldCommands.timelineId, timelineId), inArray(worldCommands.id, pageFacts.map(fact => fact.sourceCommandId))))
    : []
  const commandIds = new Set(commands.map(command => command.id))
  const matchingEvents = pageFacts.length
    ? await db.select({ event: events, cursor: sql<number>`rowid` }).from(events).where(and(
      eq(events.timelineId, timelineId),
      inArray(events.id, pageFacts.flatMap(fact => [`command:${fact.sourceCommandId}`])),
    ))
    : []
  const eventByCommand = new Map(matchingEvents.map(row => [row.event.id.slice('command:'.length), { event: row.event, cursor: row.cursor }]))
  const changes: ReturnChange[] = []

  for (const fact of pageFacts) {
    const command = commands.find(row => row.id === fact.sourceCommandId)
    const action = command ? safeJson(command.payloadJson) : {}
    const actorId = typeof action.actorPersonId === 'string' ? action.actorPersonId : null
    const actorName = actorId ? names.get(actorId) ?? null : null
    const display = displayFact(fact, actorName, titles.get(fact.subjectId))
    const match = eventByCommand.get(fact.sourceCommandId)
    const directlySourced = commandIds.has(fact.sourceCommandId)
    changes.push({ id: `fact:${fact.id}`, kind: 'fact', simTime: fact.simTime, title: display.title, description: display.description,
      eventId: match?.event.id ?? null, eventCursor: match?.cursor ?? null, factId: fact.id,
      revisionVersion: fact.version, sourceCommandId: directlySourced ? fact.sourceCommandId : null,
      actorPersonId: actorId, actorName, highlight: directlySourced ? display.highlight : null })
  }

  const matchedEventIds = new Set(matchingEvents.map(row => row.event.id))
  for (const row of pageEvents) {
    if (matchedEventIds.has(row.id)) continue
    const event = row as typeof events.$inferSelect & { cursor: number }
    changes.push({ id: `event:${event.id}`, kind: 'event', simTime: event.simTime, title: event.title, description: event.description,
      eventId: event.id, eventCursor: event.cursor, factId: null, revisionVersion: null, sourceCommandId: null,
      actorPersonId: event.actorPersonId, actorName: event.actorPersonId ? names.get(event.actorPersonId) ?? null : null, highlight: null })
  }
  changes.sort((a, b) => a.simTime.localeCompare(b.simTime) || a.id.localeCompare(b.id))

  const latestFact = pageFacts.at(-1)
  const latestEvent = pageEvents.at(-1)
  return {
    events: pageEvents.map(({ cursor, ...event }) => ({ ...event, cursor, actorName: event.actorPersonId ? names.get(event.actorPersonId) ?? null : null })),
    changes,
    nextEventCursor: latestEvent?.cursor ?? eventCursor,
    nextRevisionVersion: latestFact?.version ?? revisionCursor,
    hasMoreEvents,
    hasMoreFacts,
    revisionVersion: revisionRows[0]?.version ?? 0,
  }
}

export interface EventEvidenceDetail {
  timelineId: string
  event: { id: string; simTime: string; title: string; description: string; kind: string; actorPersonId: string | null; actorName: string | null; location: string | null }
  command: { id: string; type: string; version: number; actorName: string | null } | null
  facts: Array<{ id: string; factType: string; simTime: string; version: number; visibility: string; subjectId: string; value: Record<string, unknown>; sourceCommandId: string }>
  visibleKnowledge: Array<{ factId: string; recipientName: string | null; topic: string; content: string; certainty: 'fact' | 'rumor'; simTime: string }>
  stateSnapshot: Array<{ personName: string | null; location: string | null; activity: string | null; mood: string | null }>
  reconstruction: { status: 'complete' | 'unsupported'; simTime: string | null; version: number | null; completeDomains: string[]; reason: string | null }
  gaps: string[]
  forkAvailable: boolean
}

export async function getEventEvidenceDetail(db: Db, worldId: string, timelineId: string, eventId: string, currentSimNow: string): Promise<EventEvidenceDetail | null> {
  const event = await db.select().from(events).where(and(eq(events.id, eventId), eq(events.timelineId, timelineId), lte(events.simTime, currentSimNow))).get()
  if (!event) return null
  const members = await db.select({ id: persons.id, name: persons.name }).from(worldPersons)
    .innerJoin(persons, eq(worldPersons.personId, persons.id)).where(eq(worldPersons.worldId, worldId))
  const names = new Map(members.map(row => [row.id, row.name]))
  const dialogue = event.dialogueId
    ? await db.select().from((await import('../db/schema')).dialogues).where(eq((await import('../db/schema')).dialogues.id, event.dialogueId)).get()
    : null
  const explicitCommandId = event.id.startsWith('command:') ? event.id.slice('command:'.length) : null
  const command = explicitCommandId
    ? await db.select().from(worldCommands).where(and(eq(worldCommands.id, explicitCommandId), eq(worldCommands.worldId, worldId), eq(worldCommands.timelineId, timelineId))).get()
    : event.createdVersion !== null
      ? await db.select().from(worldCommands).where(and(eq(worldCommands.worldId, worldId), eq(worldCommands.timelineId, timelineId), eq(worldCommands.resultVersion, event.createdVersion))).get()
      : null
  const facts = command
    ? await db.select().from(worldFacts).where(and(eq(worldFacts.timelineId, timelineId), eq(worldFacts.sourceCommandId, command.id))).orderBy(asc(worldFacts.version))
    : event.createdVersion !== null
      ? await db.select().from(worldFacts).where(and(eq(worldFacts.timelineId, timelineId), eq(worldFacts.version, event.createdVersion), lte(worldFacts.simTime, currentSimNow)))
      : []
  const version = await versionAtTime(db, timelineId, event.simTime)
  const moment = await checkMoment(db, worldId, timelineId, event.simTime)
  const reconstructed = moment.ok ? await reconstructAt(db, worldId, timelineId, event.simTime) : moment
  const gaps: string[] = []
  if (!command) gaps.push('没有可核实的来源命令。')
  if (!facts.length) gaps.push('没有与事件直接关联的版本化事实。')
  const reconstructionReason = !moment.ok ? moment.message : !reconstructed.ok ? reconstructed.message : null
  if (reconstructionReason) gaps.push(`该时点无法完整重建：${reconstructionReason}`)
  const projection = reconstructed.ok ? reconstructed.rows : null
  const visibleKnowledge = (projection?.worldFacts ?? []).filter(fact => fact.factType === 'knowledge').map(fact => {
    const value = safeJson(fact.valueJson)
    return { factId: fact.id, recipientName: typeof value.recipientId === 'string' ? names.get(value.recipientId) ?? null : null,
      topic: typeof value.topic === 'string' ? value.topic : '未标注主题', content: typeof value.content === 'string' ? value.content : '',
      certainty: value.certainty === 'fact' ? 'fact' as const : 'rumor' as const, simTime: fact.simTime }
  })
  return {
    timelineId,
    event: { id: event.id, simTime: event.simTime, title: event.title, description: event.description, kind: event.kind,
      actorPersonId: event.actorPersonId, actorName: event.actorPersonId ? names.get(event.actorPersonId) ?? null : null,
      location: dialogue?.location ?? null },
    command: command ? { id: command.id, type: command.type, version: command.resultVersion,
      actorName: command.actorId ? names.get(command.actorId) ?? null : null } : null,
    facts: facts.map(fact => ({ id: fact.id, factType: fact.factType, simTime: fact.simTime, version: fact.version,
      visibility: fact.visibility, subjectId: fact.subjectId, value: safeJson(fact.valueJson), sourceCommandId: fact.sourceCommandId })),
    visibleKnowledge,
    stateSnapshot: (projection?.states ?? []).map(state => ({ personName: names.get(state.personId) ?? null, location: state.location, activity: state.activity, mood: state.mood })),
    reconstruction: reconstructed.ok
      ? { status: 'complete', simTime: reconstructed.simTime, version: version?.version ?? reconstructed.evidence.throughVersion,
          completeDomains: reconstructed.evidence.completeDomains, reason: null }
      : { status: 'unsupported', simTime: null, version: null, completeDomains: [], reason: reconstructed.message },
    gaps,
    forkAvailable: Boolean(reconstructed.ok && version && Date.parse(event.simTime) <= Date.parse(currentSimNow)),
  }
}
