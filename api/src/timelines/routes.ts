import { Hono } from 'hono'
import { and, asc, eq } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import { createDb } from '../db/client'
import { events, persons, personStates, timelines, worldPersons, worlds } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { buildAgentContext } from '../agent/context'
import { runAgentTurn } from '../agent/loop'
import { complete, configFromEnv } from '../llm/client'
import type { ForkScenario } from '../agent/types'
import type { Env } from '../index'

export const timelineRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
timelineRoutes.use('*', authMiddleware)

const PREVIEW_SYSTEM = `你是「可能性设定师」。用户要为一个人物创建 what-if 分叉时间线。
根据人物背景与用户的 what-if，给出明确的分叉场景设定。
只输出一个 JSON 对象（不要任何其他文字，不要代码块）：
{
  "whatIf": "用户的原话",
  "startTime": "分叉起始时间，ISO 8601（如 2024-06-01T09:00:00Z），不晚于当前时间",
  "changedVariable": "被改变的那一个条件，一句话",
  "participants": ["涉及的人物"],
  "invariants": ["保持不变的条件"]
}
要求：changedVariable 只改一件事；invariants 2-4 条；startTime 合理解读用户意图（"当时""那时候"指多久以前）；用中文。`

function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('返回中未找到 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

function normalizeScenario(raw: unknown, whatIf: string, fallbackStart: string): ForkScenario {
  const r = (raw ?? {}) as Record<string, unknown>
  const startRaw = String(r.startTime ?? '')
  const startTime = Number.isNaN(Date.parse(startRaw)) ? fallbackStart : new Date(startRaw).toISOString()
  return {
    whatIf: String(r.whatIf ?? whatIf).trim() || whatIf,
    startTime,
    changedVariable: String(r.changedVariable ?? '').trim() || whatIf,
    participants: Array.isArray(r.participants) ? r.participants.map(String).filter(Boolean) : [],
    invariants: Array.isArray(r.invariants) ? r.invariants.map(String).filter(Boolean) : [],
  }
}

/** Fork 预览：主线 context + whatIf → 场景设定草稿（不落库） */
timelineRoutes.post('/persons/:id/fork/preview', async (c) => {
  const body = await c.req.json<{ whatIf?: string }>().catch(() => ({}) as { whatIf?: string })
  const whatIf = body.whatIf?.trim()
  if (!whatIf) return c.json({ error: '请提供 what-if' }, 400)

  const db = createDb(c.env.DB)
  const ctx = await buildAgentContext(db, {
    userId: c.get('user').id,
    personId: c.req.param('id'),
    timelineId: null,
    mode: 'simulate',
  })
  if (!ctx) return c.json({ error: '人物不存在' }, 404)

  const brief = [
    `人物：${ctx.person.name}`,
    `身份要点：${ctx.model.identity.slice(0, 3).map((i) => i.text).join('；') || '无'}`,
    `当前状态：时间 ${ctx.state.simTime}；地点 ${ctx.state.location}；活动 ${ctx.state.activity}；情绪 ${ctx.state.mood}；目标 ${ctx.state.goal}`,
    `世界：${ctx.world.name}——${ctx.world.description}`,
    `当前真实时间：${new Date().toISOString()}`,
    '',
    `用户的 what-if：「${whatIf}」`,
  ].join('\n')

  const config = configFromEnv(c.env)
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await complete(
        config,
        [
          { role: 'system', content: PREVIEW_SYSTEM },
          { role: 'user', content: brief },
        ],
        { maxTokens: 8000 },
      )
      return c.json(normalizeScenario(extractJson(raw), whatIf, ctx.timeline.simNow))
    } catch (e) {
      lastError = e
    }
  }
  return c.json({ error: `场景生成失败：${lastError instanceof Error ? lastError.message : '未知错误'}` }, 502)
})

