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

type ReviewEvent = typeof events.$inferSelect & { cursor: number }
type ReviewFact = typeof worldFacts.$inferSelect

interface ReviewCandidate {
  stream: 'event' | 'fact'
  change: ReturnChange
  event?: ReviewEvent
  fact?: ReviewFact
  /** The event represented by a fact is consumed with the fact, when safe. */
  sourceEvent?: ReviewEvent
}

const safeJson = (value: string): Record<string, unknown> => {
  const parsed = parseJsonObject(value)
  return parsed.value
}

function parseJsonObject(value: string): { value: Record<string, unknown>; valid: boolean } {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { value: parsed as Record<string, unknown>, valid: true }
      : { value: {}, valid: false }
  } catch { return { value: {}, valid: false } }
}

/**
 * Most commands use `command:${id}` as their event id, but a few stable
 * actions choose a domain id (commitments and builder interventions). Keeping
 * this mapping here lets the read path preserve their direct source relation
 * without relying on a same-time heuristic.
 */
function eventIdForCommand(command: typeof worldCommands.$inferSelect): string {
  const action = safeJson(command.payloadJson)
  if (action.type === 'commitment'
    && typeof action.commitmentId === 'string' && typeof action.next === 'string') {
    return `commitment:${action.commitmentId}:${action.next}`
  }
  if (action.type === 'intervention' && typeof action.requestId === 'string') {
    return `intervention:${action.requestId}`
  }
  return `command:${command.id}`
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
  // Fetch a small look-ahead for each ordered stream. The final row is a
  // sentinel when the stream is longer; it is never used to advance a
  // watermark, which keeps a page boundary stable when the other stream is
  // deduplicated against it.
  const fetchLimit = Math.min(250, Math.max(limit + 2, limit * 3 + 5))
  const [eventRowsRaw, factRowsRaw, revisionRows, nameRows, commitmentRows] = await db.batch([
    db.select({ event: events, cursor: sql<number>`rowid` }).from(events)
      .where(and(eq(events.timelineId, timelineId), sql`rowid > ${eventCursor}`, lte(events.simTime, simNow)))
      .orderBy(asc(sql`rowid`)).limit(fetchLimit),
    db.select().from(worldFacts).where(and(eq(worldFacts.timelineId, timelineId), sql`${worldFacts.version} > ${revisionCursor}`, lte(worldFacts.simTime, simNow)))
      .orderBy(asc(worldFacts.version)).limit(fetchLimit),
    db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timelineId)),
    db.select({ id: persons.id, name: persons.name }).from(worldPersons).innerJoin(persons, eq(worldPersons.personId, persons.id)).where(eq(worldPersons.worldId, worldId)),
    db.select({ id: commitments.id, title: commitments.title }).from(commitments).where(and(eq(commitments.worldId, worldId), eq(commitments.timelineId, timelineId))),
  ])
  const eventRowsHaveMore = eventRowsRaw.length === fetchLimit
  const factRowsHaveMore = factRowsRaw.length === fetchLimit
  const eventRows = eventRowsRaw.slice(0, eventRowsHaveMore ? -1 : undefined)
  const factRows = factRowsRaw.slice(0, factRowsHaveMore ? -1 : undefined)
  const pageFacts = factRows
  const names = new Map(nameRows.map(row => [row.id, row.name]))
  const titles = new Map(commitmentRows.map(row => [row.id, row.title]))
  const commands = pageFacts.length
    ? await db.select().from(worldCommands).where(and(eq(worldCommands.timelineId, timelineId), inArray(worldCommands.id, pageFacts.map(fact => fact.sourceCommandId))))
    : []
  const commandIds = new Set(commands.map(command => command.id))
  const commandById = new Map(commands.map(command => [command.id, command]))

  // Resolve all events for the fetched facts in one read. The event id is a
  // deterministic projection of the command id (with the two domain-specific
  // ids handled above), so this never turns a same-time row into a false
  // source relation.
  const preferredEventIds = commands.map(eventIdForCommand)
  const matchingEvents = preferredEventIds.length
    ? await db.select({ event: events, cursor: sql<number>`rowid` }).from(events).where(and(
      eq(events.timelineId, timelineId),
      inArray(events.id, preferredEventIds),
    )).orderBy(asc(sql`rowid`))
    : []
  const eventsById = new Map(matchingEvents.map(row => [row.event.id, { ...row.event, cursor: row.cursor } satisfies ReviewEvent]))
  const eventForFact = (fact: ReviewFact): ReviewEvent | undefined => {
    const command = commandById.get(fact.sourceCommandId)
    if (!command) return undefined
    return eventsById.get(eventIdForCommand(command))
  }

  const sourceEventByFact = new Map(pageFacts.map(fact => [fact.id, eventForFact(fact)]))
  const matchedEventIds = new Set([...sourceEventByFact.values()].flatMap(event => event ? [event.id] : []))

  // Facts at or below the supplied revision watermark have already been
  // acknowledged. If an older client left the event cursor behind, suppress
  // their corresponding events here so a fact/event pair cannot reappear.
  const eventVersions = [...new Set(eventRows.map(row => row.event.createdVersion).filter((version): version is number => version !== null))]
  const acknowledgedFactVersions = revisionCursor > 0 && eventVersions.length
    ? await db.select({ version: worldFacts.version }).from(worldFacts).where(and(
      eq(worldFacts.timelineId, timelineId), lte(worldFacts.version, revisionCursor), inArray(worldFacts.version, eventVersions),
    ))
    : []
  const acknowledgedVersions = new Set(acknowledgedFactVersions.map(row => row.version))
  const eventCommandIds = [...new Set(eventRows.flatMap(row => {
    const id = row.event.id
    if (id.startsWith('command:')) return [id.slice('command:'.length)]
    // Commitment transition commands intentionally use the same domain id as
    // their event; retain that exact relation for legacy rows without a
    // created_version value.
    if (id.startsWith('commitment:')) return [id]
    return []
  }))]
  const acknowledgedSourceCommands = revisionCursor > 0 && eventCommandIds.length
    ? await db.select({ sourceCommandId: worldFacts.sourceCommandId }).from(worldFacts).where(and(
      eq(worldFacts.timelineId, timelineId), lte(worldFacts.version, revisionCursor), inArray(worldFacts.sourceCommandId, eventCommandIds),
    ))
    : []
  const acknowledgedCommandIds = new Set(acknowledgedSourceCommands.map(row => row.sourceCommandId))

  const factCandidates: ReviewCandidate[] = []
  for (const fact of pageFacts) {
    const command = commandById.get(fact.sourceCommandId)
    const action = command ? safeJson(command.payloadJson) : {}
    const actorId = typeof action.actorPersonId === 'string' ? action.actorPersonId : null
    const actorName = actorId ? names.get(actorId) ?? null : null
    const display = displayFact(fact, actorName, titles.get(fact.subjectId))
    const match = sourceEventByFact.get(fact.id)
    const directlySourced = commandIds.has(fact.sourceCommandId)
    factCandidates.push({ stream: 'fact', fact, sourceEvent: match,
      change: { id: `fact:${fact.id}`, kind: 'fact', simTime: fact.simTime, title: display.title, description: display.description,
        eventId: match?.id ?? null, eventCursor: match?.cursor ?? null, factId: fact.id,
        revisionVersion: fact.version, sourceCommandId: directlySourced ? fact.sourceCommandId : null,
        actorPersonId: actorId, actorName, highlight: directlySourced ? display.highlight : null } })
  }

  const eventCandidates: ReviewCandidate[] = []
  for (const row of eventRows) {
    const event = { ...row.event, cursor: row.cursor } satisfies ReviewEvent
    const commandId = event.id.startsWith('command:') ? event.id.slice('command:'.length)
      : event.id.startsWith('commitment:') ? event.id : null
    if (matchedEventIds.has(event.id)
      || (event.createdVersion !== null && acknowledgedVersions.has(event.createdVersion))
      || (commandId !== null && acknowledgedCommandIds.has(commandId))) continue
    eventCandidates.push({ stream: 'event', event,
      change: { id: `event:${event.id}`, kind: 'event', simTime: event.simTime, title: event.title, description: event.description,
        eventId: event.id, eventCursor: event.cursor, factId: null, revisionVersion: null, sourceCommandId: null,
        actorPersonId: event.actorPersonId, actorName: event.actorPersonId ? names.get(event.actorPersonId) ?? null : null, highlight: null } })
  }

  // Each source stream remains ordered by its own watermark. Merging stream
  // heads rather than sorting one combined page prevents a later fact/event
  // from advancing past an earlier row that was left for the next page.
  const byChangeOrder = (a: ReviewCandidate, b: ReviewCandidate) =>
    a.change.simTime.localeCompare(b.change.simTime) || a.change.id.localeCompare(b.change.id)
  const orderedFacts = factCandidates.sort((a, b) => a.fact!.version - b.fact!.version)
  const orderedEvents = eventCandidates.sort((a, b) => a.event!.cursor - b.event!.cursor)
  const selected: ReviewCandidate[] = []
  let factIndex = 0
  let eventIndex = 0
  while (selected.length < limit && (factIndex < orderedFacts.length || eventIndex < orderedEvents.length)) {
    const fact = orderedFacts[factIndex]
    const event = orderedEvents[eventIndex]
    // A source event omitted because its fact is still waiting at the fact
    // stream head blocks every later event cursor. Resolve that fact first;
    // otherwise the later event would be returned again on the next page.
    const selectedFactIdSet = new Set(selected.flatMap(candidate => candidate.fact ? [candidate.fact.id] : []))
    const blockedSourceCursor = orderedFacts
      .filter(candidate => candidate.sourceEvent && !selectedFactIdSet.has(candidate.fact!.id))
      .map(candidate => candidate.sourceEvent!.cursor)
      .sort((a, b) => a - b)[0]
    const eventBlocked = event && blockedSourceCursor !== undefined && event.event!.cursor > blockedSourceCursor
    if (!event || (fact && (eventBlocked || byChangeOrder(fact, event) <= 0))) {
      selected.push(fact)
      factIndex++
    } else {
      selected.push(event)
      eventIndex++
    }
  }
  const changes = selected.map(candidate => candidate.change)

  // Advance only through a contiguous prefix of each stream. A matched event
  // is consumed with its selected fact; unmatched rows remain for the next
  // page. This keeps both watermarks monotonic without skipping an orphan row.
  const selectedFactIds = new Set(selected.flatMap(candidate => candidate.fact ? [candidate.fact.id] : []))
  const consumedEventIds = new Set(selected.flatMap(candidate => {
    if (candidate.event) return [candidate.event.id]
    if (candidate.fact) {
      const sourceEvent = sourceEventByFact.get(candidate.fact.id)
      return sourceEvent ? [sourceEvent.id] : []
    }
    return []
  }))
  let nextEventCursor = eventCursor
  for (const row of eventRows) {
    if (row.cursor <= nextEventCursor) continue
    const commandId = row.event.id.startsWith('command:') ? row.event.id.slice('command:'.length)
      : row.event.id.startsWith('commitment:') ? row.event.id : null
    if (consumedEventIds.has(row.event.id)
      || (row.event.createdVersion !== null && acknowledgedVersions.has(row.event.createdVersion))
      || (commandId !== null && acknowledgedCommandIds.has(commandId))) {
      nextEventCursor = row.cursor
      continue
    }
    break
  }
  let nextRevisionVersion = revisionCursor
  for (const candidate of orderedFacts) {
    if (candidate.fact!.version <= nextRevisionVersion) continue
    if (!selectedFactIds.has(candidate.fact!.id)) break
    nextRevisionVersion = candidate.fact!.version
  }

  const responseEvents = [...new Map(selected.flatMap(candidate => {
    const rows: ReviewEvent[] = []
    if (candidate.event) rows.push(candidate.event)
    if (candidate.sourceEvent) rows.push(candidate.sourceEvent)
    return rows
  }).map(event => [event.id, event])).values()].sort((a, b) => a.cursor - b.cursor)
  const hasMoreEvents = eventRowsHaveMore || eventCandidates.length > eventIndex
  const hasMoreFacts = factRowsHaveMore || orderedFacts.length > factIndex
  return {
    events: responseEvents.map(event => ({ ...event, actorName: event.actorPersonId ? names.get(event.actorPersonId) ?? null : null })),
    changes,
    nextEventCursor,
    nextRevisionVersion,
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
  let command = explicitCommandId
    ? await db.select().from(worldCommands).where(and(eq(worldCommands.id, explicitCommandId), eq(worldCommands.worldId, worldId), eq(worldCommands.timelineId, timelineId))).get()
    : event.createdVersion !== null
      ? await db.select().from(worldCommands).where(and(eq(worldCommands.worldId, worldId), eq(worldCommands.timelineId, timelineId), eq(worldCommands.resultVersion, event.createdVersion))).get()
      : null
  // Commitment transitions use the domain event id as their command id.
  // Resolve that exact relation for legacy rows whose created_version is null.
  if (!command && event.id.startsWith('commitment:')) {
    command = await db.select().from(worldCommands).where(and(
      eq(worldCommands.id, event.id), eq(worldCommands.worldId, worldId), eq(worldCommands.timelineId, timelineId),
    )).get()
  }
  const facts = command
    ? await db.select().from(worldFacts).where(and(eq(worldFacts.timelineId, timelineId), eq(worldFacts.sourceCommandId, command.id))).orderBy(asc(worldFacts.version))
    : event.createdVersion !== null
      ? await db.select().from(worldFacts).where(and(eq(worldFacts.timelineId, timelineId), eq(worldFacts.version, event.createdVersion), lte(worldFacts.simTime, currentSimNow)))
      : []
  const gaps: string[] = []
  if (!command) gaps.push('没有可核实的来源命令。')
  if (!facts.length) gaps.push('没有与事件直接关联的版本化事实。')
  const commandPayload = command ? parseJsonObject(command.payloadJson) : { value: {}, valid: true }
  if (command && !commandPayload.valid) gaps.push('来源命令载荷损坏，无法完整读取。')
  const factPayloads = facts.map(fact => ({ fact, parsed: parseJsonObject(fact.valueJson) }))
  if (factPayloads.some(item => !item.parsed.valid)) gaps.push('关联事实载荷损坏，无法完整读取。')

  let version: Awaited<ReturnType<typeof versionAtTime>> = null
  let reconstructed: Awaited<ReturnType<typeof reconstructAt>>
  try {
    version = await versionAtTime(db, timelineId, event.simTime)
    const moment = await checkMoment(db, worldId, timelineId, event.simTime)
    reconstructed = moment.ok ? await reconstructAt(db, worldId, timelineId, event.simTime) : moment
  } catch {
    // Preserve the original event when a snapshot or replay payload is
    // damaged; a failed read must close dependent operations instead of 500.
    reconstructed = { ok: false, reasonCode: 'integrity_mismatch', message: '该时点的历史快照损坏，无法完整重建。' }
  }
  const reconstructionReason = !reconstructed.ok ? reconstructed.message : null
  if (reconstructionReason) gaps.push(`该时点无法完整重建：${reconstructionReason}`)
  const projection = reconstructed.ok ? reconstructed.rows : null
  const visibleKnowledge = (projection?.worldFacts ?? []).filter(fact => fact.factType === 'knowledge').map(fact => {
    const value = parseJsonObject(fact.valueJson).value
    return { factId: fact.id, recipientName: typeof value.recipientId === 'string' ? names.get(value.recipientId) ?? null : null,
      topic: typeof value.topic === 'string' ? value.topic : '未标注主题', content: typeof value.content === 'string' ? value.content : '',
      certainty: value.certainty === 'fact' ? 'fact' as const : 'rumor' as const, simTime: fact.simTime }
  })
  const firstFactValue = factPayloads.find(item => item.parsed.valid)?.parsed.value ?? {}
  const location = dialogue?.location
    ?? (typeof commandPayload.value.location === 'string' ? commandPayload.value.location : null)
    ?? (typeof firstFactValue.location === 'string' ? firstFactValue.location : null)
  const actorId = event.actorPersonId
    ?? command?.actorId
    ?? (typeof commandPayload.value.actorPersonId === 'string' ? commandPayload.value.actorPersonId : null)
  const actorName = actorId ? names.get(actorId) ?? null : null
  const sourceComplete = Boolean(command && facts.length && commandPayload.valid && factPayloads.every(item => item.parsed.valid))
  return {
    timelineId,
    event: { id: event.id, simTime: event.simTime, title: event.title, description: event.description, kind: event.kind,
      actorPersonId: actorId, actorName, location },
    command: command ? { id: command.id, type: command.type, version: command.resultVersion,
      actorName: command.actorId ? names.get(command.actorId) ?? null : actorName } : null,
    facts: factPayloads.map(({ fact, parsed }) => ({ id: fact.id, factType: fact.factType, simTime: fact.simTime, version: fact.version,
      visibility: fact.visibility, subjectId: fact.subjectId, value: parsed.value, sourceCommandId: fact.sourceCommandId })),
    visibleKnowledge,
    stateSnapshot: (projection?.states ?? []).map(state => ({ personName: names.get(state.personId) ?? null, location: state.location, activity: state.activity, mood: state.mood })),
    reconstruction: reconstructed.ok
      ? { status: 'complete', simTime: reconstructed.simTime, version: version?.version ?? reconstructed.evidence.throughVersion,
          completeDomains: reconstructed.evidence.completeDomains, reason: null }
      : { status: 'unsupported', simTime: null, version: null, completeDomains: [], reason: reconstructed.message },
    gaps,
    forkAvailable: Boolean(sourceComplete && reconstructed.ok && version && Date.parse(event.simTime) <= Date.parse(currentSimNow)),
  }
}
