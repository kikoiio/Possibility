import { Hono } from 'hono'
import { and, asc, desc, eq } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import type { SSEStreamingApi } from 'hono/streaming'
import { createDb, type Db } from '../db/client'
import { events, memories, personaMessages, persons, timelines, worlds, worldPersons, dialogues, dialogueTurns, sceneRequests } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { buildWorldSnapshot, buildEngineContext } from '../agent/engine-context'
import { buildScenePrompt, extractJson, type DialogueTurnView } from '../agent/engine-prompt'
import { parseSceneOutput } from './parse'
import { sceneDialogueTitle, sceneTranscript } from './plan'
import { eligibleAt, eligibleBoard } from './eligible'
import { clampImportance } from '../agent/memory'
import { budgetFromEnv, touchWorldActivity } from '../engine/budget'
import { BudgetRefusal, gateWorld, worldReservation } from '../engine/guard'
import { complete, configFromEnv } from '../llm/client'
import { proposeCommitment } from '../life/service'
import type { Env } from '../index'

type World = typeof worlds.$inferSelect
type Person = typeof persons.$inferSelect

export const sceneRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
sceneRoutes.use('*', authMiddleware)

/** 同一地点一场 scene 最多回应的人数（每人一次 LLM 调用） */
export const MAX_SCENE_RESPONDERS = 3

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
  const tl = c.req.query('timelineId') ? tls.find(t => t.id === c.req.query('timelineId')) : tls.find((t) => t.parentTimelineId === null) ?? tls[0]
  if (!tl) return c.json({ error: '时间线不存在' }, 404)
  const snapshot = await buildWorldSnapshot(db, world.id, tl.id)
  if (!snapshot) return c.json({ error: '世界快照不存在' }, 404)
  return c.json({ board: eligibleBoard(snapshot) })
})

