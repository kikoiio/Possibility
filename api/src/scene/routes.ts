import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import type { SSEStreamingApi } from 'hono/streaming'
import { createDb, type Db } from '../db/client'
import { events, memories, personaMessages, persons, timelines, worlds, worldPersons } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { buildWorldSnapshot, buildEngineContext, isAwake, parseScheduleItems } from '../agent/engine-context'
import { buildScenePrompt, extractJson, type DialogueTurnView } from '../agent/engine-prompt'
import { parseSceneOutput } from './parse'
import { clampImportance } from '../agent/memory'
import { budgetFromEnv, capWorld, dailyCapHit, recordCall, touchWorldActivity } from '../engine/budget'
import { gateWorld } from '../engine/guard'
import { complete, configFromEnv } from '../llm/client'
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

/**
 * 你在世界里（Character.AI Persona 思路的落地）：
 * 用户以登记过的在场身份来到某地点说话 → 该地点清醒且空闲的人物依次以本人身份回应
 * （1 人 1 次 LLM 调用，purpose='scene'），回应写入事件流与记忆流——
 * 这场相遇从此留在世界史里，也留在每个人的记忆里。SSE 逐句推送。
 */
sceneRoutes.post('/worlds/:id/scene', async (c) => {
  const body = await c.req.json<{ timelineId?: string; location?: string; content?: string }>().catch(() => null)
  const content = body?.content?.trim()
  if (!content) return c.json({ error: '内容不能为空' }, 400)

  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const world = await loadOwnedWorld(db, c.req.param('id'), userId)
  if (!world) return c.json({ error: '世界不存在' }, 404)

  const tls = await db.select().from(timelines).where(eq(timelines.worldId, world.id)).all()
  const tl = (body?.timelineId && tls.find((t) => t.id === body.timelineId)) || tls.find((t) => t.parentTimelineId === null)
  if (!tl) return c.json({ error: '时间线不存在' }, 404)

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
    const eligible = snapshot.persons.filter((p) => {
      if (p.isUser) return false
      const s = snapshot.states.get(p.id)
      if (!s || s.currentDialogueId) return false
      if (body?.location && s.location !== body.location) return false
      return isAwake(parseScheduleItems(snapshot.schedules.get(p.id)), simNow)
    })
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

    // 用户的话先进世界史（事件流）；章节回顾会把它织进小说里
    await db.insert(events).values({
      id: crypto.randomUUID(),
      timelineId: tl.id,
      simTime: simNow,
      title: `${persona.name}说`,
      description: content,
      kind: 'action',
      actorPersonId: persona.id,
    })

    await stream.writeSSE({
      data: JSON.stringify({ type: 'scene_start', location: pickedLoc, participants: responders.map((p) => p.name) }),
    })

    const profile = personaProfile(persona)
    const turns: DialogueTurnView[] = [{ personName: persona.name, utterance: content }]
    const config = configFromEnv(c.env)

    for (const responder of responders) {
      if (currentWorld.status !== 'running') break
      const ctx = await buildEngineContext(db, responder.id, snapshot)
      if (!ctx) continue
      const prompt = buildScenePrompt(ctx, { name: persona.name, profile }, pickedLoc, turns)

      let output: ReturnType<typeof parseSceneOutput> | null = null
      let llmCalls = 0
      for (let attempt = 0; attempt < 2 && !output; attempt++) {
        llmCalls++
        try {
          const raw = await complete(config, [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ])
          output = parseSceneOutput(extractJson(raw))
        } catch {
          // 重试一次后仍失败：跳过这位回应者
        }
      }

      if (llmCalls > 0) {
        currentWorld = await recordCall(db, currentWorld, { timelineId: tl.id, personId: responder.id, purpose: 'scene' }, llmCalls)
        if (dailyCapHit(currentWorld, cfg)) {
          await capWorld(db, currentWorld.id)
          currentWorld = { ...currentWorld, status: 'capped', pauseReason: 'daily_cap' }
          await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '世界今日调用已达上限，余下的回应留到明天。' }) })
          break
        }
      }
      if (!output) continue

      // 回应写入世界史；内心想法与值得记住的事写入记忆流（TA 会记住这次相遇）
      await db.insert(events).values({
        id: crypto.randomUUID(),
        timelineId: tl.id,
        simTime: simNow,
        title: `${responder.name}对${persona.name}说`,
        description: output.utterance,
        kind: 'action',
        actorPersonId: responder.id,
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

      turns.push({ personName: responder.name, utterance: output.utterance })
      await stream.writeSSE({
        data: JSON.stringify({ type: 'utterance', personId: responder.id, name: responder.name, text: output.utterance }),
      })
    }

    await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) })
  })
})
