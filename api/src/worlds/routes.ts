import { Hono } from 'hono'
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import type { BatchItem } from 'drizzle-orm/batch'
import { createDb, type Db } from '../db/client'
import { dialogues, persons, personStates, timelines, universeRevisions, worldCommands, worldModelVersions, worldPersons, worlds } from '../db/schema'
import { forkConflict, forkTimeline } from '../life/fork'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import type { LocationDef } from '../agent/engine-context'
import { dialogueDetail, personFocus, worldSnapshot } from './queries'
import { streamWorld } from './stream'
import { draftWorld } from './draft'
import { budgetFromEnv, touchWorldActivity } from '../engine/budget'
import { BudgetRefusal, gateUser } from '../engine/guard'
import { commitWorldCommand } from '../world-state/commit'
import { createRootProjectionBaseline, ensureUniverseRevision } from '../world-state/model'
import { readWorldState } from '../world-state/query'
import { WorldStateError, type WorldAction } from '../world-state/types'
import type { ForkScenario } from '../agent/types'
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

/** Quick World 骨架：一句话 → LLM 生成（不落库）；预世界调用，按用户当日限额设防 */
worldsRoutes.post('/draft', async (c) => {
  const body = await c.req.json<{ prompt?: string }>().catch(() => ({}) as { prompt?: string })
  const prompt = body.prompt?.trim()
  if (!prompt) return c.json({ error: '请提供一句话描述' }, 400)
  const db = createDb(c.env.DB)
  const cfg = budgetFromEnv(c.env)
  const gate = await gateUser(db, c.get('user').id, cfg)
  if (!gate.ok) return c.json({ error: gate.error }, gate.status)
  try {
    return c.json(await draftWorld(c.env, db, c.get('user').id, prompt))
  } catch (e) {
    if (e instanceof BudgetRefusal) return c.json({ error: e.message }, e.status)
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
    .select({ id: persons.id, name: persons.name, modelJson: persons.modelJson })
    .from(persons)
    .where(and(eq(persons.userId, userId), inArray(persons.id, personIds)))
    .all()
  if (owned.length !== personIds.length) return c.json({ error: '包含不属于你的人物' }, 403)

  const now = new Date().toISOString()
  const worldId = crypto.randomUUID()
  const mainTimelineId = crypto.randomUUID()
  const statements: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [db.insert(worlds).values({
    id: worldId,
    userId,
    name,
    description,
    locationsJson: JSON.stringify(locations),
    status: 'running',
    callsToday: 0,
    callsDay: now.slice(0, 10),
    lastUserActivityAt: now,
    createdAt: now,
  }), db.insert(timelines).values({
    id: mainTimelineId,
    worldId,
    parentTimelineId: null,
    forkScenarioJson: null,
    simNow: now,
    createdAt: now,
    status: 'active',
    ancestorIdsJson: '[]',
  })]
  // 初始状态：地点轮转分配（D18）
  const membersById = new Map(owned.map(person => [person.id, person]))
  const initialStates = personIds.map((personId, i) => ({
    personId,
    simTime: now,
    location: locations[i % locations.length].name,
    activity: '刚来到这个世界，正在安顿',
    mood: '平静',
    goal: '安顿下来，开始日常',
    lastBeatSimTime: now,
    currentDialogueId: null,
  }))
  const baselineStates = initialStates.map(state => ({ ...state, timelineId: mainTimelineId, updatedRealAt: now }))
  for (let i = 0; i < personIds.length; i++) {
    const person = membersById.get(personIds[i])!
    statements.push(db.insert(worldPersons).values({ worldId, personId: person.id, joinedAt: now }))
    statements.push(db.insert(personStates).values({
      personId: person.id,
      timelineId: mainTimelineId,
      simTime: initialStates[i].simTime,
      location: initialStates[i].location,
      activity: initialStates[i].activity,
      mood: initialStates[i].mood,
      goal: initialStates[i].goal,
      updatedRealAt: now,
      lastBeatSimTime: initialStates[i].lastBeatSimTime,
    }))
  }
  // Create the universe and its immutable starting point in one D1 batch. A
  // failure pinning the model must not leave a half-created, legacy world.
  const initialModel = {
    name,
    description,
    locations,
    initialStates: { capturedAt: now, states: initialStates },
    initialEvents: { timelineId: mainTimelineId, eventIds: [] },
    projectionBaseline: createRootProjectionBaseline(now, now, baselineStates),
    residents: personIds.map(id => {
      const person = membersById.get(id)!
      return { id: person.id, name: person.name, model: JSON.parse(person.modelJson || '{}') as unknown }
    }),
  }
  statements.push(
    db.insert(worldModelVersions).values({ worldId, version: 1, modelJson: JSON.stringify(initialModel), createdAt: now }),
    db.insert(universeRevisions).values({ timelineId: mainTimelineId, version: 0, simTime: now, worldModelVersion: 1, updatedAt: now }),
  )
  await db.batch(statements)
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
  const detail = await dialogueDetail(db, c.req.param('id'), c.req.query('timelineId'))
  if (!detail) return c.json({ error: '对话不存在' }, 404)
  // 归属：dialogue → timeline → world → userId
  const tl = await db.select().from(timelines).where(eq(timelines.id, detail.dialogue.timelineId)).get()
  const world = tl ? await loadOwnedWorld(db, tl.worldId, c.get('user').id) : null
  if (!world) return c.json({ error: '对话不存在' }, 404)
  return c.json(detail)
})

/** 世界快照（世界视图首屏） */
worldsRoutes.get('/:id/state', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const timelineId = c.req.query('timelineId')
  if (!timelineId) return c.json({ error: 'timelineId 必填' }, 400)
  try { return c.json(await readWorldState(db, world.id, timelineId)) }
  catch (error) {
    if (error instanceof WorldStateError) return c.json({ error: error.message }, error.status)
    throw error
  }
})

