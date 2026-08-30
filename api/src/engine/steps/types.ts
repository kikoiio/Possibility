import type { Db } from '../../db/client'
import type { Env } from '../../index'
import type { WorldSnapshot } from '../../agent/engine-context'

/** 决策点种类（D16：统一接口，留 LangGraph 迁移空间） */
export type AgentStepKind = 'schedule' | 'beat' | 'dialogue_turn' | 'injection' | 'summary'

export interface AgentStep {
  kind: AgentStepKind
  worldId: string
  timelineId: string
  personId: string | null // null = 世界级步骤（当前未用，保留）
  priority: number // 小的先执行（P1 对话=1，P2 注入=2，P3 节拍=3，P4 日程=4，P5 摘要=5）
  dialogueId?: string // dialogue_turn 专用
  eventId?: string // injection 专用
}

/** decide 的结果：value 为 null 表示失败跳过（D17：重试一次后仍失败） */
export interface DecideResult<T> {
  value: T | null
  llmCalls: number // 本 decide 实际发生的 LLM 调用数（含重试），tick 按此记账
}

/** decide 的调用约束：maxCalls 限制本 decide 最多发起的 LLM 调用数（每拍预算的硬顶） */
export interface DecideOpts {
  maxCalls?: number
}

/**
 * 决策点执行器（M2）：
 * perceive 查库装上下文（返回 null = 决策点已失效，跳过不记账）；
 * decide 是唯一发生 LLM 调用的环节；
 * act 只写库。
 */
export interface StepExecutor<I, O> {
  perceive(db: Db, step: AgentStep, snapshot: WorldSnapshot): Promise<I | null>
  decide(env: Env, input: I, opts?: DecideOpts): Promise<DecideResult<O>>
  act(db: Db, env: Env, input: I, output: O): Promise<string> // 返回本步摘要（给 tick 报告）
}

/** LLM 记账用途（与 llm_call_log.purpose 对齐） */
export type CallPurpose = AgentStepKind | 'chat' | 'distill'
