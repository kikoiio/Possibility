import type { Db } from '../../db/client'
import type { Env } from '../../index'
import type { LlmConfig, ReceiptReservation } from '../../llm/client'
import type { WorldSnapshot } from '../../agent/engine-context'
import type { Reservation } from '../guard'

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
  level?: 1 | 2 // summary 专用：目标层级（缺省 1；2 = L2 封顶）
  batchSize?: number // summary 专用：批次大小（tick 按 budget 嵌入，perceive 无 env 入口）
  /** Present only when scheduled by a fenced autonomous engine invocation. */
  engineTickLeaseToken?: string
}

/** decide 的结果：value 为 null 表示失败跳过（D17：重试一次后仍失败） */
export interface DecideResult<T> {
  value: T | null
  llmCalls: number // 展示用：已预留的调用数（含重试）；不得再次记账
}

/** decide 的调用约束：maxCalls 限制本 decide 最多发起的 LLM 调用数（每拍预算的硬顶） */
export interface DecideOpts {
  maxCalls?: number
  reserve?: Reservation
  /** F5/S3:tick 统一经 resolveLlmConfig 解析后下发;decide 不再自读 env 配置。 */
  llm: ResolvedLlmFields
}

/** BYOK 解析结果的可序列化形态(reserve/provider 由调用点各自挂载)。 */
export interface ResolvedLlmFields {
  baseUrl: string
  apiKey: string
  model: string
  source: 'world' | 'user' | 'env'
  apiKeySource: 'personal_global' | 'world_override' | 'platform_fallback'
  apiKeyVerified: boolean
  apiKeyVerificationFingerprint?: string | null
}

/** 解析字段 + 调用点各自的 reserve/provider 组装 LlmConfig(provider 是绑定,不开放用户配置)。 */
export function llmConfigFor(env: Env, fields: ResolvedLlmFields, reserve?: ReceiptReservation): LlmConfig {
  return { baseUrl: fields.baseUrl, apiKey: fields.apiKey, model: fields.model,
    apiKeySource: fields.apiKeySource, apiKeyVerified: fields.apiKeyVerified,
    apiKeyVerificationFingerprint: fields.apiKeyVerificationFingerprint,
    provider: env.LLM_PROVIDER, reserve }
}

/**
 * 决策点执行器（M2）：
 * perceive 查库装上下文（返回 null = 决策点已失效，跳过不记账）；
 * decide 是唯一发生 LLM 调用的环节；
 * act 只写库。
 */
export interface StepExecutor<I, O> {
  perceive(db: Db, step: AgentStep, snapshot: WorldSnapshot): Promise<I | null>
  decide(env: Env, input: I, opts: DecideOpts): Promise<DecideResult<O>>
  act(db: Db, env: Env, input: I, output: O): Promise<string> // 返回本步摘要（给 tick 报告）
}

/** LLM 记账用途（与 llm_call_log.purpose 对齐） */
export type CallPurpose =
  | AgentStepKind
  | 'chat'
  | 'distill'
  | 'voxel_distill'
  | 'world_draft'
  | 'fork_preview'
  | 'fork_simulate'
  | 'chapter'
  | 'director'
  | 'scene'
  | 'connection_test'