worldsRoutes.get('/:id/actions/:commandId', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const command = await db.select().from(worldCommands).where(and(
    eq(worldCommands.id, c.req.param('commandId')), eq(worldCommands.worldId, world.id),
  )).get()
  if (!command) return c.json({ error: '命令不存在' }, 404)
  return c.json({ id: command.id, timelineId: command.timelineId, resultVersion: command.resultVersion })
})

worldsRoutes.post('/:id/actions', async (c) => {
  const body = await c.req.json<{ id?: string; timelineId?: string; expectedVersion?: number; action?: WorldAction }>().catch(() => null)
  if (!body || typeof body.id !== 'string' || typeof body.timelineId !== 'string'
    || !Number.isSafeInteger(body.expectedVersion) || !body.action || typeof body.action !== 'object') {
    return c.json({ error: '命令参数不完整' }, 400)
  }
  if (body.action.type !== 'environment' && body.action.type !== 'inform') {
    return c.json({ error: '构造者只能改变环境条件或传递信息，不能替居民行动' }, 403)
  }
  const db = createDb(c.env.DB)
  try {
    const result = await commitWorldCommand(db, {
      id: body.id, worldId: c.req.param('id'), timelineId: body.timelineId,
      userId: c.get('user').id, expectedVersion: body.expectedVersion!, action: body.action,
    })
    await touchWorldActivity(db, c.req.param('id'))
    return c.json(result)
  } catch (error) {
    const conflict = error instanceof WorldStateError ? error : forkConflict(error, '世界状态正在更新；请刷新后重试。')
    if (conflict) return c.json({ error: conflict.message }, conflict.status)
    throw error
  }
})

/** 世界快照（世界视图首屏） */
worldsRoutes.get('/:id', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  let snapshot
  try { snapshot = await worldSnapshot(db, world.id, c.req.query('timelineId')) }
  catch (error) {
    if (error instanceof WorldStateError) return c.json({ error: error.message }, error.status)
    throw error
  }
  if (!snapshot) return c.json({ error: '世界或时间线不存在' }, 404)
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

/** 继续：只改状态，不清零当日用量（清零曾让 pause→resume 无限刷日限额；
 *  触顶的 capped 世界由 tick 在换天时自动恢复，resume 仅用于手动暂停的世界） */
worldsRoutes.post('/:id/resume', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  await db.update(worlds).set({ status: 'running', pauseReason: null }).where(eq(worlds.id, world.id))
  await touchWorldActivity(db, world.id)
  return c.json({ ok: true, status: 'running' })
})

/** 归档（冻结可读）：引擎停止推进、不再产生 LLM 调用；数据完整保留，可随时 resume 解冻 */
worldsRoutes.post('/:id/archive', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  await db.update(worlds).set({ status: 'archived', pauseReason: null }).where(eq(worlds.id, world.id))
  return c.json({ ok: true, status: 'archived' })
})

