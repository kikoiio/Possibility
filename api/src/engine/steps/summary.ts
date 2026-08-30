import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { memories } from '../../db/schema'
import { configFromEnv, complete } from '../../llm/client'
import type { Env } from '../../index'
import { buildEngineContext, type EngineContext, type WorldSnapshot } from '../../agent/engine-context'
import { buildSummaryPrompt, extractJson, type PromptPair } from '../../agent/engine-prompt'
import { clampImportance, oldestUnsummarized, SUMMARY_BATCH, type Memory } from '../../agent/memory'
import type { AgentStep, DecideOpts, DecideResult, StepExecutor } from './types'

export interface SummaryInput {
  step: AgentStep
  snapshot: WorldSnapshot
  ctx: EngineContext
  batch: Memory[]
  prompt: PromptPair
}

export interface SummaryOutput {
  content: string
  importance: number
}

export function normalizeSummaryJson(raw: unknown): SummaryOutput {
  const r = (raw ?? {}) as Record<string, unknown>
  const content = String(r.content ?? '').trim()
  if (!content) throw new Error('content 为空')
  return { content, importance: clampImportance(r.importance) }
}

/** 记忆压缩（P5）：把最老一批未压缩记忆蒸馏为一条 summary，原文标记保留可回溯 */
export const summaryExecutor: StepExecutor<SummaryInput, SummaryOutput> = {
  async perceive(db: Db, step: AgentStep, snapshot: WorldSnapshot): Promise<SummaryInput | null> {
    if (!step.personId) return null
    const batch = await oldestUnsummarized(db, step.personId, snapshot.timeline, SUMMARY_BATCH)
    if (!batch.length) return null
    const ctx = await buildEngineContext(db, step.personId, snapshot)
    if (!ctx) return null
    return { step, snapshot, ctx, batch, prompt: buildSummaryPrompt(ctx, batch) }
  },

  async decide(env: Env, input: SummaryInput, opts?: DecideOpts): Promise<DecideResult<SummaryOutput>> {
    const config = configFromEnv(env)
    let llmCalls = 0
    const maxAttempts = Math.max(1, Math.min(2, opts?.maxCalls ?? 2))
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      llmCalls++
      try {
        const raw = await complete(
          config,
          [
            { role: 'system', content: input.prompt.system },
            { role: 'user', content: input.prompt.user },
          ],
          { maxTokens: 12000 },
        )
        return { value: normalizeSummaryJson(extractJson(raw)), llmCalls }
      } catch {
        // D17：重试一次后跳过
      }
    }
    return { value: null, llmCalls }
  },

  async act(db: Db, _env: Env, input: SummaryInput, output: SummaryOutput): Promise<string> {
    // 摘要的 createdAt 取批次内最新原文的写入时间（而非当前时刻）：
    // 使摘要与被压缩原文的可见性水位一致——分叉线要么同时看到原文与摘要，要么都看不到。
    const latest = input.batch[input.batch.length - 1]
    await db.insert(memories).values({
      id: crypto.randomUUID(),
      personId: input.step.personId!,
      timelineId: input.step.timelineId,
      type: 'summary',
      content: output.content,
      simTime: latest.simTime,
      createdAt: latest.createdAt,
      importance: output.importance,
    })
    await db
      .update(memories)
      .set({ summarized: true })
      .where(
        and(
          eq(memories.personId, input.step.personId!),
          inArray(
            memories.id,
            input.batch.map((m) => m.id),
          ),
        ),
      )
    return `summary(${input.ctx.person.name}): 压缩 ${input.batch.length} 条`
  },
}
