import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { events } from '../../db/schema'
import { configFromEnv, complete } from '../../llm/client'
import type { Env } from '../../index'
import { buildEngineContext, type EngineContext, type WorldSnapshot } from '../../agent/engine-context'
import { buildInjectionPrompt, extractJson, type PromptPair } from '../../agent/engine-prompt'
import { applyBeatOutput, normalizeBeatJson, type BeatJson } from './beat'
import type { AgentStep, DecideOpts, DecideResult, StepExecutor } from './types'

type Event = typeof events.$inferSelect

export interface InjectionInput {
  step: AgentStep
  snapshot: WorldSnapshot
  ctx: EngineContext
  event: Event
  prompt: PromptPair
}

export interface InjectionOutput {
  beat: BeatJson
}

/** 注入事件反应（P2）：人物感知到注入事件，自行决定如何反应（输出格式与 beat 相同） */
export const injectionExecutor: StepExecutor<InjectionInput, InjectionOutput> = {
  async perceive(db: Db, step: AgentStep, snapshot: WorldSnapshot): Promise<InjectionInput | null> {
    if (!step.personId || !step.eventId) return null
    const state = snapshot.states.get(step.personId)
    if (!state || state.currentDialogueId) return null

    const event = await db.select().from(events).where(eq(events.id, step.eventId)).get()
    if (!event || event.kind !== 'injected') return null
    // 水位线：已感知过的不再反应
    if (state.lastBeatSimTime && event.simTime <= state.lastBeatSimTime) return null

    const ctx = await buildEngineContext(db, step.personId, snapshot)
    if (!ctx) return null
    return { step, snapshot, ctx, event, prompt: buildInjectionPrompt(ctx, event.description || event.title) }
  },

  async decide(env: Env, input: InjectionInput, opts?: DecideOpts): Promise<DecideResult<InjectionOutput>> {
    const config = configFromEnv(env)
    const locationNames = input.snapshot.locations.map((l) => l.name)
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
          { maxTokens: 8000 },
        )
        return { value: { beat: normalizeBeatJson(extractJson(raw), locationNames) }, llmCalls }
      } catch {
        // D17：重试一次后跳过该决策点
      }
    }
    return { value: null, llmCalls }
  },

  async act(db: Db, _env: Env, input: InjectionInput, output: InjectionOutput): Promise<string> {
    // 复用 beat 写库；水位线推进到当前 simNow（≥ 事件 simTime，即"已感知"）
    await applyBeatOutput(db, {
      timelineId: input.step.timelineId,
      personId: input.ctx.person.id,
      simNow: input.snapshot.timeline.simNow,
      windowStart: input.event.simTime,
      beat: output.beat,
    })
    return `injection(${input.ctx.person.name}): 反应 ${output.beat.events.length} 事件`
  },
}
