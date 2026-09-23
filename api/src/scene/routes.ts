import { Hono } from 'hono'
import { and, asc, desc, eq, lte } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import type { SSEStreamingApi } from 'hono/streaming'
import type { BatchItem } from 'drizzle-orm/batch'
import { createDb, type Db } from '../db/client'
import { memories, personaMessages, personStates, persons, timelines, worlds, worldCommands, worldPersons, dialogues, dialogueTurns, sceneRequests, universeRevisions } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { buildWorldSnapshot, buildEngineContext } from '../agent/engine-context'
import { buildScenePrompt, extractJson, type DialogueTurnView } from '../agent/engine-prompt'
import { containsExplicitInvitationRequest, parseSceneOutput } from './parse'
import { eligibleAt, eligibleBoard } from './eligible'
import { clampImportance } from '../agent/memory'
import { budgetFromEnv, touchWorldActivity } from '../engine/budget'
import { BudgetRefusal, gateWorld, worldReservation } from '../engine/guard'
import { complete, configFromEnv } from '../llm/client'
import { proposeCommitment } from '../life/service'
import { commitWorldCommand } from '../world-state/commit'
import { ensureUniverseRevision } from '../world-state/model'
import { recoverDialogueLock } from '../world-state/system'
import { WorldStateError, type WorldAction } from '../world-state/types'
import { buildIntentMessages, resolveIntentOutput } from '../world-actions/resolve'
import { validateWorldAction } from '../world-state/rules'
import type { Env } from '../index'

type World = typeof worlds.$inferSelect
type Person = typeof persons.$inferSelect

export const sceneRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
sceneRoutes.use('*', authMiddleware)

/** 同一地点一场 scene 最多回应的人数（每人一次 LLM 调用） */
export const MAX_SCENE_RESPONDERS = 3
/** One model call can take 180s; the extra minute is a recovery margin. */
export const SCENE_REQUEST_STALE_MS = 240_000

async function loadOwnedWorld(db: Db, worldId: string, userId: string): Promise<World | null> {
  const w = await db
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.userId, userId)))
    .get()
  return w ?? null
}

async function loadPersona(db: Db, worldId: string, userId: string): Promise<Person | null> {
  const rows = await db
    .select({ person: persons })
    .from(worldPersons)
    .innerJoin(persons, eq(worldPersons.personId, persons.id))
    .where(and(eq(worldPersons.worldId, worldId), eq(persons.userId, userId), eq(persons.isUser, true)))
    .all()
  return rows[0]?.person ?? null
}

function personaProfile(persona: Person): string {
  try {
    const model = JSON.parse(persona.modelJson) as { identity?: { text: string }[] }
    return model.identity?.[0]?.text ?? ''
  } catch {
    return ''
  }
}

/** 可交谈地点看板：各地点「清醒且空闲」的回应者人数（地点面板的人数含睡眠/对话中者，易扑空） */
sceneRoutes.get('/worlds/:id/scene/board', async (c) => {
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const world = await loadOwnedWorld(db, c.req.param('id'), userId)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const tls = await db.select().from(timelines).where(eq(timelines.worldId, world.id)).all()
  const requestedTimelineId = c.req.query('timelineId')
  const tl = requestedTimelineId !== undefined ? tls.find(t => t.id === requestedTimelineId) : tls.find((t) => t.parentTimelineId === null) ?? tls[0]
  if (!tl) return c.json({ error: '时间线不存在' }, 404)
  const snapshot = await buildWorldSnapshot(db, world.id, tl.id)
  if (!snapshot) return c.json({ error: '世界快照不存在' }, 404)
  return c.json({ board: eligibleBoard(snapshot).map(row => ({ ...row,
    people: eligibleAt(snapshot, row.location).map(p => ({ id: p.id, name: p.name })),
  })) })
})

