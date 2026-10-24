import { and, asc, count, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import { conversations, events, messages, persons, timelines, worldPersons, worlds } from '../db/schema'
import type { AccessContext } from '../access/types'
import type { WorldTimeContext } from '@wispiva/world-contract'
import { effectiveTimeZone } from '../worlds/time-zone'
import { readOwnedWorldContexts } from '../worlds/time-context'

type UserAccess = Extract<AccessContext, { kind: 'user' }>

export interface HomeOverview {
  persons: Array<{ id: string; name: string; createdAt: string; lastActivity: string }>
  timelines: Array<{
    id: string
    worldId: string
    worldName: string
    personId: string
    personName: string
    parentTimelineId: string | null
    simNow: string
    timeZone: string
    eventCount: number
    timeContext: WorldTimeContext | null
  }>
  worlds: Array<{
    id: string
    name: string
    status: string
    pauseReason: string | null
    isDemo: boolean
    simNow: string | null
    timeZone: string
    personCount: number
    todayEventCount: number
    timeContext?: WorldTimeContext
  }>
}

export async function readHome(db: Db, access: UserAccess): Promise<HomeOverview> {
  const userId = access.userId
  const [personList, worldContexts] = await Promise.all([
    db.select().from(persons).where(eq(persons.userId, userId)).all(),
    readOwnedWorldContexts(db, access),
  ])

  const convos = personList.length
    ? await db.select().from(conversations).where(eq(conversations.userId, userId)).all()
    : []
  const lastMsgByPerson = new Map<string, string>()
  if (convos.length) {
    const rows = await db.select({ conversationId: messages.conversationId, createdAt: messages.createdAt })
      .from(messages)
      .where(inArray(messages.conversationId, convos.map(conversation => conversation.id)))
      .all()
    const convoPerson = new Map(convos.map(conversation => [conversation.id, conversation.personId]))
    for (const message of rows) {
      const personId = convoPerson.get(message.conversationId)
      if (!personId) continue
      const current = lastMsgByPerson.get(personId)
      if (!current || message.createdAt > current) lastMsgByPerson.set(personId, message.createdAt)
    }
  }
  const personsOut = personList
    .map(person => ({
      id: person.id,
      name: person.name,
      createdAt: person.createdAt,
      lastActivity: lastMsgByPerson.get(person.id) ?? person.createdAt,
    }))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))

  const worldById = new Map(worldContexts.worlds.map(world => [world.id, world]))
  const worldRows = worldContexts.timelines.flatMap(timeline => {
    const world = worldById.get(timeline.worldId)
    return world ? [{ world, timeline }] : []
  })
  const eventCounts = worldRows.length
    ? await db.select({ timelineId: events.timelineId, n: count() })
      .from(events)
      .innerJoin(timelines, eq(events.timelineId, timelines.id))
      .innerJoin(worlds, and(eq(timelines.worldId, worlds.id), eq(worlds.userId, userId)))
      .groupBy(events.timelineId)
      .all()
    : []
  const countByTimeline = new Map(eventCounts.map(row => [row.timelineId, row.n]))
  const personName = new Map(personList.map(person => [person.id, person.name]))
  const memberRows = worldContexts.worlds.length
    ? await db.select({ worldId: worldPersons.worldId, personId: worldPersons.personId })
      .from(worldPersons)
      .innerJoin(worlds, eq(worldPersons.worldId, worlds.id))
      .where(eq(worlds.userId, userId))
      .orderBy(asc(worldPersons.joinedAt))
      .all()
    : []
  const firstPersonByWorld = new Map<string, string>()
  for (const row of memberRows) {
    if (!firstPersonByWorld.has(row.worldId)) firstPersonByWorld.set(row.worldId, row.personId)
  }
  const timelinesOut = worldRows.map(({ world, timeline }) => {
    const personId = firstPersonByWorld.get(world.id) ?? ''
    return {
      id: timeline.id,
      worldId: world.id,
      worldName: world.name,
      personId,
      personName: personName.get(personId) ?? '',
      parentTimelineId: timeline.parentTimelineId,
      simNow: timeline.simNow,
      timeZone: effectiveTimeZone(world.timeZone),
      eventCount: countByTimeline.get(timeline.id) ?? 0,
      timeContext: worldContexts.byTimeline.get(timeline.id) ?? null,
    }
  }).sort((a, b) => b.simNow.localeCompare(a.simNow))

  const timelinesByWorld = new Map<string, typeof worldRows>()
  for (const row of worldRows) {
    const rows = timelinesByWorld.get(row.world.id) ?? []
    rows.push(row)
    timelinesByWorld.set(row.world.id, rows)
  }
  const personCountByWorld = new Map<string, number>()
  for (const row of memberRows) personCountByWorld.set(row.worldId, (personCountByWorld.get(row.worldId) ?? 0) + 1)
  const worldsOut = worldContexts.worlds.map(world => {
    const worldTimelines = timelinesByWorld.get(world.id) ?? []
    const mainTimeline = worldTimelines.find(row => row.timeline.parentTimelineId === null)?.timeline ?? worldTimelines[0]?.timeline ?? null
    const todayEventCount = worldTimelines.reduce((sum, row) => sum + (countByTimeline.get(row.timeline.id) ?? 0), 0)
    const timeContext = mainTimeline ? worldContexts.byTimeline.get(mainTimeline.id) : undefined
    return {
      id: world.id,
      name: world.name,
      status: world.status,
      pauseReason: world.pauseReason,
      isDemo: world.isDemo,
      simNow: mainTimeline?.simNow ?? null,
      timeZone: effectiveTimeZone(world.timeZone),
      personCount: personCountByWorld.get(world.id) ?? 0,
      todayEventCount,
      timeContext,
    }
  }).sort((a, b) => (b.simNow ?? '').localeCompare(a.simNow ?? ''))

  return { persons: personsOut, timelines: timelinesOut, worlds: worldsOut }
}
