import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { createDb } from '../db/client'
import { chapters, timelines, worlds } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { generateChapter } from './generate'
import type { Env } from '../index'

export const chapterRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
chapterRoutes.use('/worlds/:id/chapters', authMiddleware)
chapterRoutes.use('/chapters/:id', authMiddleware)

async function loadOwnedWorld(db: ReturnType<typeof createDb>, worldId: string, userId: string) {
  const w = await db
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.userId, userId)))
    .get()
  return w ?? null
}

/** 生成章节：当前时间线「上一章之后」的事件 → 小说化回顾（1 次 LLM 调用，走护栏） */
chapterRoutes.post('/worlds/:id/chapters', async (c) => {
  const body = await c.req.json<{ timelineId?: string }>().catch(() => ({}) as { timelineId?: string })
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)

  const tls = await db.select().from(timelines).where(eq(timelines.worldId, world.id)).all()
  if (body.timelineId !== undefined && (typeof body.timelineId !== 'string' || !body.timelineId.trim())) {
    return c.json({ error: '时间线 ID 无效' }, 400)
  }
  const timeline = body.timelineId !== undefined
    ? tls.find((t) => t.id === body.timelineId && t.status === 'active')
    : tls.find((t) => t.parentTimelineId === null) || tls[0]
  if (!timeline) return c.json({ error: '时间线不存在' }, 404)

  try {
    const chapter = await generateChapter(c.env, db, world, timeline)
    return c.json(chapter)
  } catch (e) {
    const status = (e as { status?: number }).status ?? 502
    return c.json({ error: e instanceof Error ? e.message : '章节生成失败' }, status as 400 | 409 | 429)
  }
})

/** 章节列表（当前时间线，新→旧） */
chapterRoutes.get('/worlds/:id/chapters', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const timelineId = c.req.query('timelineId')
  if (timelineId !== undefined) {
    const timeline = await db.select({ id: timelines.id }).from(timelines)
      .where(and(eq(timelines.id, timelineId), eq(timelines.worldId, world.id))).get()
    if (!timeline) return c.json({ error: '时间线不存在' }, 404)
  }
  const rows = await db
    .select({
      id: chapters.id,
      timelineId: chapters.timelineId,
      title: chapters.title,
      fromSim: chapters.fromSim,
      toSim: chapters.toSim,
      eventCount: chapters.eventCount,
      createdAt: chapters.createdAt,
    })
    .from(chapters)
    .where(and(eq(chapters.worldId, world.id), timelineId !== undefined ? eq(chapters.timelineId, timelineId) : undefined))
    .orderBy(desc(chapters.createdAt))
    .limit(50)
    .all()
  return c.json({ chapters: rows })
})

/** 章节全文（归属校验：chapter → world → user） */
chapterRoutes.get('/chapters/:id', async (c) => {
  const db = createDb(c.env.DB)
  const chapter = await db.select().from(chapters).where(eq(chapters.id, c.req.param('id'))).get()
  if (!chapter) return c.json({ error: '章节不存在' }, 404)
  const world = await loadOwnedWorld(db, chapter.worldId, c.get('user').id)
  if (!world) return c.json({ error: '章节不存在' }, 404)
  return c.json(chapter)
})
