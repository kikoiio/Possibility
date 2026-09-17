import { describe, expect, it } from 'vitest'
import { budgetFromEnv, bumpCalls, dailyCapHit, rolloverCalls, tickBudgetOk, type BudgetConfig } from './budget'
import type { worlds } from '../db/schema'

type World = typeof worlds.$inferSelect

const CFG: BudgetConfig = {
  worldSpeed: 6,
  tickCallCap: 8,
  dailyCallCap: 400,
  summaryThreshold: 40,
  preworldDailyCap: 40,
}

function world(patch: Partial<World>): World {
  return {
    id: 'w1',
    userId: 'u1',
    name: '测试世界',
    description: '',
    locationsJson: '[]',
    status: 'running',
    pauseReason: null,
    isDemo: false,
    callsToday: 0,
    callsDay: null,
    createdAt: '',
    ...patch,
  }
}

describe('rolloverCalls（换天滚动）', () => {
  it('同一天不累加、不清零', () => {
    expect(rolloverCalls('2026-09-17', 42, '2026-09-17')).toEqual({ callsDay: '2026-09-17', callsToday: 42 })
  })
  it('换天清零', () => {
    expect(rolloverCalls('2026-09-16', 400, '2026-09-17')).toEqual({ callsDay: '2026-09-17', callsToday: 0 })
  })
  it('callsDay 为空视为新的一天', () => {
    expect(rolloverCalls(null, 999, '2026-09-17')).toEqual({ callsDay: '2026-09-17', callsToday: 0 })
  })
})

describe('bumpCalls（记账核心：滚动 + 累加）', () => {
  it('同一天正常累加（回归：曾漏加 n 导致计数永远停在 0）', () => {
    expect(bumpCalls('2026-09-17', 0, 2)).toEqual({ callsDay: '2026-09-17', callsToday: 2 })
    expect(bumpCalls('2026-09-17', 398, 2)).toEqual({ callsDay: '2026-09-17', callsToday: 400 })
  })
  it('换天先清零再累加', () => {
    expect(bumpCalls('2026-09-16', 400, 1, '2026-09-17')).toEqual({ callsDay: '2026-09-17', callsToday: 1 })
  })
})

describe('dailyCapHit（每日上限）', () => {
  it('达到上限即触顶', () => {
    expect(dailyCapHit(world({ callsDay: '2026-09-17', callsToday: 400 }), CFG)).toBe(true)
  })
  it('未达上限不触顶', () => {
    expect(dailyCapHit(world({ callsDay: '2026-09-17', callsToday: 399 }), CFG)).toBe(false)
  })
  it('换天后（callsDay 滞后）视为未触顶——配合 recoverCappedWorlds 自动恢复', () => {
    // 这是 bug#4 的核心场景：昨天触顶的世界今天必须能被 tick 重新拾起
    expect(dailyCapHit(world({ callsDay: '2026-09-16', callsToday: 400 }), CFG)).toBe(false)
  })
})

describe('tickBudgetOk（每拍上限）', () => {
  it('拍内调用数小于上限才可继续', () => {
    expect(tickBudgetOk(7, CFG)).toBe(true)
    expect(tickBudgetOk(8, CFG)).toBe(false)
  })
})

describe('budgetFromEnv（环境变量解析）', () => {
  it('缺省值', () => {
    expect(budgetFromEnv({})).toEqual(CFG)
  })
  it('非法值回退缺省', () => {
    expect(budgetFromEnv({ DAILY_CALL_CAP: 'abc', TICK_CALL_CAP: '-3' }).dailyCallCap).toBe(400)
    expect(budgetFromEnv({ DAILY_CALL_CAP: 'abc', TICK_CALL_CAP: '-3' }).tickCallCap).toBe(8)
  })
  it('可覆盖（含新的预世界上限）', () => {
    const cfg = budgetFromEnv({ DAILY_CALL_CAP: '100', PREWORLD_DAILY_CAP: '5' })
    expect(cfg.dailyCallCap).toBe(100)
    expect(cfg.preworldDailyCap).toBe(5)
  })
})
