import { Hono } from 'hono'
import { and, asc, desc, eq } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import type { SSEStreamingApi } from 'hono/streaming'
import { createDb, type Db } from '../db/client'
import { conversations, messages, timelines } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { buildAgentContext } from '../agent/context'
import { runAgentTurn, type HistoryMessage } from '../agent/loop'
import { budgetFromEnv, touchWorldActivity } from '../engine/budget'
import { gateWorld } from '../engine/guard'
import type { AgentMode } from '../agent/types'
import type { Env } from '../index'

type Conversation = typeof conversations.$inferSelect

export const chatRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
chatRoutes.use('*', authMiddleware)

const CATCHUP_THRESHOLD_MS = 30 * 60 * 1000 // 30 分钟

function humanizeElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`
  const days = Math.floor(hours / 24)
  return `${days} 天${hours % 24 ? ` ${hours % 24} 小时` : ''}`
}

async function loadOwnedConversation(
  db: Db,
  conversationId: string,
  userId: string,
): Promise<Conversation | null> {
  const convo = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .get()
  return convo ?? null
}

/** get-or-create：每条时间线下与某人只有一个对话 */
chatRoutes.post('/persons/:id/conversations', async (c) => {
  const body = await c.req.json<{ timelineId?: string | null }>().catch(() => ({}) as { timelineId?: string | null })
  const db = createDb(c.env.DB)
  const userId = c.get('user').id

  const ctx = await buildAgentContext(db, {
    userId,
    personId: c.req.param('id'),
    timelineId: body.timelineId ?? null,
    mode: 'chat',
  })
  if (!ctx) return c.json({ error: '人物或时间线不存在' }, 404)

  let convo = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.personId, ctx.person.id), eq(conversations.timelineId, ctx.timeline.id)))
    .get()
  if (!convo) {
    if (ctx.timeline.status !== 'active') return c.json({ error: '时间线已归档，不能继续交谈' }, 409)
    const gate = await gateWorld(db, ctx.world.id, budgetFromEnv(c.env))
    if (!gate.ok) return c.json({ error: gate.error }, gate.status)
    const id = crypto.randomUUID()
    await db.insert(conversations).values({
      id,
      userId,
      personId: ctx.person.id,
      timelineId: ctx.timeline.id,
    })
    convo = { id, userId, personId: ctx.person.id, timelineId: ctx.timeline.id }
  }
  return c.json({ id: convo.id, personId: convo.personId, timelineId: convo.timelineId })
})

chatRoutes.get('/conversations/:id/messages', async (c) => {
  const db = createDb(c.env.DB)
  const convo = await loadOwnedConversation(db, c.req.param('id'), c.get('user').id)
  if (!convo) return c.json({ error: '对话不存在' }, 404)
  const list = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, convo.id))
    .orderBy(asc(messages.createdAt))
    .all()
  return c.json({ messages: list })
})

/** 跑一个自主体回合，把事件逐条写入 SSE；返回累计的用户可见文本（并按实际 LLM 调用数记账） */
async function runAndStream(
  stream: SSEStreamingApi,
  env: Env,
  db: Db,
  opts: {
    userId: string
    personId: string
    timelineId: string
    mode: AgentMode
    input: string
    runId: string
    history?: HistoryMessage[]
  },
): Promise<{ text: string; complete: boolean }> {
  const ctx = await buildAgentContext(db, {
    userId: opts.userId,
    personId: opts.personId,
    timelineId: opts.timelineId,
    mode: opts.mode,
  })
  if (!ctx) {
    await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '上下文不存在' }) })
    return { text: '', complete: false }
  }
  if (ctx.timeline.status !== 'active') {
    await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '时间线已归档，不能继续交谈' }) })
    return { text: '', complete: false }
  }

  // 护栏：聊天同样受世界状态与日限额约束（此前 paused/capped 世界照样烧调用）
  const cfg = budgetFromEnv(env)
  const gate = await gateWorld(db, ctx.world.id, cfg)
  if (!gate.ok) {
    await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: gate.error }) })
    return { text: '', complete: false }
  }

  let full = ''
  let complete = false
  const controller = new AbortController()
  stream.onAbort(() => controller.abort())
  if (stream.aborted) controller.abort()
  try {
    for await (const ev of runAgentTurn(env, db, ctx, opts.input, opts.history ?? [], { signal: controller.signal, runId: opts.runId })) {
      if (ev.type === 'text') full += ev.delta
      if (ev.type === 'done') {
        if (ev.error) {
          await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: ev.error }) })
        } else {
          complete = true
        }
        break
      }
      await stream.writeSSE({ data: JSON.stringify(ev) })
    }
  } catch (e) {
    await stream.writeSSE({
      data: JSON.stringify({ type: 'error', message: e instanceof Error ? e.message : '模型调用失败' }),
    })
  }
  return { text: full, complete }
}

/** 发消息：存 user 消息 → 自主体回合 → SSE 流 → 存 person 消息 */
chatRoutes.post('/conversations/:id/messages', async (c) => {
  const body = await c.req.json<{ content?: string }>().catch(() => null)
  const content = body?.content?.trim()
  if (!content) return c.json({ error: '内容不能为空' }, 400)

  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const convo = await loadOwnedConversation(db, c.req.param('id'), userId)
  if (!convo) return c.json({ error: '对话不存在' }, 404)

  // 旧聊天仍可读取，但被拒绝的发送不能先落下一条用户消息。
  const ctx = await buildAgentContext(db, { userId, personId: convo.personId, timelineId: convo.timelineId, mode: 'chat' })
  if (!ctx) return c.json({ error: '上下文不存在' }, 404)
  if (ctx.timeline.status !== 'active') return c.json({ error: '时间线已归档，不能继续交谈' }, 409)
  const gate = await gateWorld(db, ctx.world.id, budgetFromEnv(c.env))
  if (!gate.ok) return c.json({ error: gate.error }, gate.status)

  const now = new Date().toISOString()
  const userMessageId = crypto.randomUUID()
  await db.insert(messages).values({
    id: userMessageId,
    conversationId: convo.id,
    role: 'user',
    content,
    createdAt: now,
  })
  // 用户交互痕迹：闲置自动归档以此为据
  const tlRow = await db.select({ worldId: timelines.worldId }).from(timelines).where(eq(timelines.id, convo.timelineId)).get()
  if (tlRow) await touchWorldActivity(db, tlRow.worldId)

  const recent = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, convo.id))
    .orderBy(desc(messages.createdAt))
    .limit(20)
    .all()
  const history: HistoryMessage[] = recent
    .reverse()
    .slice(0, -1) // 最后一条是刚存的用户消息，作为 input 传入
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }))

  return streamSSE(c, async (stream) => {
    const result = await runAndStream(stream, c.env, db, {
      userId,
      personId: convo.personId,
      timelineId: convo.timelineId,
      mode: 'chat',
      input: content,
      runId: userMessageId,
      history,
    })
    if (result.complete && result.text.trim()) {
      await db.insert(messages).values({
        id: crypto.randomUUID(),
        conversationId: convo.id,
        role: 'person',
        content: result.text,
        createdAt: new Date().toISOString(),
      })
    }
  })
})

/** 懒惰追赶（F8）：经过时间超过阈值则让 TA 推演这段时间的经历 */
chatRoutes.post('/conversations/:id/catchup', async (c) => {
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const convo = await loadOwnedConversation(db, c.req.param('id'), userId)
  if (!convo) return c.json({ error: '对话不存在' }, 404)

  return streamSSE(c, async (stream) => {
    const ctx = await buildAgentContext(db, {
      userId,
      personId: convo.personId,
      timelineId: convo.timelineId,
      mode: 'catchup',
    })
    if (!ctx) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '上下文不存在' }) })
      return
    }
    // 间隔按"虚拟时间"计：sim 时钟 6 倍速领先真实时间，用真实间隔会严重低估空白
    const simElapsed = Date.parse(ctx.timeline.simNow) - Date.parse(ctx.state.simTime)
    if (simElapsed < CATCHUP_THRESHOLD_MS) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'skipped' }) })
      await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) })
      return
    }

    const input = `距离我们上次联系，时间过去了 ${humanizeElapsed(simElapsed)}。请按你的模式指令，补齐这段时间你的生活。`
    const result = await runAndStream(stream, c.env, db, {
      userId,
      personId: convo.personId,
      timelineId: convo.timelineId,
      mode: 'catchup',
      input,
      runId: `catchup:${ctx.state.personId}:${ctx.state.simTime}:${ctx.timeline.simNow}`,
    })
    if (result.complete && result.text.trim()) {
      await db.insert(messages).values({
        id: crypto.randomUUID(),
        conversationId: convo.id,
        role: 'system_note',
        content: result.text,
        createdAt: new Date().toISOString(),
      })
    }
  })
})
