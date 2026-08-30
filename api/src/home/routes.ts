import { Hono } from 'hono'
import { asc, count, eq, inArray } from 'drizzle-orm'
import { createDb } from '../db/client'
import { conversations, events, messages, persons, timelines, worldPersons, worlds } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import type { Env } from '../index'

export const homeRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
homeRoutes.use('*', authMiddleware)

/** 首页聚合：人物按最近活动排序 + 进行中的时间线（F14） */
homeRoutes.get('/', async (c) => {
  const db = createDb(c.env.DB)
  const userId = c.get('user').id

  const personList = await db.select().from(persons).where(eq(persons.userId, userId)).all()

  // 每个人物的最近活动时间（最近一条消息；无消息则为创建时间）
  const convos = personList.length
    ? await db.select().from(conversations).where(eq(conversations.userId, userId)).all()
    : []
  const lastMsgByPerson = new Map<string, string>()
  if (convos.length) {
    const rows = await db
      .select({ conversationId: messages.conversationId, createdAt: messages.createdAt })
      .from(messages)
      .where(
        inArray(
          messages.conversationId,
          convos.map((x) => x.id),
        ),
      )
      .all()
    const convoPerson = new Map(convos.map((x) => [x.id, x.personId]))
    for (const m of rows) {
      const pid = convoPerson.get(m.conversationId)
      if (!pid) continue
      const cur = lastMsgByPerson.get(pid)
      if (!cur || m.createdAt > cur) lastMsgByPerson.set(pid, m.createdAt)
    }
  }
  const personsOut = personList
    .map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      lastActivity: lastMsgByPerson.get(p.id) ?? p.createdAt,
    }))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))

  // 进行中的时间线（主线与各 fork 的 simNow、事件数）
  const worldRows = await db
    .select({ timeline: timelines, world: worlds })
    .from(timelines)
    .innerJoin(worlds, eq(timelines.worldId, worlds.id))
    .where(eq(worlds.userId, userId))
    .all()
  const evCounts = worldRows.length
    ? await db
        .select({ timelineId: events.timelineId, n: count() })
        .from(events)
        .where(
          inArray(
            events.timelineId,
            worldRows.map((r) => r.timeline.id),
          ),
        )
        .groupBy(events.timelineId)
        .all()
    : []
  const countMap = new Map(evCounts.map((r) => [r.timelineId, r.n]))
  const personName = new Map(personList.map((p) => [p.id, p.name]))
  // 世界 → 首个成员（world_persons 按 joinedAt 最早；多人物世界在首页时间线区块仍显示首个人物）
  const worldIds = [...new Set(worldRows.map((r) => r.world.id))]
  const wpRows = worldIds.length
    ? await db
        .select()
        .from(worldPersons)
        .where(inArray(worldPersons.worldId, worldIds))
        .orderBy(asc(worldPersons.joinedAt))
        .all()
    : []
  const firstPersonByWorld = new Map<string, string>()
  for (const row of wpRows) {
    if (!firstPersonByWorld.has(row.worldId)) firstPersonByWorld.set(row.worldId, row.personId)
  }
  const timelinesOut = worldRows
    .map((r) => {
      const pid = firstPersonByWorld.get(r.world.id) ?? ''
      return {
        id: r.timeline.id,
        worldId: r.world.id,
        worldName: r.world.name,
        personId: pid,
        personName: personName.get(pid) ?? '',
        parentTimelineId: r.timeline.parentTimelineId,
        simNow: r.timeline.simNow,
        eventCount: countMap.get(r.timeline.id) ?? 0,
      }
    })
    .sort((a, b) => b.simNow.localeCompare(a.simNow))

  // 「运行中的世界」区块：本人世界（含演示世界）的引擎状态一览
  const myWorlds = await db.select().from(worlds).where(eq(worlds.userId, userId)).all()
  const personCountByWorld = new Map<string, number>()
  for (const row of wpRows) {
    personCountByWorld.set(row.worldId, (personCountByWorld.get(row.worldId) ?? 0) + 1)
  }
  const worldsOut = []
  for (const w of myWorlds) {
    const wtls = worldRows.filter((r) => r.world.id === w.id)
    const mainTl = wtls.find((r) => r.timeline.parentTimelineId === null)?.timeline ?? wtls[0]?.timeline ?? null
    const todayEvents = wtls.reduce((sum, r) => sum + (countMap.get(r.timeline.id) ?? 0), 0)
    worldsOut.push({
      id: w.id,
      name: w.name,
      status: w.status,
      pauseReason: w.pauseReason,
      isDemo: w.isDemo,
      simNow: mainTl?.simNow ?? null,
      personCount: personCountByWorld.get(w.id) ?? 0,
      todayEventCount: todayEvents,
    })
  }
  worldsOut.sort((a, b) => (b.simNow ?? '').localeCompare(a.simNow ?? ''))

  return c.json({ persons: personsOut, timelines: timelinesOut, worlds: worldsOut })
})