/** Fork 确认：建时间线 → 拷贝主线状态 → simulate 推演，事件逐条流出 */
timelineRoutes.post('/persons/:id/fork', async (c) => {
  const body = await c.req.json<{ scenario?: Partial<ForkScenario> }>().catch(() => null)
  const s = body?.scenario
  if (!s?.whatIf?.trim() || !s.startTime || Number.isNaN(Date.parse(s.startTime))) {
    return c.json({ error: '场景设定不完整（whatIf / startTime 必填）' }, 400)
  }
  const scenario: ForkScenario = {
    whatIf: s.whatIf.trim(),
    startTime: new Date(s.startTime).toISOString(),
    changedVariable: s.changedVariable?.trim() || s.whatIf.trim(),
    participants: Array.isArray(s.participants) ? s.participants.map(String).filter(Boolean) : [],
    invariants: Array.isArray(s.invariants) ? s.invariants.map(String).filter(Boolean) : [],
  }

  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const base = await buildAgentContext(db, {
    userId,
    personId: c.req.param('id'),
    timelineId: null,
    mode: 'simulate',
  })
  if (!base) return c.json({ error: '人物不存在' }, 404)

  const now = new Date().toISOString()
  const forkId = crypto.randomUUID()
  await db.batch([
    db.insert(timelines).values({
      id: forkId,
      worldId: base.world.id,
      parentTimelineId: base.mainTimelineId,
      forkScenarioJson: JSON.stringify(scenario),
      simNow: scenario.startTime,
      createdAt: now,
    }),
    // 拷贝主线当前状态作为分叉初始状态，虚拟时间对齐到分叉起始
    db.insert(personStates).values({
      personId: base.person.id,
      timelineId: forkId,
      simTime: scenario.startTime,
      location: base.state.location,
      activity: base.state.activity,
      mood: base.state.mood,
      goal: base.state.goal,
      updatedRealAt: now,
    }),
  ])

  const input = [
    '分叉设定：',
    `- what-if：${scenario.whatIf}`,
    `- 起始时间：${scenario.startTime}`,
    `- 改变的变量：${scenario.changedVariable}`,
    `- 参与人物：${scenario.participants.join('、') || '无'}`,
    `- 保持不变：${scenario.invariants.join('；') || '无'}`,
    '',
    `从 ${scenario.startTime} 开始，这条时间线上的生活继续。请按你的模式指令行动。`,
  ].join('\n')

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: JSON.stringify({ type: 'timeline', timelineId: forkId }) })
    // 从 DB 重建分叉上下文：状态/记忆按分叉规则查询，虚拟时钟从 startTime 起算
    const forkCtx = await buildAgentContext(db, {
      userId,
      personId: base.person.id,
      timelineId: forkId,
      mode: 'simulate',
    })
    if (!forkCtx) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '分叉上下文创建失败' }) })
      return
    }
    try {
      for await (const ev of runAgentTurn(c.env, db, forkCtx, input)) {
        await stream.writeSSE({ data: JSON.stringify(ev) })
        if (ev.type === 'done') break
      }
    } catch (e) {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', message: e instanceof Error ? e.message : '推演失败' }),
      })
    }
  })
})

/** 归档时间线（F9）：引擎停止推进该线（数据保留）；世界至少保留一条活跃线 */
timelineRoutes.post('/timelines/:id/archive', async (c) => {
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const timeline = await db
    .select()
    .from(timelines)
    .where(eq(timelines.id, c.req.param('id')))
    .get()
  if (!timeline) return c.json({ error: '时间线不存在' }, 404)
  const world = await db
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, timeline.worldId), eq(worlds.userId, userId)))
    .get()
  if (!world) return c.json({ error: '时间线不存在' }, 404)
  if (timeline.status === 'archived') return c.json({ ok: true, status: 'archived' })

  const active = await db
    .select({ id: timelines.id })
    .from(timelines)
    .where(and(eq(timelines.worldId, world.id), eq(timelines.status, 'active')))
    .all()
  if (active.length <= 1) {
    return c.json({ error: '每个世界至少保留一条活跃时间线' }, 400)
  }
  await db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, timeline.id))
  return c.json({ ok: true, status: 'archived' })
})

/** 时间线详情：timeline + events（按 sim_time 排序）+ 该线人物状态 */
timelineRoutes.get('/timelines/:id', async (c) => {
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const timeline = await db
    .select()
    .from(timelines)
    .where(eq(timelines.id, c.req.param('id')))
    .get()
  if (!timeline) return c.json({ error: '时间线不存在' }, 404)

  const world = await db
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, timeline.worldId), eq(worlds.userId, userId)))
    .get()
  if (!world) return c.json({ error: '时间线不存在' }, 404)

  // 该世界的首个成员（阶段一视图为单人物世界设计，多人物世界的观察在世界视图进行）
  const wp = await db
    .select()
    .from(worldPersons)
    .where(eq(worldPersons.worldId, world.id))
    .orderBy(asc(worldPersons.joinedAt))
    .limit(1)
    .get()
  const person = wp
    ? await db.select().from(persons).where(eq(persons.id, wp.personId)).get()
    : null
  const eventList = await db
    .select()
    .from(events)
    .where(eq(events.timelineId, timeline.id))
    .orderBy(asc(events.simTime))
    .all()
  const state = wp
    ? await db
        .select()
        .from(personStates)
        .where(and(eq(personStates.personId, wp.personId), eq(personStates.timelineId, timeline.id)))
        .get()
    : null

  return c.json({
    timeline: {
      id: timeline.id,
      worldId: timeline.worldId,
      parentTimelineId: timeline.parentTimelineId,
      forkScenario: timeline.forkScenarioJson ? (JSON.parse(timeline.forkScenarioJson) as unknown) : null,
      simNow: timeline.simNow,
      createdAt: timeline.createdAt,
    },
    world: { id: world.id, name: world.name, description: world.description },
    person: person ? { id: person.id, name: person.name } : null,
    events: eventList,
    state: state ?? null,
  })
})
