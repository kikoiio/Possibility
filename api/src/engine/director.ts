import type { BudgetConfig } from './budget'
import type { AgentStep } from './steps/types'

export interface DirectorPlan {
  /** 本拍按此顺序执行（预算内能跑多少跑多少，跑不完的自动顺延到下一拍） */
  steps: AgentStep[]
  /** 被导演层显式顺延的决策点（下拍会重新收集，不丢失） */
  deferred: { step: AgentStep; reason: string }[]
}

/** 同一注入事件每拍最多反应人数：避免一条新闻烧光整拍预算 */
export const MAX_REACTORS_PER_EVENT = 2

/**
 * 拍级导演（Director 层 v1，机械式、零 LLM——借鉴 Inworld 的 Director 思路但
 * 不引入额外模型调用）：在"这一拍演什么"上做仲裁，而不是简单地有什么跑什么。
 *
 * 规则：
 * 1. 优先级排序（dialogue_turn > injection > beat > schedule > summary，不变）；
 * 2. 注入扇入：同一事件本拍最多 MAX_REACTORS_PER_EVENT 人反应，其余顺延
 *    （水位线机制保证他们下拍仍然 eligible，事件不会丢）；
 * 3. 人物轮转公平：同优先级内按人物轮转交错排序，避免预算在 tickCallCap 处
 *    截断时总落在排在后面的人物身上（饥饿问题）。
 *
 * 纯函数，便于单测。
 */
export function planTickSteps(steps: AgentStep[], _cfg: BudgetConfig): DirectorPlan {
  const sorted = [...steps].sort((a, b) => a.priority - b.priority)
  const plan: DirectorPlan = { steps: [], deferred: [] }

  // 2. 注入扇入
  const reactorsThisTick = new Map<string, number>()
  for (const step of sorted) {
    if (step.kind === 'injection' && step.eventId) {
      const n = reactorsThisTick.get(step.eventId) ?? 0
      if (n >= MAX_REACTORS_PER_EVENT) {
        plan.deferred.push({ step, reason: `事件 ${step.eventId.slice(0, 6)} 本拍反应人数已达上限` })
        continue
      }
      reactorsThisTick.set(step.eventId, n + 1)
    }
    plan.steps.push(step)
  }

  // 3. 同优先级内人物轮转（稳定分组交错）
  const tiers = new Map<number, AgentStep[]>()
  for (const step of plan.steps) {
    const list = tiers.get(step.priority) ?? []
    list.push(step)
    tiers.set(step.priority, list)
  }
  plan.steps = []
  for (const priority of [...tiers.keys()].sort((a, b) => a - b)) {
    plan.steps.push(...roundRobin(tiers.get(priority)!))
  }
  return plan
}

/** 同一优先级层内按人物轮转交错；世界级步骤（personId 为空，如 dialogue_turn）排在层首 */
function roundRobin(tier: AgentStep[]): AgentStep[] {
  const worldLevel = tier.filter((s) => !s.personId)
  const byPerson = new Map<string, AgentStep[]>()
  for (const s of tier) {
    if (!s.personId) continue
    const list = byPerson.get(s.personId) ?? []
    list.push(s)
    byPerson.set(s.personId, list)
  }
  const out = [...worldLevel]
  const persons = [...byPerson.keys()]
  const idx = new Map(persons.map((p) => [p, 0]))
  for (;;) {
    let progressed = false
    for (const p of persons) {
      const i = idx.get(p)!
      const list = byPerson.get(p)!
      if (i < list.length) {
        out.push(list[i])
        idx.set(p, i + 1)
        progressed = true
      }
    }
    if (!progressed) break
  }
  return out
}
