import type { Db } from '../../db/client'
import { configFromEnv, completeContract } from '../../llm/client'
import { contractViolation, LLM_CONTRACT_VERSIONS, parseContractObject, requireString } from '../../llm/contracts'
import type { Env } from '../../index'
import { buildEngineContext, type EngineContext, type WorldSnapshot } from '../../agent/engine-context'
import { buildSummaryPrompt, type PromptPair } from '../../agent/engine-prompt'
import { aggregateImportance, oldestCompressible, type Memory } from '../../agent/memory'
import type { AgentStep, DecideOpts, DecideResult, StepExecutor } from './types'
import { mergeMemoryAnnotations } from './annotations'
import { recordMemorySummary } from '../../world-state/system'

export interface SummaryInput {
  step: AgentStep
  snapshot: WorldSnapshot
  ctx: EngineContext
  batch: Memory[]
  prompt: PromptPair
}

/** S2 契约 v2：LLM 只产正文；重要性与标注由 act 侧纯函数确定性产出（F4/F5） */
export interface SummaryOutput {
  content: string
}

export function normalizeSummaryJson(raw: unknown): SummaryOutput {
  const version = LLM_CONTRACT_VERSIONS.summary
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return contractViolation(version, '输出必须是对象')
  const r = raw as Record<string, unknown>
  return { content: requireString(r.content, 'content', version, 6000) }
}

/**
 * 记忆压缩（P5 + S2 分层）：把目标层级的最老一批源蒸馏为一条摘要，原文/源摘要标记保留可回溯。
 * step.level = 目标层（1=由原文压 L1，2=由未上卷 L1 压 L2，封顶），缺省 1；
 * step.batchSize 由 tick 调度按 budget 嵌入（perceive 无 env 入口）。
 */
export const summaryExecutor: StepExecutor<SummaryInput, SummaryOutput> = {
  async perceive(db: Db, step: AgentStep, snapshot: WorldSnapshot): Promise<SummaryInput | null> {
    if (!step.personId) return null
    const level = step.level ?? 1
    const batch = await oldestCompressible(db, step.personId, snapshot.timeline, level - 1 as 0 | 1, step.batchSize ?? 30)
    if (!batch.length) return null
    const ctx = await buildEngineContext(db, step.personId, snapshot)
    if (!ctx) return null
    return { step, snapshot, ctx, batch, prompt: buildSummaryPrompt(ctx, batch) }
  },

  async decide(env: Env, input: SummaryInput, opts?: DecideOpts): Promise<DecideResult<SummaryOutput>> {
    const config = configFromEnv(env, opts?.reserve)
    let llmCalls = 0
    const maxAttempts = Math.max(0, Math.min(2, opts?.maxCalls ?? 2))
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      llmCalls++
      try {
        const output = await completeContract(
          config,
          [
            { role: 'system', content: input.prompt.system },
            { role: 'user', content: input.prompt.user },
          ],
          { maxTokens: 12000, contractVersion: LLM_CONTRACT_VERSIONS.summary,
            parse: raw => normalizeSummaryJson(parseContractObject(raw, LLM_CONTRACT_VERSIONS.summary)) },
        )
        return { value: output, llmCalls: opts?.reserve?.calls ?? llmCalls }
      } catch {
        // D17：重试一次后跳过
      }
    }
    return { value: null, llmCalls: opts?.reserve?.calls ?? llmCalls }
  },

  async act(db: Db, env: Env, input: SummaryInput, output: SummaryOutput): Promise<string> {
    // 摘要的 createdAt 取批次内最新源的写入时间（而非当前时刻）：
    // 使摘要与被压缩源的可见性水位一致——分叉线要么同时看到源与摘要，要么都看不到（对 L2 递归适用）。
    const level = input.step.level ?? 1
    const latest = input.batch[input.batch.length - 1]
    const annotations = mergeMemoryAnnotations(input.batch)
    await recordMemorySummary(db, { worldId: input.step.worldId, timelineId: input.step.timelineId,
      personId: input.step.personId!, sourceMemoryIds: input.batch.map(memory => memory.id),
      content: output.content, importance: aggregateImportance(input.batch),
      simTime: latest.simTime ?? latest.createdAt, createdAt: latest.createdAt,
      level, mentions: annotations.mentions, location: annotations.location, topics: annotations.topics,
      engineTickLeaseToken: env.ENGINE_TICK_LEASE_TOKEN })
    return `summary(${input.ctx.person.name}): L${level} 压缩 ${input.batch.length} 条`
  },
}
