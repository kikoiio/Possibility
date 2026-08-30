import { Hono } from 'hono'
import { and, asc, desc, eq } from 'drizzle-orm'
import { createDb } from '../db/client'
import { persons, personStates, timelines, worldPersons, worlds } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { distillPerson, normalizeModel } from '../agent/distill'
import type { InitialState } from '../agent/types'
import { DEFAULT_WORLD_LOCATIONS } from '../worlds/defaults'
import type { Env } from '../index'

export const personRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
personRoutes.use('*', authMiddleware)

/** 蒸馏：描述 → 人物模型草稿（不落库） */
personRoutes.post('/distill', async (c) => {
  const body = await c.req.json<{ description?: string }>().catch(() => ({}) as { description?: string })
  const description = body.description?.trim()
  if (!description) return c.json({ error: '请提供人物描述' }, 400)
  try {
    const draft = await distillPerson(c.env, description)
    return c.json(draft)
  } catch (e) {
    return c.json({ error: `创建人物失败：${e instanceof Error ? e.message : '未知错误'}` }, 502)
  }
})

/** 创建人物：连带建默认世界 + 主线时间线 + 初始状态（一次批量写入） */
personRoutes.post('/', async (c) => {
  const body = await c.req
    .json<{
      name?: string
      model?: unknown
      worldName?: string
      worldDescription?: string
      initialState?: Partial<InitialState>
    }>()
    .catch(() => null)
  const name = body?.name?.trim()
  if (!body || !name || !body.model) return c.json({ error: 'name 与 model 必填' }, 400)
  const model = normalizeModel(body.model)
  const state = body.initialState ?? {}

  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const now = new Date().toISOString()
  const personId = crypto.randomUUID()
  const worldId = crypto.randomUUID()
  const timelineId = crypto.randomUUID()

  await db.batch([
    db.insert(persons).values({
      id: personId,
      userId,
      name,
      modelJson: JSON.stringify(model),
      createdAt: now,
    }),
    // 默认单人世界：status 走默认 paused，主人可从世界列表手动启动（D14 同理）
    db.insert(worlds).values({
      id: worldId,
      userId,
      name: body.worldName?.trim() || `${name}的世界`,
      description: body.worldDescription?.trim() || '一个普通的世界。',
      locationsJson: JSON.stringify(DEFAULT_WORLD_LOCATIONS),
      createdAt: now,
    }),
    db.insert(worldPersons).values({ worldId, personId, joinedAt: now }),
    db.insert(timelines).values({
      id: timelineId,
      worldId,
      parentTimelineId: null,
      forkScenarioJson: null,
      simNow: now,
      createdAt: now,
    }),
    db.insert(personStates).values({
      personId,
      timelineId,
      simTime: now,
      location: state.location?.trim() || '未知地点',
      activity: state.activity?.trim() || '未知活动',
      mood: state.mood?.trim() || '平静',
      goal: state.goal?.trim() || '暂无',
      updatedRealAt: now,
    }),
  ])
  return c.json({ id: personId })
})

personRoutes.get('/', async (c) => {
  const db = createDb(c.env.DB)
  const list = await db
    .select()
    .from(persons)
    .where(eq(persons.userId, c.get('user').id))
    .orderBy(desc(persons.createdAt))
    .all()
  return c.json({
    persons: list.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt })),
  })
})

/** 详情：person + 主线 state + world + timelines */
personRoutes.get('/:id', async (c) => {
  const db = createDb(c.env.DB)
  const person = await db
    .select()
    .from(persons)
    .where(and(eq(persons.id, c.req.param('id')), eq(persons.userId, c.get('user').id)))
    .get()
  if (!person) return c.json({ error: '人物不存在' }, 404)

  // 默认世界 = 最早加入的世界（world_persons）
  const wp = await db
    .select({ world: worlds })
    .from(worldPersons)
    .innerJoin(worlds, eq(worldPersons.worldId, worlds.id))
    .where(eq(worldPersons.personId, person.id))
    .orderBy(asc(worldPersons.joinedAt))
    .limit(1)
    .get()
  const world = wp?.world ?? null
  const timelineList = world
    ? await db.select().from(timelines).where(eq(timelines.worldId, world.id)).all()
    : []
  const mainTimeline = timelineList.find((t) => t.parentTimelineId === null) ?? null
  const state = mainTimeline
    ? await db
        .select()
        .from(personStates)
        .where(and(eq(personStates.personId, person.id), eq(personStates.timelineId, mainTimeline.id)))
        .get()
    : null

  return c.json({
    person: {
      id: person.id,
      name: person.name,
      model: JSON.parse(person.modelJson) as unknown,
      createdAt: person.createdAt,
    },
    world: world ?? null,
    state: state ?? null,
    timelines: timelineList.map((t) => ({
      id: t.id,
      parentTimelineId: t.parentTimelineId,
      forkScenario: t.forkScenarioJson ? (JSON.parse(t.forkScenarioJson) as unknown) : null,
      simNow: t.simNow,
      createdAt: t.createdAt,
    })),
  })
})

/** 校正人物（F5）：更新 name 与 model */
personRoutes.put('/:id', async (c) => {
  const body = await c.req.json<{ name?: string; model?: unknown }>().catch(() => null)
  if (!body) return c.json({ error: '请求体无效' }, 400)
  const db = createDb(c.env.DB)
  const person = await db
    .select()
    .from(persons)
    .where(and(eq(persons.id, c.req.param('id')), eq(persons.userId, c.get('user').id)))
    .get()
  if (!person) return c.json({ error: '人物不存在' }, 404)

  const name = body.name?.trim() || person.name
  const model = body.model ? normalizeModel(body.model) : (JSON.parse(person.modelJson) as unknown)
  await db
    .update(persons)
    .set({ name, modelJson: JSON.stringify(model) })
    .where(eq(persons.id, person.id))
  return c.json({ ok: true })
})
