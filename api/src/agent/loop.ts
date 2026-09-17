import { and, eq, lt } from 'drizzle-orm'
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

/** 单次流式调用的挂死上限（与 llm/client.ts streamChat 缺省一致） */
const STREAM_TIMEOUT_MS = 120_000

/**
 * 自主体主循环（三种模式共用）：
 * 组装提示 → 流式调用 → 文本增量产出；tool_call → 执行 → 副作用事件产出
 * → 工具结果回灌消息列表 → 继续，直到无更多 tool_call。
 *
 * 时钟纪律（单点化）：run.clock 一律以时间线 simNow 为锚，模型给出的 simTime
 * 只被钳制在 [clock, windowEnd] 内；chat/catchup 的窗口右端 = simNow（不再用
 * 真实时间——它恒落后于 6 倍速的 sim 时钟，曾导致 catchup 把世界时间往回拨）。
 * timelines.simNow 只有本函数的 simulate（分叉推演）模式写回，且用条件更新
 * （不小于当前值），其余模式的时钟推进全部归引擎 tick 单点管辖。
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

  const simNowMs = Date.parse(ctx.timeline.simNow) || Date.now()
  const stateMs = Date.parse(ctx.state.simTime) || simNowMs
  const run: ToolRunState = {
    db,
    personId: ctx.person.id,
    timelineId: ctx.timeline.id,
    isMain: ctx.isMain,
    mode: ctx.mode,
    // catchup 从人物状态时间起填空白区间；chat/simulate 从各自锚点起
    clock: ctx.mode === 'catchup' ? Math.min(stateMs, simNowMs) : ctx.mode === 'simulate' ? stateMs : simNowMs,
    windowEnd: ctx.mode === 'simulate' ? null : simNowMs,
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
  let streamError: string | null = null
  for (let iter = 0; iter < maxIterations; iter++) {
    let text = ''
    const calls: { id: string; name: string; args: Record<string, unknown> }[] = []

    llmCalls++
    try {
      for await (const ev of streamChat(config, messages, tools, { timeoutMs: STREAM_TIMEOUT_MS })) {
        if (ev.type === 'text') {
          text += ev.delta
          yield { type: 'text', delta: ev.delta }
        } else if (ev.type === 'tool_call') {
          calls.push({ id: ev.id, name: ev.name, args: (ev.args ?? {}) as Record<string, unknown> })
        }
      }
    } catch (e) {
      // 流中途失败（超时/断流）：中断回合但照常产出 done——llmCalls 是已真实发生的
      // 调用数，调用方必须照此记账，否则预算护栏出现旁路。
      streamError = e instanceof Error ? e.message : '模型调用失败'
      break
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

  // 时钟写回：仅 simulate（分叉推演）推进时间线，且不许拨回（条件更新兜底并发）
  if (touched && ctx.mode === 'simulate' && run.clock > simNowMs) {
    const next = new Date(run.clock).toISOString()
    await db
      .update(timelines)
      .set({ simNow: next })
      .where(and(eq(timelines.id, ctx.timeline.id), lt(timelines.simNow, next)))
  }
  yield { type: 'done', llmCalls, ...(streamError ? { error: streamError } : {}) }
}