/** 最近一场连续交谈；读取不产生模型调用或写入。 */
sceneRoutes.get('/worlds/:id/scene/history', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const persona = await loadPersona(db, world.id, c.get('user').id)
  if (!persona) return c.json({ error: '先登记身份' }, 400)
  const tls = await db.select().from(timelines).where(eq(timelines.worldId, world.id)).all()
  const requestedTimelineId = c.req.query('timelineId')
  const tl = requestedTimelineId !== undefined ? tls.find(t => t.id === requestedTimelineId) : tls.find(t => !t.parentTimelineId)
  if (!tl) return c.json({ error: '时间线不存在' }, 404)
  const location = c.req.query('location')
  const dialogue = await db.select().from(dialogues).where(and(
    eq(dialogues.timelineId, tl.id), eq(dialogues.visitorId, persona.id), eq(dialogues.kind, 'scene'),
    ...(location ? [eq(dialogues.location, location)] : []),
  )).orderBy(desc(dialogues.simStart)).limit(1).get()
  if (!dialogue) return c.json({ dialogueId: null, location: location ?? null, turns: [] })
  const turns = await db.select({ id: dialogueTurns.id, personId: dialogueTurns.personId, name: persons.name, utterance: dialogueTurns.utterance })
    .from(dialogueTurns).innerJoin(persons, eq(persons.id, dialogueTurns.personId))
    .where(eq(dialogueTurns.dialogueId, dialogue.id)).orderBy(asc(dialogueTurns.turnIndex)).all()
  return c.json({ dialogueId: dialogue.id, location: dialogue.location, turns })
})

/** 本次场景提交状态：刷新/断流后只读查询，不重跑模型或改动世界。 */
sceneRoutes.get('/worlds/:id/scene/requests/:requestId', async (c) => {
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const world = await loadOwnedWorld(db, c.req.param('id'), userId)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const persona = await loadPersona(db, world.id, userId)
  if (!persona) return c.json({ error: '先登记身份' }, 400)
  const timelineId = c.req.query('timelineId')
  const timeline = timelineId ? await db.select().from(timelines).where(and(
    eq(timelines.id, timelineId), eq(timelines.worldId, world.id),
  )).get() : null
  if (!timeline) return c.json({ error: '时间线不存在' }, 404)
  const request = await db.select().from(sceneRequests).where(eq(sceneRequests.id, c.req.param('requestId'))).get()
  if (!request) return c.json({ status: 'missing' as const, recoverable: false })
  const dialogue = await db.select().from(dialogues).where(and(
    eq(dialogues.id, request.dialogueId), eq(dialogues.timelineId, timeline.id),
    eq(dialogues.visitorId, persona.id), eq(dialogues.kind, 'scene'),
  )).get()
  if (!dialogue) return c.json({ error: '交谈请求不存在' }, 404)
  return c.json({ status: request.status as 'pending' | 'completed' | 'failed',
    recoverable: request.status === 'pending' && request.heartbeatAt <= Date.now() - SCENE_REQUEST_STALE_MS })
})

/** Release a crashed worker's expired reservation; the DB guard prevents that worker committing afterward. */
sceneRoutes.post('/worlds/:id/scene/requests/:requestId/recover', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const persona = await loadPersona(db, world.id, c.get('user').id)
  if (!persona) return c.json({ error: '先登记身份' }, 400)
  const timelineId = c.req.query('timelineId')
  const timeline = timelineId ? await db.select().from(timelines).where(and(
    eq(timelines.id, timelineId), eq(timelines.worldId, world.id),
  )).get() : null
  if (!timeline) return c.json({ error: '时间线不存在' }, 404)
  const request = await db.select().from(sceneRequests).where(eq(sceneRequests.id, c.req.param('requestId'))).get()
  if (!request) return c.json({ status: 'missing' as const, recoverable: false })
  const dialogue = await db.select().from(dialogues).where(and(
    eq(dialogues.id, request.dialogueId), eq(dialogues.timelineId, timeline.id),
    eq(dialogues.visitorId, persona.id), eq(dialogues.kind, 'scene'),
  )).get()
  if (!dialogue) return c.json({ error: '交谈请求不存在' }, 404)
  const committed = await db.select().from(worldCommands).where(and(
    eq(worldCommands.id, `scene:${request.id}`), eq(worldCommands.worldId, world.id), eq(worldCommands.timelineId, timeline.id),
  )).get()
  if (committed) {
    await db.update(sceneRequests).set({ status: 'completed' }).where(and(
      eq(sceneRequests.id, request.id), eq(sceneRequests.status, 'pending'),
    ))
    return c.json({ status: 'completed' as const, recoverable: false })
  }
  const cutoff = Date.now() - SCENE_REQUEST_STALE_MS
  const [recovered] = await db.update(sceneRequests).set({ status: 'failed' }).where(and(
    eq(sceneRequests.id, request.id), eq(sceneRequests.status, 'pending'), lte(sceneRequests.heartbeatAt, cutoff),
  )).returning({ id: sceneRequests.id }).all()
  if (recovered) return c.json({ status: 'failed' as const, recoverable: false })
  const latest = await db.select().from(sceneRequests).where(eq(sceneRequests.id, request.id)).get()
  return c.json({ status: (latest?.status ?? 'missing') as 'missing' | 'pending' | 'completed' | 'failed',
    recoverable: latest?.status === 'pending' && latest.heartbeatAt <= cutoff })
})

