import type { Db } from '../db/client'
import { configFromEnv, streamChat, type ChatMessage } from '../llm/client'
import { budgetFromEnv } from '../engine/budget'
import { worldReservation } from '../engine/guard'
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
 * simulate 的时间推进由每次 act 与事实、投影同批提交；其他模式时钟由引擎 tick 管辖。
 */
export async function* runAgentTurn(
  env: Env,
  db: Db,
  ctx: AgentContextData,
  input: string,
  history: HistoryMessage[] = [],
  opts: { maxIterations?: number; maxActs?: number; signal?: AbortSignal; runId?: string } = {},
): AsyncIterable<AgentEvent> {
  const reserve = worldReservation(db, ctx.world.id, budgetFromEnv(env), {
    timelineId: ctx.timeline.id, personId: ctx.person.id, purpose: ctx.mode === 'simulate' ? 'fork_simulate' : 'chat',
  })
  const config = configFromEnv(env, reserve)
  const tools = toolsFor(ctx.mode)
  const maxActs = opts.maxActs ?? (ctx.mode === 'chat' ? 5 : 15)
  const maxIterations = opts.maxIterations ?? (ctx.mode === 'chat' ? 6 : 25)

  const simNowMs = Date.parse(ctx.timeline.simNow) || Date.now()
  const stateMs = Date.parse(ctx.state.simTime) || simNowMs
  const run: ToolRunState = {
    db,
    worldId: ctx.world.id,
    personId: ctx.person.id,
    timelineId: ctx.timeline.id,
    runId: opts.runId ?? crypto.randomUUID(),
    isMain: ctx.isMain,
    mode: ctx.mode,
    // catchup 从人物状态时间起填空白区间；chat/simulate 从各自锚点起
    clock: ctx.mode === 'catchup' ? Math.min(stateMs, simNowMs) : ctx.mode === 'simulate' ? Math.max(stateMs, simNowMs) : simNowMs,
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

  let streamError: string | null = null
  for (let iter = 0; iter < maxIterations; iter++) {
    let text = ''
    const calls: { id: string; name: string; args: Record<string, unknown> }[] = []

    try {
      for await (const ev of streamChat(config, messages, tools, { timeoutMs: STREAM_TIMEOUT_MS, signal: opts.signal })) {
        if (ev.type === 'text') {
          text += ev.delta
          yield { type: 'text', delta: ev.delta }
        } else if (ev.type === 'tool_call') {
          calls.push({ id: ev.id, name: ev.name, args: (ev.args ?? {}) as Record<string, unknown> })
        }
      }
    } catch (e) {
      // 流失败中断回合；预算已在每次 fetch 前预留，done 计数仅供展示。
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
      for (const e of events) yield e
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
    }
  }

  // 模拟时间与每条 act 的居民事实同批提交；不在回合结束时单独推进时间线。
  yield { type: 'done', llmCalls: reserve.calls, ...(streamError ? { error: streamError } : {}) }
}