/** 注入事件：写 kind='injected' 事件，当前线的人物于下一拍感知并反应（F7） */
worldsRoutes.post('/:id/inject', async (c) => {
  const body = await c.req.json<{ text?: string; timelineId?: string; requestId?: string; expectedVersion?: number }>().catch(() => null)
  const text = body?.text?.trim()
  if (!text) return c.json({ error: '事件内容不能为空' }, 400)
  if (body?.requestId != null && (typeof body.requestId !== 'string' || !body.requestId.trim() || body.requestId.length > 80)) {
    return c.json({ error: '请求 ID 无效' }, 400)
  }
  if (body?.expectedVersion != null && (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)) {
    return c.json({ error: '世界状态版本无效' }, 400)
  }

  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)

  const tl = body?.timelineId
    ? await db.select().from(timelines).where(and(eq(timelines.id, body.timelineId), eq(timelines.worldId, world.id))).get()
    : await db.select().from(timelines).where(and(eq(timelines.worldId, world.id), isNull(timelines.parentTimelineId))).get()
  if (!tl) return c.json({ error: '时间线不存在' }, 404)
  if (world.status !== 'running') return c.json({ error: '世界未运行，不能执行叙事干预' }, 409)
  if (tl.status !== 'active') return c.json({ error: '时间线已归档，不能执行叙事干预' }, 409)
  const requestId = body?.requestId?.trim() || crypto.randomUUID()
  const id = `inject:${requestId}`
  const existing = await db.select().from(worldCommands).where(eq(worldCommands.id, id)).get()
  if (existing && (existing.worldId !== world.id || existing.timelineId !== tl.id)) return c.json({ error: '请求 ID 已用于另一项行动' }, 409)
  try {
    const revision = await ensureUniverseRevision(db, world.id, tl.id)
    const result = await commitWorldCommand(db, { id, worldId: world.id, timelineId: tl.id, userId: c.get('user').id,
      expectedVersion: existing?.expectedVersion ?? body?.expectedVersion ?? revision.version,
      action: { type: 'intervention', requestId, text } })
    await touchWorldActivity(db, world.id)
    return c.json({ id: result.commandId, timelineId: tl.id, simTime: tl.simNow, version: result.version, replayed: result.replayed })
  } catch (error) {
    if (error instanceof WorldStateError) return c.json({ error: error.message }, error.status)
    throw error
  }
})

/** 世界级 Fork（F9）：复制世界设定与全部人物状态/当日日程到新线；记忆经可见性规则自然继承 */
worldsRoutes.post('/:id/timelines/:tid/fork', async (c) => {
  try {
  const body = await c.req.json<{ requestId?: string; scenario?: unknown }>().catch(() => null)
  const requestId = body?.requestId
  if (requestId != null && (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 100)) return c.json({ error: '分叉请求 ID 无效' }, 400)
  const value = body?.scenario
  if (!value || typeof value !== 'object' || Array.isArray(value)) return c.json({ error: '请说明分叉假设与改变条件' }, 400)
  const record = value as Record<string, unknown>
  const whatIf = typeof record.whatIf === 'string' ? record.whatIf.trim() : ''
  const changedVariable = typeof record.changedVariable === 'string' ? record.changedVariable.trim() : ''
  if (!whatIf || whatIf.length > 500 || !changedVariable || changedVariable.length > 200) {
    return c.json({ error: '请提供有效的假设和唯一改变条件' }, 400)
  }
  const scenarioDraft: Pick<ForkScenario, 'whatIf' | 'changedVariable'> = { whatIf, changedVariable }
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  if (requestId) {
    const existing = await db.select().from(timelines).where(eq(timelines.id, requestId)).get()
    if (existing && existing.worldId === world.id && existing.parentTimelineId === c.req.param('tid')) {
      let stored: ForkScenario | null = null
      try { stored = existing.forkScenarioJson ? JSON.parse(existing.forkScenarioJson) as ForkScenario : null } catch { /* incompatible legacy row: do not treat as a match */ }
      const sameScenario = stored?.whatIf === scenarioDraft.whatIf && stored.changedVariable === scenarioDraft.changedVariable
      if (sameScenario) return c.json({ id: existing.id, simNow: existing.simNow })
      return c.json({ error: '分叉请求 ID 已用于不同条件' }, 409)
    }
    if (existing) return c.json({ error: '分叉请求 ID 已用于另一条时间线' }, 409)
  }
  if (world.status !== 'running') return c.json({ error: '世界未运行，不能分叉' }, 409)

  const source = await db
    .select()
    .from(timelines)
    .where(and(eq(timelines.id, c.req.param('tid')), eq(timelines.worldId, world.id)))
    .get()
  if (!source) return c.json({ error: '时间线不存在' }, 404)
  if (source.status !== 'active') return c.json({ error: '只能分叉活跃时间线' }, 400)

  const scenario: ForkScenario = {
    ...scenarioDraft,
    startTime: source.simNow,
    participants: [],
    invariants: ['分叉前的共同历史与设定版本保持不变'],
  }

  const activeCount = await db
    .select({ n: count() })
    .from(timelines)
    .where(and(eq(timelines.worldId, world.id), eq(timelines.status, 'active')))
    .get()
  if ((activeCount?.n ?? 0) >= 3) {
    return c.json({ error: '活跃时间线已达上限（3 条），请先归档一条' }, 409)
  }

  let fork: Awaited<ReturnType<typeof forkTimeline>>
  fork = await forkTimeline(db, world.id, source.id, scenario, requestId)
  return c.json({ id: fork.id, simNow: fork.simNow, snapshot: {
    version: fork.snapshot.version, sourceTimelineId: source.id,
    sourceSimTime: fork.snapshot.sourceSimTime, capturedAt: fork.snapshot.capturedAt,
  } })
  } catch (error) {
    const conflict = error instanceof WorldStateError ? error : forkConflict(error)
    if (conflict) return c.json({ error: conflict.message }, conflict.status)
    throw error
  }
})