/** Resolve a visitor's natural-language intent to a bounded proposal; never executes it. */
sceneRoutes.post('/worlds/:id/scene/intent', async (c) => {
  const body = await c.req.json<{ timelineId?: string; content?: string; requestId?: string }>().catch(() => null)
  const content = body?.content?.trim()
  const requestId = body?.requestId?.trim() || crypto.randomUUID()
  if (!content || content.length > 1000) return c.json({ error: '行动描述不能为空且不能超过 1000 字' }, 400)
  if (requestId.length > 80) return c.json({ error: 'requestId 过长' }, 400)
  if (!body?.timelineId) return c.json({ error: '时间线必填' }, 400)

  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const world = await loadOwnedWorld(db, c.req.param('id'), userId)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const timelinesInWorld = await db.select().from(timelines).where(eq(timelines.worldId, world.id)).all()
  const timeline = timelinesInWorld.find(item => item.id === body.timelineId)
  if (!timeline || timeline.status !== 'active') return c.json({ error: '时间线不存在或已归档' }, 404)
  const persona = await loadPersona(db, world.id, userId)
  if (!persona) return c.json({ error: '先登记在场身份' }, 400)
  const state = await db.select().from(personStates).where(and(
    eq(personStates.personId, persona.id), eq(personStates.timelineId, timeline.id),
  )).get()
  if (!state) return c.json({ error: '请先进入这个宇宙，再提出在场行动' }, 409)
  const snapshot = await buildWorldSnapshot(db, world.id, timeline.id)
  if (!snapshot) return c.json({ error: '世界快照不存在' }, 404)
  const gate = await gateWorld(db, world.id, budgetFromEnv(c.env))
  if (!gate.ok) return c.json({ error: gate.error }, gate.status)
  // Resolution is read-only with respect to world state: an uninitialized legacy
  // revision is reported as its deterministic baseline instead of being created here.
  const revision = await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timeline.id)).get()
  const intentContext = {
    text: content,
    currentLocation: state.location,
    locations: snapshot.locations.map(location => location.name),
    residents: eligibleAt(snapshot, state.location).map(person => ({ id: person.id, name: person.name })),
  }
  try {
    const reserve = worldReservation(db, world.id, budgetFromEnv(c.env), {
      timelineId: timeline.id, personId: persona.id, purpose: 'scene',
    })
    const raw = await complete(configFromEnv(c.env, reserve), buildIntentMessages(intentContext), {
      maxTokens: 300, signal: c.req.raw.signal,
    })
    let parsed: unknown
    try { parsed = extractJson(raw) } catch { parsed = null }
    let resolution = resolveIntentOutput(parsed, intentContext)
    if (resolution.status === 'proposal') {
      try {
        const proposal = resolution.proposal
        if (proposal.type === 'move') {
          await validateWorldAction(db, world.id, timeline.id, { type: 'move', personId: persona.id, to: proposal.to })
        } else {
          await validateWorldAction(db, world.id, timeline.id, { type: 'inform', recipientId: proposal.recipientId,
            topic: proposal.topic, content: proposal.content })
        }
      } catch (error) {
        if (!(error instanceof WorldStateError)) throw error
        resolution = { status: 'clarification', question: '世界状态或行动条件已变化；请重新描述这个行动。' }
      }
    }
    return c.json({ requestId, timelineId: timeline.id, expectedVersion: revision?.version ?? 0,
      currentLocation: state.location, ...resolution })
  } catch (error) {
    if (error instanceof BudgetRefusal) return c.json({ error: error.message }, error.status)
    return c.json({ error: '暂时无法解析行动，请重试；世界状态未改变', requestId }, 502)
  }
})