/** 最近一场连续交谈；读取不产生模型调用或写入。 */
sceneRoutes.get('/worlds/:id/scene/history', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const persona = await loadPersona(db, world.id, c.get('user').id)
  if (!persona) return c.json({ error: '先登记身份' }, 400)
  const tls = await db.select().from(timelines).where(eq(timelines.worldId, world.id)).all()
  const tl = c.req.query('timelineId') ? tls.find(t => t.id === c.req.query('timelineId')) : tls.find(t => !t.parentTimelineId)
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

  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const world = await loadOwnedWorld(db, c.req.param('id'), userId)
  if (!world) return c.json({ error: '世界不存在' }, 404)

  const tls = await db.select().from(timelines).where(eq(timelines.worldId, world.id)).all()
  const tl = body?.timelineId ? tls.find((t) => t.id === body.timelineId) : tls.find((t) => t.parentTimelineId === null)
  if (!tl || tl.status !== 'active') return c.json({ error: '时间线不存在或已归档' }, 404)

  const persona = await loadPersona(db, world.id, userId)
  if (!persona) return c.json({ error: '先在世界中登记你的在场身份（进入世界时会引导你）' }, 400)

  return streamSSE(c, async (stream) => {
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
    const now = new Date().toISOString()

    // 在场者：同一地点（或指定地点）、清醒、未在对话中；用户身份除外
    const eligible = eligibleAt(snapshot, body?.location)
    const byLocation = new Map<string, typeof eligible>()
    for (const p of eligible) {
      const loc = snapshot.states.get(p.id)!.location
      byLocation.set(loc, [...(byLocation.get(loc) ?? []), p])
    }
    const pickedLoc = body?.location ?? [...byLocation.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0]
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
      await db.insert(dialogues).values({
        id: dialogueId, timelineId: tl.id, location: pickedLoc,
        participantIdsJson: JSON.stringify(participantIds), status: 'scene', kind: 'scene', visitorId: persona.id,
        turnLimit: 100, simStart: simNow, simEnd: simNow,
      })
      dialogue = await db.select().from(dialogues).where(eq(dialogues.id, dialogueId)).get()
    }
    if (!dialogue) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '交谈记录创建失败，请重试。' }) })
      return
    }
    const dialogueId = dialogue.id
    if (body?.requestId) {
      const existingRequest = await db.select().from(sceneRequests).where(eq(sceneRequests.id, body.requestId)).get()
      if (existingRequest?.status === 'completed') {
        await stream.writeSSE({ data: JSON.stringify({ type: 'scene_start', dialogueId, location: pickedLoc, participants: responders.map(p => p.name) }) })
        await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) })
        return
      }
      if (existingRequest) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '上一条消息正在回应，请稍后重试。' }) })
        return
      }
      await db.insert(sceneRequests).values({ id: body.requestId, dialogueId, status: 'pending', createdAt: Date.now() })
    }
    const priorTurns = await db.select().from(dialogueTurns).where(eq(dialogueTurns.dialogueId, dialogueId)).orderBy(asc(dialogueTurns.turnIndex)).all()
    const nextIndex = priorTurns.length ? Math.max(...priorTurns.map(t => t.turnIndex)) + 1 : 0
    await db.insert(dialogueTurns).values({
      id: crypto.randomUUID(),
      dialogueId,
      turnIndex: nextIndex,
      personId: persona.id,
      utterance: content,
      thought: '',
      simTime: simNow,
      createdAt: now,
    })

    await stream.writeSSE({
      data: JSON.stringify({ type: 'scene_start', dialogueId, location: pickedLoc, participants: responders.map((p) => p.name) }),
    })

    const profile = personaProfile(persona)
    const turns: DialogueTurnView[] = [
      ...priorTurns.map(t => ({ personName: snapshot.persons.find(p => p.id === t.personId)?.name ?? '某人', utterance: t.utterance })),
      { personName: persona.name, utterance: content },
    ]
    for (const responder of responders) {
      if (currentWorld.status !== 'running') break
      const ctx = await buildEngineContext(db, responder.id, snapshot)
      if (!ctx) continue
      const prompt = buildScenePrompt(ctx, { name: persona.name, profile }, pickedLoc, turns)

      let output: ReturnType<typeof parseSceneOutput> | null = null
      const reserve = worldReservation(db, world.id, cfg, { timelineId: tl.id, personId: responder.id, purpose: 'scene' })
      const responderConfig = configFromEnv(c.env, reserve)
      for (let attempt = 0; attempt < 2 && !output; attempt++) {
        try {
          const raw = await complete(responderConfig, [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ])
          output = parseSceneOutput(extractJson(raw))
        } catch (e) {
          if (e instanceof BudgetRefusal) {
            await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: e.message }) })
            break
          }
          // 重试一次后仍失败：跳过这位回应者
        }
      }
      if (!output) continue

      // 回应是对话的一轮；内心想法与值得记住的事写入记忆流（TA 会记住这次相遇）
      await db.insert(dialogueTurns).values({
        id: crypto.randomUUID(),
        dialogueId,
        turnIndex: turns.length,
        personId: responder.id,
        utterance: output.utterance,
        thought: output.thought,
        simTime: simNow,
        createdAt: now,
      })
      await db.insert(memories).values({
        id: crypto.randomUUID(),
        personId: responder.id,
        timelineId: tl.id,
        type: 'thought',
        content: output.thought,
        simTime: simNow,
        createdAt: now,
        importance: 5,
      })
      if (output.memory) {
        await db.insert(memories).values({
          id: crypto.randomUUID(),
          personId: responder.id,
          timelineId: tl.id,
          type: 'relationship',
          content: output.memory.content,
          simTime: simNow,
          createdAt: now,
          importance: clampImportance(output.memory.importance),
        })
      }
      // 留言：人物有话托付给来访者——TA 下次进入世界时送达
      if (output.word) {
        await db.insert(personaMessages).values({
          id: crypto.randomUUID(),
          worldId: world.id,
          timelineId: tl.id,
          senderPersonId: responder.id,
          recipientPersonId: persona.id,
          content: output.word,
          location: pickedLoc,
          simTime: simNow,
          read: false,
          createdAt: now,
        })
      }
      if (output.commitment) {
        await proposeCommitment(db, { id: `commitment:${dialogueId}:${responder.id}:${simNow}`, worldId: world.id, timelineId: tl.id,
          personId: responder.id, visitorId: persona.id, sourceDialogueId: dialogueId, simNow, raw: output.commitment, locations: snapshot.locations })
      }

      turns.push({ personName: responder.name, utterance: output.utterance })
      await stream.writeSSE({
        data: JSON.stringify({ type: 'utterance', personId: responder.id, name: responder.name, text: output.utterance }),
      })
    }

    // 至少有一位回应者接上了话，才把这场相遇作为对话事件写进世界史：
    // 事件流可逐句展开，章节回顾拿到完整对话摘录
    if (turns.length > 1) {
      const allTurns = await db.select().from(dialogueTurns).where(eq(dialogueTurns.dialogueId, dialogueId)).orderBy(asc(dialogueTurns.turnIndex)).all()
      await db.insert(events).values({
        id: crypto.randomUUID(),
        timelineId: tl.id,
        simTime: simNow,
        title: sceneDialogueTitle(
          persona.name,
          turns.slice(1).map((t) => t.personName),
          pickedLoc,
        ),
        description: sceneTranscript(allTurns.map((t) => ({ name: snapshot.persons.find(p => p.id === t.personId)?.name ?? persona.name, utterance: t.utterance }))),
        kind: 'dialogue',
        dialogueId,
        actorPersonId: persona.id,
      })
    }

    if (body?.requestId) {
      await db.update(sceneRequests).set({ status: 'completed' }).where(and(eq(sceneRequests.id, body.requestId), eq(sceneRequests.status, 'pending')))
    }

    await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) })
  })
})
