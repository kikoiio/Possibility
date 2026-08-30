import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import { createDb, type Db } from '../db/client'
import { timelines, worlds } from '../db/schema'
import { dialogueDetail, personFocus, worldSnapshot } from '../worlds/queries'
import { streamWorld } from '../worlds/stream'
import type { Env } from '../index'

type World = typeof worlds.$inferSelect

/**
 * 访客橱窗（M5）：免登录只读，仅放行 isDemo=1 的世界。
 * 本文件不注册任何 POST/PUT/DELETE（N6）。
 */
export const publicRoutes = new Hono<{ Bindings: Env }>()

async function loadDemoWorld(db: Db, id: string): Promise<World | null> {
  const w = await db.select().from(worlds).where(and(eq(worlds.id, id), eq(worlds.isDemo, true))).get()
  return w ?? null
}

/** 落地页入口：首个演示世界的基本信息 */
publicRoutes.get('/demo', async (c) => {
  const db = createDb(c.env.DB)
  const w = await db.select().from(worlds).where(eq(worlds.isDemo, true)).get()
  if (!w) return c.json({ error: '演示世界不存在' }, 404)
  return c.json({ id: w.id, name: w.name, description: w.description })
})

/** 演示世界快照 */
publicRoutes.get('/worlds/:id', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadDemoWorld(db, c.req.param('id'))
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const snapshot = await worldSnapshot(db, world.id, c.req.query('timelineId') || undefined)
  if (!snapshot) return c.json({ error: '世界没有时间线' }, 404)
  return c.json(snapshot)
})

/** 演示世界 SSE（复用 T19 推送逻辑，强制 demo 校验） */
publicRoutes.get('/worlds/:id/stream', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadDemoWorld(db, c.req.param('id'))
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const timelineId = c.req.query('timelineId')
  if (!timelineId) return c.json({ error: 'timelineId 必填' }, 400)
  const tl = await db
    .select()
    .from(timelines)
    .where(and(eq(timelines.id, timelineId), eq(timelines.worldId, world.id)))
    .get()
  if (!tl) return c.json({ error: '时间线不存在' }, 404)
  return streamSSE(c, async (stream) => {
    await streamWorld(db, stream, c, world.id, tl.id)
  })
})

/** 演示世界人物详情 */
publicRoutes.get('/worlds/:id/persons/:pid', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadDemoWorld(db, c.req.param('id'))
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const timelineId = c.req.query('timelineId')
  if (!timelineId) return c.json({ error: 'timelineId 必填' }, 400)
  const focus = await personFocus(db, world.id, c.req.param('pid'), timelineId)
  if (!focus) return c.json({ error: '人物或时间线不存在' }, 404)
  return c.json(focus)
})

/** 演示世界对话逐句展开（须属于该演示世界的时间线） */
publicRoutes.get('/dialogues/:id', async (c) => {
  const db = createDb(c.env.DB)
  const detail = await dialogueDetail(db, c.req.param('id'))
  if (!detail) return c.json({ error: '对话不存在' }, 404)
  const tl = await db.select().from(timelines).where(eq(timelines.id, detail.dialogue.timelineId)).get()
  const world = tl ? await loadDemoWorld(db, tl.worldId) : null
  if (!world) return c.json({ error: '对话不存在' }, 404)
  return c.json(detail)
})

// 兜底：/api/public/* 的一切写操作与未定义路径一律 404（N6 只读；防止穿透到下游认证中间件）
publicRoutes.all('*', (c) => c.json({ error: '不存在' }, 404))