/** Enter once, then move explicitly. A location selector is never a teleport. */
sceneRoutes.post('/worlds/:id/scene/position', async (c) => {
  const body = await c.req.json<{ timelineId?: string; location?: string; commandId?: string; expectedVersion?: number }>().catch(() => null)
  if (!body?.timelineId || !body.location || !body.commandId || !Number.isSafeInteger(body.expectedVersion)) {
    return c.json({ error: '地点、命令 ID 与状态版本必填' }, 400)
  }
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const world = await loadOwnedWorld(db, c.req.param('id'), userId)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const persona = await loadPersona(db, world.id, userId)
  if (!persona) return c.json({ error: '先登记在场身份' }, 400)
  const prior = await db.select().from(worldCommands).where(eq(worldCommands.id, body.commandId)).get()
  const state = await db.select().from(personStates).where(and(eq(personStates.personId, persona.id), eq(personStates.timelineId, body.timelineId))).get()
  try {
    const action = prior?.actorKind === 'visitor' ? JSON.parse(prior.payloadJson) as { type: 'enter' | 'move'; personId: string; to: string }
      : { type: state ? 'move' as const : 'enter' as const, personId: persona.id, to: body.location }
    if (action.to !== body.location || action.personId !== persona.id || (action.type !== 'enter' && action.type !== 'move')) {
      return c.json({ error: '命令 ID 已用于另一项行动' }, 409)
    }
    const result = await commitWorldCommand(db, {
      id: body.commandId, worldId: world.id, timelineId: body.timelineId, userId,
      actorKind: 'visitor', actorPersonId: persona.id, expectedVersion: body.expectedVersion!,
      action,
    })
    await touchWorldActivity(db, world.id)
    return c.json({ ...result, location: body.location })
  } catch (error) {
    if (error instanceof WorldStateError) return c.json({ error: error.message }, error.status)
    throw error
  }
})

/** A deliberate, limited speech act: a co-located resident hears a claim as rumor. */
sceneRoutes.post('/worlds/:id/scene/inform', async (c) => {
  const body = await c.req.json<{ timelineId?: string; recipientId?: string; topic?: string; content?: string; commandId?: string; expectedVersion?: number }>().catch(() => null)
  if (!body?.timelineId || !body.recipientId || !body.topic || !body.content || !body.commandId || !Number.isSafeInteger(body.expectedVersion)) {
    return c.json({ error: '传递消息的参数不完整' }, 400)
  }
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const world = await loadOwnedWorld(db, c.req.param('id'), userId)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const persona = await loadPersona(db, world.id, userId)
  if (!persona) return c.json({ error: '先登记在场身份' }, 400)
  const snapshot = await buildWorldSnapshot(db, world.id, body.timelineId)
  if (!snapshot || !eligibleAt(snapshot).some(p => p.id === body.recipientId)) return c.json({ error: '对方不在可交谈的现场' }, 409)
  try {
    const result = await commitWorldCommand(db, { id: body.commandId, worldId: world.id, timelineId: body.timelineId,
      userId, actorKind: 'visitor', actorPersonId: persona.id, expectedVersion: body.expectedVersion!,
      action: { type: 'inform', recipientId: body.recipientId, topic: body.topic, content: body.content },
    })
    await touchWorldActivity(db, world.id)
    return c.json({ ...result, certainty: 'rumor' })
  } catch (error) {
    if (error instanceof WorldStateError) return c.json({ error: error.message }, error.status)
    throw error
  }
})

/**
 * 你在世界里（Character.AI Persona 思路的落地）：
 * 用户以登记过的在场身份来到某地点说话 → 该地点清醒且空闲的人物依次以本人身份回应
 * （1 人 1 次 LLM 调用，purpose='scene'）。这场相遇在数据模型上就是一段
 * 含用户在内的多方对话（dialogues + dialogueTurns，一次说完即 ended），
 * 因此事件流里可像引擎对话一样逐句展开阅读，章节也会把对话内容织进小说；
 * 回应同时写入每个人的记忆流（想法 + 关系记忆），有留言则留给来访者下次收取。SSE 逐句推送。
 */
