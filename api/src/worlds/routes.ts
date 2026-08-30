import { Hono } from 'hono'
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import { createDb, type Db } from '../db/client'
import { dialogues, events, persons, personStates, schedules, timelines, worldPersons, worlds } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import type { LocationDef } from '../agent/engine-context'
import { dialogueDetail, personFocus, worldSnapshot } from './queries'
import { streamWorld } from './stream'
import { draftWorld } from './draft'
import type { Env } from '../index'

type World = typeof worlds.$inferSelect

export const worldsRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
worldsRoutes.use('*', authMiddleware)

async function loadOwnedWorld(db: Db, worldId: string, userId: string): Promise<World | null> {
  const w = await db
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.userId, userId)))
    .get()
  return w ?? null
}

/** Quick World 骨架：一句话 → LLM 生成（不落库） */
worldsRoutes.post('/draft', async (c) => {
  const body = await c.req.json<{ prompt?: string }>().catch(() => ({}) as { prompt?: string })
  const prompt = body.prompt?.trim()
  if (!prompt) return c.json({ error: '请提供一句话描述' }, 400)
  try {
    return c.json(await draftWorld(c.env, prompt))
  } catch (e) {
    return c.json({ error: `骨架生成失败：${e instanceof Error ? e.message : '未知错误'}` }, 502)
  }
})

/** 确认创建世界：骨架 + 选定 1-6 人物 → 世界/关联/主线/初始状态，直接开跑 */
worldsRoutes.post('/', async (c) => {
  const body = await c.req
    .json<{ name?: string; description?: string; locations?: LocationDef[]; personIds?: string[] }>()
    .catch(() => null)
  const name = body?.name?.trim()
  const description = body?.description?.trim()
  const locations = Array.isArray(body?.locations)
    ? body!.locations.map((l) => ({ name: String(l?.name ?? '').trim(), description: String(l?.description ?? '').trim() })).filter((l) => l.name)
    : []
  const personIds = [...new Set((body?.personIds ?? []).map(String).filter(Boolean))]
  if (!body || !name || !description) return c.json({ error: 'name 与 description 必填' }, 400)
  if (locations.length < 5 || locations.length > 8) return c.json({ error: '地点需 5-8 个' }, 400)
  if (personIds.length < 1 || personIds.length > 6) return c.json({ error: '人物需 1-6 个' }, 400)

  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const owned = await db
    .select({ id: persons.id })
    .from(persons)
    .where(and(eq(persons.userId, userId), inArray(persons.id, personIds)))
    .all()
  if (owned.length !== personIds.length) return c.json({ error: '包含不属于你的人物' }, 403)

  const now = new Date().toISOString()
  const worldId = crypto.randomUUID()
  const mainTimelineId = crypto.randomUUID()
  await db.insert(worlds).values({
    id: worldId,
    userId,
    name,
    description,
    locationsJson: JSON.stringify(locations),
    status: 'running',
    callsToday: 0,
    callsDay: now.slice(0, 10),
    createdAt: now,
  })
  await db.insert(timelines).values({
    id: mainTimelineId,
    worldId,
    parentTimelineId: null,
    forkScenarioJson: null,
    simNow: now,
    createdAt: now,
    status: 'active',
    ancestorIdsJson: '[]',
  })
  // 初始状态：地点轮转分配（D18）
  for (let i = 0; i < personIds.length; i++) {
    const pid = personIds[i]
    await db.insert(worldPersons).values({ worldId, personId: pid, joinedAt: now })
    await db.insert(personStates).values({
      personId: pid,
      timelineId: mainTimelineId,
      simTime: now,
      location: locations[i % locations.length].name,
      activity: '刚来到这个世界，正在安顿',
      mood: '平静',
      goal: '安顿下来，开始日常',
      updatedRealAt: now,
      lastBeatSimTime: now,
    })
  }
  return c.json({ id: worldId, timelineId: mainTimelineId })
})

/** 本人世界列表 */
worldsRoutes.get('/', async (c) => {
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const list = await db.select().from(worlds).where(eq(worlds.userId, userId)).all()
  const out = []
  for (const w of list) {
    const main = await db
      .select()
      .from(timelines)
      .where(and(eq(timelines.worldId, w.id), isNull(timelines.parentTimelineId)))
      .get()
    const pc = await db.select({ n: count() }).from(worldPersons).where(eq(worldPersons.worldId, w.id)).get()
    out.push({
      id: w.id,
      name: w.name,
      description: w.description,
      status: w.status,
      pauseReason: w.pauseReason,
      isDemo: w.isDemo,
      callsToday: w.callsToday,
      personCount: pc?.n ?? 0,
      simNow: main?.simNow ?? null,
      createdAt: w.createdAt,
    })
  }
  out.sort((a, b) => (b.simNow ?? '').localeCompare(a.simNow ?? ''))
  return c.json({ worlds: out })
})

/** 对话逐句展开（注意：注册在 /:id 之前，否则 "dialogues" 会被当成世界 id） */
worldsRoutes.get('/dialogues/:id', async (c) => {
  const db = createDb(c.env.DB)
  const detail = await dialogueDetail(db, c.req.param('id'))
  if (!detail) return c.json({ error: '对话不存在' }, 404)
  // 归属：dialogue → timeline → world → userId
  const tl = await db.select().from(timelines).where(eq(timelines.id, detail.dialogue.timelineId)).get()
  const world = tl ? await loadOwnedWorld(db, tl.worldId, c.get('user').id) : null
  if (!world) return c.json({ error: '对话不存在' }, 404)
  return c.json(detail)
})

