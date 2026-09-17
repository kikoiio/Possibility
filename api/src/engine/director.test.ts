import { describe, expect, it } from 'vitest'
import { MAX_REACTORS_PER_EVENT, planTickSteps } from './director'
import type { BudgetConfig } from './budget'
import type { AgentStep } from './steps/types'

const CFG: BudgetConfig = {
  worldSpeed: 6,
  tickCallCap: 8,
  dailyCallCap: 400,
  summaryThreshold: 40,
  preworldDailyCap: 40,
}

let seq = 0
function step(kind: AgentStep['kind'], priority: number, personId: string | null, extra: Partial<AgentStep> = {}): AgentStep {
  return { kind, worldId: 'w1', timelineId: 't1', personId, priority, ...extra }
}

describe('planTickSteps（导演层仲裁）', () => {
  it('优先级全局有序：dialogue_turn 最先，summary 最后', () => {
    const steps = [
      step('summary', 5, 'a'),
      step('beat', 3, 'b'),
      step('dialogue_turn', 1, null, { dialogueId: 'd1' }),
      step('schedule', 4, 'c'),
      step('injection', 2, 'd', { eventId: 'e1' }),
    ]
    const plan = planTickSteps(steps, CFG)
    expect(plan.steps.map((s) => s.kind)).toEqual(['dialogue_turn', 'injection', 'beat', 'schedule', 'summary'])
    expect(plan.deferred).toHaveLength(0)
  })

  it('注入扇入：同一事件每拍最多 2 人反应，其余顺延且不丢失（下拍重新收集）', () => {
    const steps = [
      step('injection', 2, 'a', { eventId: 'ev' }),
      step('injection', 2, 'b', { eventId: 'ev' }),
      step('injection', 2, 'c', { eventId: 'ev' }),
      step('injection', 2, 'd', { eventId: 'ev' }),
    ]
    const plan = planTickSteps(steps, CFG)
    expect(plan.steps.filter((s) => s.kind === 'injection')).toHaveLength(MAX_REACTORS_PER_EVENT)
    expect(plan.deferred).toHaveLength(2)
    expect(plan.deferred.every((d) => d.step.eventId === 'ev')).toBe(true)
  })

  it('不同事件互不挤占', () => {
    const steps = [
      step('injection', 2, 'a', { eventId: 'e1' }),
      step('injection', 2, 'b', { eventId: 'e2' }),
      step('injection', 2, 'c', { eventId: 'e1' }),
    ]
    const plan = planTickSteps(steps, CFG)
    expect(plan.steps).toHaveLength(3)
    expect(plan.deferred).toHaveLength(0)
  })

  it('人物轮转公平：同优先级内人物交错，预算截断不会总落在同一个人之后', () => {
    // 两个人各自有三个 beat（极端构造），轮转后顺序应为 a1 b1 a2 b2 a3 b3
    const steps = [
      step('beat', 3, 'a'),
      step('beat', 3, 'a'),
      step('beat', 3, 'a'),
      step('beat', 3, 'b'),
      step('beat', 3, 'b'),
      step('beat', 3, 'b'),
    ]
    seq = 0
    const plan = planTickSteps(steps, CFG)
    expect(plan.steps.map((s) => s.personId)).toEqual(['a', 'b', 'a', 'b', 'a', 'b'])
  })

  it('世界级步骤（personId 为空）排在同层最前', () => {
    const steps = [step('beat', 3, 'a'), step('dialogue_turn', 1, null, { dialogueId: 'd' }), step('dialogue_turn', 1, null, { dialogueId: 'd2' })]
    const plan = planTickSteps(steps, CFG)
    expect(plan.steps[0].kind).toBe('dialogue_turn')
    expect(plan.steps[0].dialogueId).toBe('d')
  })

  it('空输入安全', () => {
    expect(planTickSteps([], CFG).steps).toHaveLength(0)
  })
})