sceneRoutes.post('/worlds/:id/scene', async (c) => {
  const body = await c.req.json<{ timelineId?: string; location?: string; content?: string; requestId?: string }>().catch(() => null)
  const content = body?.content?.trim()
  if (!content) return c.json({ error: '内容不能为空' }, 400)
  const requestId = body?.requestId?.trim() || crypto.randomUUID()
  if (requestId.length > 80) return c.json({ error: 'requestId 过长' }, 400)

  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const world = await loadOwnedWorld(db, c.req.param('id'), userId)
  if (!world) return c.json({ error: '世界不存在' }, 404)

  const tls = await db.select().from(timelines).where(eq(timelines.worldId, world.id)).all()
  const tl = body?.timelineId !== undefined ? tls.find((t) => t.id === body.timelineId) : tls.find((t) => t.parentTimelineId === null)
  if (!tl || tl.status !== 'active') return c.json({ error: '时间线不存在或已归档' }, 404)

  const persona = await loadPersona(db, world.id, userId)
  if (!persona) return c.json({ error: '先在世界中登记你的在场身份（进入世界时会引导你）' }, 400)
  let position = await db.select().from(personStates).where(and(
    eq(personStates.personId, persona.id), eq(personStates.timelineId, tl.id),
  )).get()
  if (!position) return c.json({ error: '请先选择地点并进入这个宇宙' }, 409)
  if (position.currentDialogueId) {
    const lockedDialogueId = position.currentDialogueId
    const activeDialogue = await db.select().from(dialogues).where(and(
      eq(dialogues.id, lockedDialogueId), eq(dialogues.timelineId, tl.id),
    )).get()
    if (activeDialogue?.status === 'ongoing') return c.json({ error: '你正在参与另一场交谈，请结束后再发起新交谈' }, 409)
    try {
      await recoverDialogueLock(db, { worldId: world.id, timelineId: tl.id,
        sourceKey: `visitor-dialogue-recovery:${tl.id}:${persona.id}:${lockedDialogueId}`,
        personId: persona.id, dialogueId: lockedDialogueId })
    } catch (error) {
      if (error instanceof WorldStateError) return c.json({ error: error.message }, error.status)
      throw error
    }
    position = await db.select().from(personStates).where(and(
      eq(personStates.personId, persona.id), eq(personStates.timelineId, tl.id),
    )).get()
    if (!position || position.currentDialogueId) return c.json({ error: '你的交谈状态已变化，请刷新后重试' }, 409)
  }
  if (body?.location && body.location !== position.location) return c.json({ error: `你目前在${position.location}，请先移动后再交谈` }, 409)
  const requestDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({
    timelineId: tl.id, visitorId: persona.id, location: position.location, content,
  })))
  const contentHash = [...new Uint8Array(requestDigest)].map(byte => byte.toString(16).padStart(2, '0')).join('')

  return streamSSE(c, async (stream) => {
    const generation = new AbortController()
    stream.onAbort(() => generation.abort(new Error('场景连接已取消')))
    const cfg = budgetFromEnv(c.env)
    const gate = await gateWorld(db, world.id, cfg)
    if (!gate.ok) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: gate.error }) })
      return
    }
    let currentWorld = gate.world
    await touchWorldActivity(db, world.id)

    const snapshot = await buildWorldSnapshot(db, world.id, tl.id)
    if (!snapshot) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '世界快照不存在' }) })
      return
    }
    const simNow = snapshot.timeline.simNow
    let startingRevision = await ensureUniverseRevision(db, world.id, tl.id)
    const now = new Date().toISOString()

    // 在场者：同一地点（或指定地点）、清醒、未在对话中；用户身份除外
    const eligible = eligibleAt(snapshot, position.location)
    const byLocation = new Map<string, typeof eligible>()
    for (const p of eligible) {
      const loc = snapshot.states.get(p.id)!.location
      byLocation.set(loc, [...(byLocation.get(loc) ?? []), p])
    }
    const pickedLoc = position.location
    const responders = (pickedLoc ? (byLocation.get(pickedLoc) ?? []) : []).slice(0, MAX_SCENE_RESPONDERS)
    if (!pickedLoc || !responders.length) {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', message: '这里现在没有人——换个地点，或等世界里的人醒着走到一处再来。' }),
      })
      return
    }

    // 同一条时间线、同一在场身份、同一地点接续同一场交谈；刷新/重试不会断上下文。
    // kind=scene 不进入 NPC 引擎的 ongoing 对话轮转。
    let dialogue = await db.select().from(dialogues).where(and(
      eq(dialogues.timelineId, tl.id), eq(dialogues.location, pickedLoc),
      eq(dialogues.visitorId, persona.id), eq(dialogues.kind, 'scene'),
    )).orderBy(desc(dialogues.simStart)).limit(1).get()
    if (!dialogue) {
      const participantIds = [persona.id, ...responders.map((r) => r.id)]
      const dialogueId = crypto.randomUUID()
      try {
        const opened = await commitWorldCommand(db, { id: `scene-open:${dialogueId}`, worldId: world.id, timelineId: tl.id,
          userId: world.userId, actorKind: 'visitor', actorPersonId: persona.id, expectedVersion: startingRevision.version,
          action: { type: 'scene_open', dialogueId, visitorId: persona.id, participantIds, location: pickedLoc, turnLimit: 100 } })
        startingRevision = { ...startingRevision, version: opened.version }
        dialogue = await db.select().from(dialogues).where(eq(dialogues.id, dialogueId)).get()
      } catch (error) {
        // Concurrent requests may have opened the same visitor/location scene first.
        dialogue = await db.select().from(dialogues).where(and(
          eq(dialogues.timelineId, tl.id), eq(dialogues.location, pickedLoc),
          eq(dialogues.visitorId, persona.id), eq(dialogues.kind, 'scene'),
        )).orderBy(desc(dialogues.simStart)).limit(1).get()
        if (!dialogue) {
          if (error instanceof WorldStateError) {
            await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: error.message }) })
            return
          }
          throw error
        }
      }
    }
    if (!dialogue) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '交谈记录创建失败，请重试。' }) })
      return
    }
    // The request's optimistic base starts after opening/reusing its conversation shell.
    startingRevision = await ensureUniverseRevision(db, world.id, tl.id)
    const dialogueId = dialogue.id
    const existingRequest = await db.select().from(sceneRequests).where(eq(sceneRequests.id, requestId)).get()
    if (existingRequest && existingRequest.dialogueId !== dialogueId) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: 'requestId 已用于其他交谈。' }) })
      return
    }
    if (existingRequest?.contentHash && existingRequest.contentHash !== contentHash) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: 'requestId 已提交过不同内容。' }) })
      return
    }
    if (existingRequest?.status === 'completed') {
      const command = await db.select().from(worldCommands).where(eq(worldCommands.id, `scene:${requestId}`)).get()
      type CommittedConversationAction = { type?: string; dialogueId?: string; turns?: { id: string; personId: string }[] }
      let action: CommittedConversationAction | null = null
      try { action = command ? JSON.parse(command.payloadJson) as CommittedConversationAction : null } catch { action = null }
      const originalTurns = action?.dialogueId === dialogueId && Array.isArray(action.turns)
        ? await db.select().from(dialogueTurns).where(eq(dialogueTurns.dialogueId, dialogueId)).all()
        : []
      const sameInput = action?.type === 'conversation' && originalTurns.some(turn =>
        action?.turns?.some(reference => reference.id === turn.id && reference.personId === turn.personId)
          && turn.personId === persona.id && turn.utterance === content,
      )
      if (!sameInput) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: 'requestId 已提交过不同内容。' }) })
        return
      }
      await stream.writeSSE({ data: JSON.stringify({ type: 'scene_start', dialogueId, location: pickedLoc, participants: responders.map(p => p.name) }) })
      await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) })
      return
    }
    if (existingRequest) {
      const message = existingRequest.status === 'pending' ? '上一条消息正在回应，请稍后重试。' : '这条请求未完成，请使用新的请求 ID 重试。'
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message }) })
      return
    }
    const reservedAt = Date.now()
    const [reservation] = await db.insert(sceneRequests).values({ id: requestId, dialogueId, contentHash, status: 'pending', createdAt: reservedAt, heartbeatAt: reservedAt })
      .onConflictDoNothing().returning({ id: sceneRequests.id }).all()
    if (!reservation) {
      const raced = await db.select().from(sceneRequests).where(eq(sceneRequests.id, requestId)).get()
      const message = raced?.contentHash && raced.contentHash !== contentHash
        ? 'requestId 已提交过不同内容。'
        : '上一条消息正在回应或刚刚完成；请查询交谈记录后再继续。'
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message }) })
      return
    }
    const priorTurns = await db.select().from(dialogueTurns).where(eq(dialogueTurns.dialogueId, dialogueId)).orderBy(asc(dialogueTurns.turnIndex)).all()
    const nextIndex = priorTurns.length ? Math.max(...priorTurns.map(t => t.turnIndex)) + 1 : 0
    const newTurns: { id: string; personId: string; utterance: string }[] = []
    const atomicWrites: BatchItem<'sqlite'>[] = []
    const privateEffects: Extract<WorldAction, { type: 'conversation' }>['privateEffects'] = { memories: [], messages: [] }
    const emittedUtterances: { personId: string; name: string; text: string }[] = []
    const generatedCommitments: { id: string; personId: string; raw: unknown }[] = []
    const acceptedCommitments: { id: string; personId: string; title: string; kind: 'meeting' | 'help'; location: string; dueSim: string }[] = []
    const visitorTurnId = crypto.randomUUID()
    atomicWrites.push(db.insert(dialogueTurns).values({
      id: visitorTurnId,
      dialogueId,
      turnIndex: nextIndex,
      personId: persona.id,
      utterance: content,
      thought: '',
      simTime: simNow,
      createdAt: now,
    }))
    newTurns.push({ id: visitorTurnId, personId: persona.id, utterance: content })
    const markCancelled = async () => {
      await db.update(sceneRequests).set({ status: 'failed' }).where(and(
        eq(sceneRequests.id, requestId), eq(sceneRequests.status, 'pending'),
      ))
    }

    await stream.writeSSE({
      data: JSON.stringify({ type: 'scene_start', dialogueId, location: pickedLoc, participants: responders.map((p) => p.name) }),
    })
    if (generation.signal.aborted) { await markCancelled(); return }

    const profile = personaProfile(persona)
    const turns: DialogueTurnView[] = [
      ...priorTurns.map(t => ({ personName: snapshot.persons.find(p => p.id === t.personId)?.name ?? '某人', utterance: t.utterance })),
      { personName: persona.name, utterance: content },
    ]
    const invitationContext = [...priorTurns.filter(turn => turn.personId === persona.id).map(turn => turn.utterance), content].join('\n')
    const hasExplicitInvitation = containsExplicitInvitationRequest(invitationContext)
    for (const responder of responders) {
      if (generation.signal.aborted) { await markCancelled(); return }
      if (currentWorld.status !== 'running') break
      const ctx = await buildEngineContext(db, responder.id, snapshot)
      if (!ctx) continue
      const prompt = buildScenePrompt(ctx, { name: persona.name, profile }, pickedLoc, turns)

      let output: ReturnType<typeof parseSceneOutput> | null = null
      const reserve = worldReservation(db, world.id, cfg, { timelineId: tl.id, personId: responder.id, purpose: 'scene' })
      const responderConfig = configFromEnv(c.env, reserve)
      for (let attempt = 0; attempt < 2 && !output; attempt++) {
        try {
          const [lease] = await db.update(sceneRequests).set({ heartbeatAt: Date.now() }).where(and(
            eq(sceneRequests.id, requestId), eq(sceneRequests.status, 'pending'),
          )).returning({ id: sceneRequests.id }).all()
          if (!lease) {
            await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '交谈请求已失效，请使用新的请求 ID 重试。' }) })
            return
          }
          const raw = await complete(responderConfig, [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ], { signal: generation.signal })
          output = parseSceneOutput(extractJson(raw))
        } catch (e) {
          if (generation.signal.aborted) { await markCancelled(); return }
          if (e instanceof BudgetRefusal) {
            await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: e.message }) })
            break
          }
          // 重试一次后仍失败：跳过这位回应者
        }
      }
      if (!output) continue

      // 回应是对话的一轮；内心想法与值得记住的事写入记忆流（TA 会记住这次相遇）
      const responseTurnId = crypto.randomUUID()
      atomicWrites.push(db.insert(dialogueTurns).values({
        id: responseTurnId,
        dialogueId,
        turnIndex: turns.length,
        personId: responder.id,
        utterance: output.utterance,
        thought: output.thought,
        simTime: simNow,
        createdAt: now,
      }))
      newTurns.push({ id: responseTurnId, personId: responder.id, utterance: output.utterance })
      const thoughtMemory = {
        id: crypto.randomUUID(), personId: responder.id, type: 'thought' as const, content: output.thought, importance: 5,
        simTime: simNow, createdAt: now,
      }
      privateEffects.memories.push(thoughtMemory)
      atomicWrites.push(db.insert(memories).values({
        id: thoughtMemory.id,
        personId: thoughtMemory.personId,
        timelineId: tl.id,
        type: thoughtMemory.type,
        content: thoughtMemory.content,
        simTime: thoughtMemory.simTime,
        createdAt: thoughtMemory.createdAt,
        importance: thoughtMemory.importance,
      }))
      if (output.memory) {
        const relationshipMemory = {
          id: crypto.randomUUID(), personId: responder.id, type: 'relationship' as const,
          content: output.memory.content, importance: clampImportance(output.memory.importance), simTime: simNow, createdAt: now,
        }
        privateEffects.memories.push(relationshipMemory)
        atomicWrites.push(db.insert(memories).values({
          id: relationshipMemory.id,
          personId: relationshipMemory.personId,
          timelineId: tl.id,
          type: relationshipMemory.type,
          content: relationshipMemory.content,
          simTime: relationshipMemory.simTime,
          createdAt: relationshipMemory.createdAt,
          importance: relationshipMemory.importance,
        }))
      }
      // 留言：人物有话托付给来访者——TA 下次进入世界时送达
      if (output.word) {
        const message = {
          id: crypto.randomUUID(), senderPersonId: responder.id, recipientPersonId: persona.id,
          content: output.word, location: pickedLoc, simTime: simNow, createdAt: now,
        }
        privateEffects.messages.push(message)
        atomicWrites.push(db.insert(personaMessages).values({
          id: message.id,
          worldId: world.id,
          timelineId: tl.id,
          senderPersonId: message.senderPersonId,
          recipientPersonId: message.recipientPersonId,
          content: message.content,
          location: message.location,
          simTime: message.simTime,
          read: false,
          createdAt: message.createdAt,
        }))
      }
      if (output.commitment) {
        generatedCommitments.push({ id: `commitment:${dialogueId}:${responder.id}:${simNow}`, personId: responder.id, raw: output.commitment })
      }
      // A resident's model output alone cannot create a visitor's promise: the visitor
      // must have explicitly asked, and the structured acceptance is committed below
      // together with this conversation's turns and immutable world evidence.
      if (hasExplicitInvitation && output.visitorInvitationResponse?.decision === 'accepted') {
        const invitation = output.visitorInvitationResponse.invitation
        if (snapshot.locations.some(location => location.name === invitation.location)) {
          acceptedCommitments.push({
            id: `accepted:${requestId}:${responder.id}`,
            personId: responder.id,
            title: invitation.title,
            kind: invitation.kind,
            location: invitation.location,
            dueSim: new Date(Date.parse(simNow) + invitation.dueInMinutes * 60_000).toISOString(),
          })
        }
      }

      turns.push({ personName: responder.name, utterance: output.utterance })
      emittedUtterances.push({ personId: responder.id, name: responder.name, text: output.utterance })
    }

    if (generation.signal.aborted) { await markCancelled(); return }

    try {
      await commitWorldCommand(db, {
        id: `scene:${requestId}`, worldId: world.id, timelineId: tl.id, userId,
        actorKind: 'visitor', actorPersonId: persona.id, expectedVersion: startingRevision.version,
        action: { type: 'conversation', dialogueId, requestId, turns: newTurns,
          sceneProjection: { location: pickedLoc, participantIds: [persona.id, ...responders.map(responder => responder.id)], simTime: simNow, turnLimit: 100 },
          privateEffects,
          ...(acceptedCommitments.length ? { acceptedCommitments } : {}) },
      }, [
        ...atomicWrites,
        db.update(sceneRequests).set({ status: 'completed' }).where(and(eq(sceneRequests.id, requestId), eq(sceneRequests.status, 'pending'))),
      ])
    } catch (error) {
      await db.update(sceneRequests).set({ status: 'failed' }).where(eq(sceneRequests.id, requestId))
      const message = error instanceof WorldStateError ? error.message : '交谈未能写入世界状态，请使用新的请求 ID 重试。'
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message }) })
      return
    }

    for (const utterance of emittedUtterances) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'utterance', ...utterance }) })
    }
    for (const generated of generatedCommitments) {
      const responder = responders.find(person => person.id === generated.personId)
      if (responder) await proposeCommitment(db, { id: generated.id, worldId: world.id, timelineId: tl.id,
        personId: generated.personId, visitorId: persona.id, sourceDialogueId: dialogueId, simNow,
        raw: generated.raw, locations: snapshot.locations })
    }

    await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) })
  })
})