/** 世界快照（世界视图首屏） */
worldsRoutes.get('/:id', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const snapshot = await worldSnapshot(db, world.id, c.req.query('timelineId') || undefined)
  if (!snapshot) return c.json({ error: '世界没有时间线' }, 404)
  return c.json(snapshot)
})

/** SSE 增量推送（N2：新事件/新想法/新对话 2 秒内出现在打开的页面） */
worldsRoutes.get('/:id/stream', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
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

/** 人物详情（状态/想法流/当日日程/近期记忆） */
worldsRoutes.get('/:id/persons/:pid', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const timelineId = c.req.query('timelineId')
  if (!timelineId) return c.json({ error: 'timelineId 必填' }, 400)
  const focus = await personFocus(db, world.id, c.req.param('pid'), timelineId)
  if (!focus) return c.json({ error: '人物或时间线不存在' }, 404)
  return c.json(focus)
})

/** 暂停（手动）：时钟停走、不再产生 LLM 调用 */
worldsRoutes.post('/:id/pause', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  await db.update(worlds).set({ status: 'paused', pauseReason: 'manual' }).where(eq(worlds.id, world.id))
  return c.json({ ok: true, status: 'paused' })
})

/** 继续：从暂停点恢复；同时复位当日用量（含触顶后的手动复位） */
worldsRoutes.post('/:id/resume', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const now = new Date().toISOString()
  await db
    .update(worlds)
    .set({ status: 'running', pauseReason: null, callsToday: 0, callsDay: now.slice(0, 10) })
    .where(eq(worlds.id, world.id))
  return c.json({ ok: true, status: 'running' })
})

/** 注入事件：写 kind='injected' 事件，当前线的人物于下一拍感知并反应（F7） */
worldsRoutes.post('/:id/inject', async (c) => {
  const body = await c.req.json<{ text?: string; timelineId?: string }>().catch(() => null)
  const text = body?.text?.trim()
  if (!text) return c.json({ error: '事件内容不能为空' }, 400)

  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)

  const tls = await db.select().from(timelines).where(eq(timelines.worldId, world.id)).all()
  const tl = (body?.timelineId && tls.find((t) => t.id === body.timelineId)) || tls.find((t) => t.parentTimelineId === null)
  if (!tl) return c.json({ error: '时间线不存在' }, 404)

  const id = crypto.randomUUID()
  await db.insert(events).values({
    id,
    timelineId: tl.id,
    simTime: tl.simNow,
    title: text.slice(0, 20),
    description: text,
    kind: 'injected',
  })
  return c.json({ id, timelineId: tl.id, simTime: tl.simNow })
})

/** 世界级 Fork（F9）：复制世界设定与全部人物状态/当日日程到新线；记忆经可见性规则自然继承 */
worldsRoutes.post('/:id/timelines/:tid/fork', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)

  const source = await db
    .select()
    .from(timelines)
    .where(and(eq(timelines.id, c.req.param('tid')), eq(timelines.worldId, world.id)))
    .get()
  if (!source) return c.json({ error: '时间线不存在' }, 404)
  if (source.status !== 'active') return c.json({ error: '只能分叉活跃时间线' }, 400)

  const activeCount = await db
    .select({ n: count() })
    .from(timelines)
    .where(and(eq(timelines.worldId, world.id), eq(timelines.status, 'active')))
    .get()
  if ((activeCount?.n ?? 0) >= 3) {
    return c.json({ error: '活跃时间线已达上限（3 条），请先归档一条' }, 409)
  }

  let ancestors: string[] = []
  try {
    ancestors = (JSON.parse(source.ancestorIdsJson || '[]') as string[]).map(String)
  } catch {
    ancestors = []
  }
  const now = new Date().toISOString()
  const forkId = crypto.randomUUID()
  await db.insert(timelines).values({
    id: forkId,
    worldId: world.id,
    parentTimelineId: source.id,
    forkScenarioJson: null,
    simNow: source.simNow,
    createdAt: now,
    status: 'active',
    ancestorIdsJson: JSON.stringify([...ancestors, source.id]),
  })

  // 复制全部人物状态（对话占用不带过去）与当日日程
  const states = await db.select().from(personStates).where(eq(personStates.timelineId, source.id)).all()
  for (const s of states) {
    await db.insert(personStates).values({
      personId: s.personId,
      timelineId: forkId,
      simTime: s.simTime,
      location: s.location,
      activity: s.activity,
      mood: s.mood,
      goal: s.goal,
      updatedRealAt: now,
      currentDialogueId: null,
      lastBeatSimTime: s.lastBeatSimTime,
    })
  }
  const worldDate = source.simNow.slice(0, 10)
  const scheduleRows = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.timelineId, source.id), eq(schedules.worldDate, worldDate)))
    .all()
  for (const s of scheduleRows) {
    await db
      .insert(schedules)
      .values({
        personId: s.personId,
        timelineId: forkId,
        worldDate: s.worldDate,
        itemsJson: s.itemsJson,
        generatedAt: s.generatedAt,
      })
      .onConflictDoNothing()
  }
  return c.json({ id: forkId, simNow: source.simNow })
})
