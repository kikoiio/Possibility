import { Hono } from 'hono'
import { and, asc, desc, eq } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import type { SSEStreamingApi } from 'hono/streaming'
import { createDb, type Db } from '../db/client'
import { conversations, messages, timelines } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { buildAgentContext } from '../agent/context'
import { runAgentTurn, type HistoryMessage } from '../agent/loop'
import { recordCall } from '../engine/budget'
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
    history?: HistoryMessage[]
  },
): Promise<string> {
  const ctx = await buildAgentContext(db, {
    userId: opts.userId,
    personId: opts.personId,
    timelineId: opts.timelineId,
    mode: opts.mode,
  })
  if (!ctx) {
    await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '上下文不存在' }) })
    return ''
  }
  let full = ''
  let llmCalls = 0
  try {
    for await (const ev of runAgentTurn(env, db, ctx, opts.input, opts.history ?? [])) {
      if (ev.type === 'text') full += ev.delta
      if (ev.type === 'done' && typeof ev.llmCalls === 'number') llmCalls = ev.llmCalls
      await stream.writeSSE({ data: JSON.stringify(ev) })
      if (ev.type === 'done') break
    }
  } catch (e) {
    await stream.writeSSE({
      data: JSON.stringify({ type: 'error', message: e instanceof Error ? e.message : '模型调用失败' }),
    })
  }
  if (llmCalls > 0) {
    await recordCall(db, ctx.world, { timelineId: ctx.timeline.id, personId: ctx.person.id, purpose: 'chat' }, llmCalls)
  }
  return full
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

  const now = new Date().toISOString()
  await db.insert(messages).values({
    id: crypto.randomUUID(),
    conversationId: convo.id,
    role: 'user',
    content,
    createdAt: now,
  })

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
    const full = await runAndStream(stream, c.env, db, {
      userId,
      personId: convo.personId,
      timelineId: convo.timelineId,
      mode: 'chat',
      input: content,
      history,
    })
    if (full.trim()) {
      await db.insert(messages).values({
        id: crypto.randomUUID(),
        conversationId: convo.id,
        role: 'person',
        content: full,
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
    const elapsed = Date.now() - Date.parse(ctx.state.updatedRealAt)
    if (elapsed < CATCHUP_THRESHOLD_MS) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'skipped' }) })
      await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) })
      return
    }

    const input = `距离我们上次联系，时间过去了 ${humanizeElapsed(elapsed)}。请按你的模式指令，补齐这段时间你的生活。`
    const full = await runAndStream(stream, c.env, db, {
      userId,
      personId: convo.personId,
      timelineId: convo.timelineId,
      mode: 'catchup',
      input,
    })
    if (full.trim()) {
      await db.insert(messages).values({
        id: crypto.randomUUID(),
        conversationId: convo.id,
        role: 'system_note',
        content: full,
        createdAt: new Date().toISOString(),
      })
    }
  })
})
