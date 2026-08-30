import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { timelines } from '../db/schema'
import { configFromEnv, streamChat, type ChatMessage } from '../llm/client'
import type { Env } from '../index'
import type { AgentContextData } from './context'
import { buildSystemPrompt } from './prompt'
import { executeTool, toolsFor, type ToolRunState } from './tools'
import type { AgentEvent } from './types'

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/**
 * 自主体主循环（三种模式共用）：
 * 组装提示 → 流式调用 → 文本增量产出；tool_call → 执行 → 副作用事件产出
 * → 工具结果回灌消息列表 → 继续，直到无更多 tool_call。
 */
export async function* runAgentTurn(
  env: Env,
  db: Db,
  ctx: AgentContextData,
  input: string,
  history: HistoryMessage[] = [],
  opts: { maxIterations?: number; maxActs?: number } = {},
): AsyncIterable<AgentEvent> {
  const config = configFromEnv(env)
  const tools = toolsFor(ctx.mode)
  const maxActs = opts.maxActs ?? (ctx.mode === 'chat' ? 5 : 15)
  const maxIterations = opts.maxIterations ?? (ctx.mode === 'chat' ? 6 : 25)

  const run: ToolRunState = {
    db,
    personId: ctx.person.id,
    timelineId: ctx.timeline.id,
    isMain: ctx.isMain,
    mode: ctx.mode,
    clock: Date.parse(ctx.state.simTime) || Date.now(),
    windowEnd: ctx.mode === 'catchup' ? Date.now() : null,
    acts: 0,
    maxActs,
    current: {
      location: ctx.state.location,
      activity: ctx.state.activity,
      mood: ctx.state.mood,
      goal: ctx.state.goal,
    },
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(ctx) },
    ...history,
    { role: 'user', content: input },
  ]

  let touched = false
  let llmCalls = 0
  for (let iter = 0; iter < maxIterations; iter++) {
    let text = ''
    const calls: { id: string; name: string; args: Record<string, unknown> }[] = []

    llmCalls++
    for await (const ev of streamChat(config, messages, tools)) {
      if (ev.type === 'text') {
        text += ev.delta
        yield { type: 'text', delta: ev.delta }
      } else if (ev.type === 'tool_call') {
        calls.push({ id: ev.id, name: ev.name, args: (ev.args ?? {}) as Record<string, unknown> })
      }
    }

    messages.push({
      role: 'assistant',
      content: text || null,
      ...(calls.length
        ? {
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          }
        : {}),
    })
    if (!calls.length) break

    for (const call of calls) {
      const { result, events } = await executeTool(run, call.name, call.args)
      if (events.length) touched = true
      for (const e of events) yield e
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
    }
  }

  // 虚拟时钟推进到时间线
  if (touched) {
    await db
      .update(timelines)
      .set({ simNow: new Date(run.clock).toISOString() })
      .where(eq(timelines.id, ctx.timeline.id))
  }
  yield { type: 'done', llmCalls }
}
