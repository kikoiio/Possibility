import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { events } from '../db/schema'
import { complete, configFromEnv } from '../llm/client'
import type { Env } from '../index'
import type { WorldSnapshot } from '../agent/engine-context'
import { extractJson } from '../agent/engine-prompt'
import { MAX_REACTORS_PER_EVENT } from './director'
import type { AgentStep } from './steps/types'

type Event = typeof events.$inferSelect

/** LLM 导演每拍最多调用次数：它烧的是世界预算，必须硬顶（多事件本拍也只仲裁最"拥挤"的一件） */
export const MAX_DIRECTOR_CALLS_PER_TICK = 1

export interface DirectorCandidateView {
  personId: string
  name: string
  location: string
  activity: string
  mood: string
  profile: string // 身份摘要（已知条目前两则）
}

/** 导演仲裁提示：事件 + 候选人物，让 LLM 按"此刻谁最有戏"排序反应者 */
export function buildDirectorPrompt(
  event: { title: string; description: string },
  candidates: DirectorCandidateView[],
): { system: string; user: string } {
  const list = candidates
    .map(
      (c) =>
        `- ${c.personId}｜${c.name}（@${c.location}，正在：${c.activity}，情绪：${c.mood}）${c.profile ? `身份：${c.profile}` : ''}`,
    )
    .join('\n')
  const system = [
    '你是这个世界的导演，决定"此刻谁对这件事最有戏"。',
    '你只关心戏剧合理性：谁的性格、处境、秘密与这件事碰撞出的张力最大，谁就应该先反应。',
    '与事件无关、不知情或按人设不会在意的人，不要排进 order。',
    '只输出一个 JSON 对象（不要任何其他文字，不要代码块）：',
    `{"order": ["人物id", ...]}`,
    `order 按反应优先级降序，至多 ${MAX_REACTORS_PER_EVENT} 人；只含下面候选人列表里的 id。`,
  ].join('\n')
  const user = [`刚发生的事件：「${event.title}」${event.description}`, '', '候选人物：', list].join('\n')
  return { system, user }
}

/** 解析导演排序：剥非法 id、去重；任何解析问题返回 []（调用方回退机械排序） */
export function parseDirectorOrder(raw: unknown, validIds: string[]): string[] {
  try {
    const order = (raw as { order?: unknown })?.order
    if (!Array.isArray(order)) return []
    const valid = new Set(validIds)
    const seen = new Set<string>()
    const out: string[] = []
    for (const id of order.map(String)) {
      if (!valid.has(id) || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  } catch {
    return []
  }
}

/** 一次导演仲裁（含一次重试）；order 为 null 表示 LLM 侧失败，调用方回退机械排序 */
export async function callDirector(
  env: Env,
  event: { title: string; description: string },
  candidates: DirectorCandidateView[],
): Promise<{ order: string[] | null; llmCalls: number }> {
  const config = configFromEnv(env)
  const { system, user } = buildDirectorPrompt(event, candidates)
  let llmCalls = 0
  for (let attempt = 0; attempt < 2; attempt++) {
    llmCalls++
    try {
      const raw = await complete(config, [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ])
      const order = parseDirectorOrder(extractJson(raw), candidates.map((c) => c.personId))
      if (order.length) return { order, llmCalls }
    } catch {
      // 重试一次
    }
  }
  return { order: null, llmCalls }
}

/**
 * 导演层 v2（LLM 仲裁，借鉴 Inworld）：注入事件的有效反应者多于扇入上限时，
 * 不再机械地取前两个，而是问一次导演"谁最有戏"，把选中者排在队首
 * （机械扇入上限仍在 planTickSteps 兜底）。
 *
 * 触发克制：仅当某事件候选数 > MAX_REACTORS_PER_EVENT 且本拍还有导演预算；
 * 调用失败自动回退 v1 机械排序，绝不阻塞世界推进。
 */
export async function arbitrateInjections(
  env: Env,
  db: Db,
  snapshot: WorldSnapshot,
  steps: AgentStep[],
): Promise<{ steps: AgentStep[]; llmCalls: number }> {
  const injectionSteps = steps.filter((s) => s.kind === 'injection' && s.eventId)
  if (!injectionSteps.length) return { steps, llmCalls: 0 }

  // 按事件分组，只仲裁"最拥挤"的一件（每拍至多一次导演调用）
  const byEvent = new Map<string, AgentStep[]>()
  for (const s of injectionSteps) {
    const list = byEvent.get(s.eventId!) ?? []
    list.push(s)
    byEvent.set(s.eventId!, list)
  }
  const contested = [...byEvent.entries()].filter(([, list]) => list.length > MAX_REACTORS_PER_EVENT)
  if (!contested.length) return { steps, llmCalls: 0 }
  const [eventId, candidates] = contested[0]

  const event = await db.select().from(events).where(eq(events.id, eventId)).get()
  if (!event) return { steps, llmCalls: 0 }

  const views: DirectorCandidateView[] = []
  for (const step of candidates) {
    const person = snapshot.persons.find((p) => p.id === step.personId)
    const state = snapshot.states.get(step.personId!)
    const model = snapshot.models.get(step.personId!)
    if (!person || !state) continue
    views.push({
      personId: person.id,
      name: person.name,
      location: state.location,
      activity: state.activity,
      mood: state.mood,
      profile: (model?.identity ?? [])
        .filter((i) => i.provenance === 'known')
        .slice(0, 2)
        .map((i) => i.text)
        .join('；'),
    })
  }
  if (views.length <= MAX_REACTORS_PER_EVENT) return { steps, llmCalls: 0 }

  const { order, llmCalls } = await callDirector(env, event, views)
  if (!order?.length) return { steps, llmCalls }

  const rank = new Map(order.map((id, i) => [id, i]))
  const reordered = [...candidates].sort((a, b) => (rank.get(a.personId!) ?? 999) - (rank.get(b.personId!) ?? 999))
  const chosen = new Set(order.slice(0, MAX_REACTORS_PER_EVENT))
  const restSteps = steps.filter((s) => s.kind !== 'injection' || s.eventId !== eventId)
  return {
    steps: [...restSteps, ...reordered.filter((s) => chosen.has(s.personId!)), ...reordered.filter((s) => !chosen.has(s.personId!))],
    llmCalls,
  }
}
