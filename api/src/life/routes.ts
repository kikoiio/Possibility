import { Hono } from 'hono'
import { and, desc, eq, lte, sql } from 'drizzle-orm'
import { createDb } from '../db/client'
import { commitments, events, personaMessages, persons, timelines, worldFacts, worldPersons, worldVisits, worlds } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import type { Env } from '../index'
import { canFulfill, nextCommitmentStatus, transitionCommitment, type LifeAction } from './service'
import { touchWorldActivity } from '../engine/budget'
import { WorldStateError } from '../world-state/types'
import { gateUniverseWrite } from '../engine/guard'
import { getEventEvidenceDetail, getReturnPage } from './evidence'

export const lifeRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
lifeRoutes.use('*', authMiddleware)

async function scope(db: ReturnType<typeof createDb>, worldId: string, timelineId: string | undefined, userId: string) {
  const world = await db.select().from(worlds).where(and(eq(worlds.id, worldId), eq(worlds.userId, userId))).get()
  if (!world) return null
  const tls = await db.select().from(timelines).where(eq(timelines.worldId, worldId)).all()
  const tl = timelineId !== undefined ? tls.find(t => t.id === timelineId) : tls.find(t => !t.parentTimelineId)
  return tl ? { world, tl } : null
}

lifeRoutes.get('/worlds/:id/return', async c => {
  const db = createDb(c.env.DB)
  const s = await scope(db, c.req.param('id'), c.req.query('timelineId'), c.get('user').id)
  if (!s) return c.json({ error: '世界或时间线不存在' }, 404)
  const visit = await db.select().from(worldVisits).where(and(eq(worldVisits.userId, c.get('user').id), eq(worldVisits.timelineId, s.tl.id))).get()
  const requestedLimit = Number(c.req.query('limit') ?? 30)
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) return c.json({ error: 'limit 必须是 1–50 的整数' }, 400)
  const eventCursor = Number(c.req.query('eventCursor') ?? visit?.eventCursor ?? 0)
  const revisionCursor = Number(c.req.query('revisionVersion') ?? visit?.revisionVersion ?? 0)
  if (!Number.isSafeInteger(eventCursor) || eventCursor < 0 || !Number.isSafeInteger(revisionCursor) || revisionCursor < 0) {
    return c.json({ error: '无效的回顾游标' }, 400)
  }
  const page = await getReturnPage(db, s.world.id, s.tl.id, s.tl.simNow, eventCursor, revisionCursor, requestedLimit)
  const members = await db.select({ id: persons.id, name: persons.name, isUser: persons.isUser }).from(worldPersons).innerJoin(persons, eq(worldPersons.personId, persons.id)).where(eq(worldPersons.worldId, s.world.id)).all()
  const nameOf = new Map(members.map(p => [p.id, p.name]))
  const visitor = members.find(p => p.isUser)
  const promises = await db.select().from(commitments).where(eq(commitments.timelineId, s.tl.id)).orderBy(desc(commitments.updatedSim)).limit(40).all()
  const inbox = visitor ? await db.select().from(personaMessages).where(and(eq(personaMessages.timelineId, s.tl.id), eq(personaMessages.recipientPersonId, visitor.id), eq(personaMessages.read, false))).limit(20).all() : []
  const highlightCount = page.changes.filter(change => change.highlight !== null).length
  const summary = page.changes.length
    ? `新增 ${page.changes.length} 项记录${highlightCount ? `，其中 ${highlightCount} 项状态或约定变化` : ''}。`
    : '这段时间没有新的记录。'
  return c.json({ timelineId: s.tl.id, simNow: s.tl.simNow, firstVisit: !visit, cursor: page.nextEventCursor,
    revisionVersion: page.nextRevisionVersion, eventCursor: page.nextEventCursor, nextEventCursor: page.nextEventCursor,
    nextRevisionVersion: page.nextRevisionVersion, hasMore: page.hasMoreEvents || page.hasMoreFacts,
    summary, changes: page.changes,
    events: page.events.map(e => ({ ...e, actorName: e.actorName ?? (e.actorPersonId ? nameOf.get(e.actorPersonId) ?? null : null) })),
    commitments: promises.map(p => ({ ...p, personName: nameOf.get(p.personId) ?? '某人' })), unread: inbox.length,
    // 回顾只展示数据库中的事实，不让模型臆测离开时发生的事。
  })
})

lifeRoutes.get('/worlds/:id/events/:eventId/evidence', async c => {
  const db = createDb(c.env.DB)
  const timelineId = c.req.query('timelineId')
  if (!timelineId) return c.json({ error: 'timelineId 必填' }, 400)
  const s = await scope(db, c.req.param('id'), timelineId, c.get('user').id)
  if (!s) return c.json({ error: '世界或时间线不存在' }, 404)
  const detail = await getEventEvidenceDetail(db, s.world.id, s.tl.id, c.req.param('eventId'), s.tl.simNow)
  if (!detail) return c.json({ error: '事件不存在或超出当前模拟时刻' }, 404)
  return c.json(detail)
})

