import type { Db } from '../../db/client'
import { schedules } from '../../db/schema'
import { configFromEnv, complete } from '../../llm/client'
import type { Env } from '../../index'
import { buildEngineContext, type EngineContext, type ScheduleItem, type WorldSnapshot } from '../../agent/engine-context'
import { buildSchedulePrompt, extractJson, type PromptPair } from '../../agent/engine-prompt'
import type { AgentStep, DecideOpts, DecideResult, StepExecutor } from './types'

export interface ScheduleInput {
  step: AgentStep
  snapshot: WorldSnapshot
  ctx: EngineContext
  prompt: PromptPair
}

export interface ScheduleOutput {
  items: ScheduleItem[]
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** 校验并规范化日程：6-10 项、HH:MM 合法、时间升序不重叠；非法地点替换为首个地点 */
export function normalizeScheduleItems(raw: unknown, locationNames: string[], fallbackLocation: string): ScheduleItem[] {
  if (!raw || typeof raw !== 'object') throw new Error('日程不是对象')
  const items = (raw as { items?: unknown }).items
  if (!Array.isArray(items)) throw new Error('缺少 items 数组')
  if (items.length < 6 || items.length > 10) throw new Error(`日程项数 ${items.length} 不在 6-10`)

  const out: ScheduleItem[] = []
  for (const it of items) {
    const o = (it ?? {}) as Record<string, unknown>
    const start = String(o.start ?? '')
    const end = String(o.end ?? '')
    if (!HHMM.test(start) || !HHMM.test(end)) throw new Error(`时间格式非法：${start}-${end}`)
    const activity = String(o.activity ?? '').trim()
    if (!activity) throw new Error('activity 为空')
    let location = String(o.location ?? '').trim()
    if (!locationNames.includes(location)) location = fallbackLocation
    const kind = o.kind === 'sleep' ? 'sleep' : undefined
    out.push({ start, end, location, activity, ...(kind ? { kind } : {}) })
  }

  // 时间升序不重叠：end <= start 视为跨夜（+24h）；start 小于前一项 start 视为次日（整体 +24h）
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  let prevEnd = -1
  let prevStartRaw = -1
  let dayOffset = 0
  for (const it of out) {
    const rawStart = toMin(it.start)
    if (rawStart < prevStartRaw) dayOffset += 24 * 60
    prevStartRaw = rawStart
    const s = rawStart + dayOffset
    let e = toMin(it.end)
    if (e <= rawStart) e += 24 * 60
    e += dayOffset
    if (s < prevEnd) throw new Error(`日程时间重叠：${it.start} < 上一项结束`)
    prevEnd = e
  }
  return out
}

/** 日程生成（P4）：当前世界日无日程的人物 → LLM 生成一份 */
export const scheduleExecutor: StepExecutor<ScheduleInput, ScheduleOutput> = {
  async perceive(db: Db, step: AgentStep, snapshot: WorldSnapshot): Promise<ScheduleInput | null> {
    if (!step.personId) return null
    if (snapshot.schedules.has(step.personId)) return null // 今日已有日程
    const ctx = await buildEngineContext(db, step.personId, snapshot)
    if (!ctx) return null
    return { step, snapshot, ctx, prompt: buildSchedulePrompt(ctx) }
  },

  async decide(env: Env, input: ScheduleInput, opts?: DecideOpts): Promise<DecideResult<ScheduleOutput>> {
    const config = configFromEnv(env)
    const locationNames = input.snapshot.locations.map((l) => l.name)
    const fallback = locationNames[0] ?? '大厅'
    let llmCalls = 0
    const maxAttempts = Math.max(1, Math.min(2, opts?.maxCalls ?? 2))
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      llmCalls++
      try {
        // 推理模型 reasoning 烧预算，给足（D13 + 实测：记忆变多后 8000 会被 reasoning 烧光返回空）
        const raw = await complete(
          config,
          [
            { role: 'system', content: input.prompt.system },
            { role: 'user', content: input.prompt.user },
          ],
          { maxTokens: 16000 },
        )
        const items = normalizeScheduleItems(extractJson(raw), locationNames, fallback)
        return { value: { items }, llmCalls }
      } catch (e) {
        // D17：失败重试一次，再失败则跳过该决策点；日志便于提示词调优
        console.log(`[schedule] ${input.ctx.person.name} 第 ${attempt + 1} 次失败：${e instanceof Error ? e.message : e}`)
      }
    }
    return { value: null, llmCalls }
  },

  async act(db: Db, _env: Env, input: ScheduleInput, output: ScheduleOutput): Promise<string> {
    const now = input.snapshot.timeline.simNow
    await db
      .insert(schedules)
      .values({
        personId: input.step.personId!,
        timelineId: input.step.timelineId,
        worldDate: input.snapshot.worldDate,
        itemsJson: JSON.stringify(output.items),
        generatedAt: now,
      })
      .onConflictDoNothing()
    return `schedule(${input.ctx.person.name}): ${output.items.length} 项`
  },
}