lifeRoutes.post('/worlds/:id/return/seen', async c => {
  const body = await c.req.json<{ timelineId?: string; cursor?: number; eventCursor?: number; revisionVersion?: number }>().catch(() => null)
  if (!body) return c.json({ error: '无效的事件水位' }, 400)
  const cursor = body.eventCursor ?? body.cursor
  const revisionVersion = body.revisionVersion ?? 0
  if (!Number.isSafeInteger(cursor) || cursor! < 0 || !Number.isSafeInteger(revisionVersion) || revisionVersion < 0) return c.json({ error: '无效的回顾水位' }, 400)
  const db = createDb(c.env.DB)
  const s = await scope(db, c.req.param('id'), body.timelineId, c.get('user').id)
  if (!s) return c.json({ error: '世界或时间线不存在' }, 404)
  if (cursor! > 0) {
    const row = await db.select({ id: events.id }).from(events).where(and(eq(events.timelineId, s.tl.id), sql`rowid = ${cursor}`, lte(events.simTime, s.tl.simNow))).get()
    if (!row) return c.json({ error: '事件水位不属于当前时间线或尚未发生' }, 400)
  }
  if (revisionVersion > 0) {
    const row = await db.select({ id: worldFacts.id }).from(worldFacts).where(and(eq(worldFacts.timelineId, s.tl.id), eq(worldFacts.version, revisionVersion), lte(worldFacts.simTime, s.tl.simNow))).get()
    if (!row) return c.json({ error: '事实版本水位不属于当前时间线或尚未发生' }, 400)
  }
  await db.insert(worldVisits).values({ userId: c.get('user').id, timelineId: s.tl.id, eventCursor: cursor!, revisionVersion, seenAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: [worldVisits.userId, worldVisits.timelineId], set: {
      eventCursor: sql`max(${worldVisits.eventCursor}, ${cursor})`,
      revisionVersion: sql`max(${worldVisits.revisionVersion}, ${revisionVersion})`,
      seenAt: new Date().toISOString(),
    } })
  await touchWorldActivity(db, s.world.id)
  return c.json({ ok: true })
})

lifeRoutes.post('/worlds/:id/commitments/:commitmentId', async c => {
  const body = await c.req.json<{ action?: LifeAction; explanation?: string }>().catch(() => null)
  if (!body?.action || !['accept', 'decline', 'fulfill', 'explain'].includes(body.action)) return c.json({ error: '无效操作' }, 400)
  const db = createDb(c.env.DB)
  const item = await db.select().from(commitments).where(and(eq(commitments.id, c.req.param('commitmentId')), eq(commitments.worldId, c.req.param('id')))).get()
  if (!item) return c.json({ error: '约定不存在' }, 404)
  const s = await scope(db, item.worldId, item.timelineId, c.get('user').id)
  if (!s) return c.json({ error: '约定不存在' }, 404)
  const gate = await gateUniverseWrite(db, s.world.id, s.tl.id)
  if (!gate.ok) return c.json({ error: gate.error }, gate.status)
  const next = nextCommitmentStatus(item.status, body.action)
  // 重复点击成功的动作是幂等读取；不重复写入后果。
  const resultStatus = { accept: 'accepted', decline: 'declined', fulfill: 'fulfilled', explain: 'explained' }[body.action]
  if (!next) return item.status === resultStatus ? c.json({ ok: true, status: item.status }) : c.json({ error: '约定状态已改变，请刷新。' }, 409)
  if (['accept', 'fulfill'].includes(body.action) && s.tl.simNow >= item.dueSim) return c.json({ error: '约定已经到期，请刷新查看后续。' }, 409)
  if (body.action === 'fulfill') {
    const reason = await canFulfill(db, item, s.tl.simNow)
    if (reason) return c.json({ error: reason }, 409)
  }
  const explanation = typeof body.explanation === 'string' ? body.explanation.trim().slice(0, 500) : ''
  if (body.action === 'explain' && !explanation) return c.json({ error: '请写下你想对对方说的话。' }, 400)
  try { await transitionCommitment(db, item, next, s.tl.simNow, explanation) }
  catch (error) {
    if (error instanceof WorldStateError) return c.json({ error: error.message }, error.status)
    throw error
  }
  const updated = await db.select().from(commitments).where(eq(commitments.id, item.id)).get()
  await touchWorldActivity(db, s.world.id)
  if (updated?.status !== next) return c.json({ error: '约定刚刚改变，请刷新。' }, 409)
  return c.json({ ok: true, status: next })
})
