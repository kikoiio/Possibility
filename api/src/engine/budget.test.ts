import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { archiveIdleWorlds, budgetFromEnv, bumpCalls, GLOBAL_CAP_REASON, GLOBAL_DAILY_CAP_DEFAULT, globalBudgetExceeded, isIdleActivity, recoverCappedWorlds, reserveWorldCall, rolloverCalls, tickBudgetOk, type BudgetConfig } from './budget'
import { llmCallLog, timelines, userLlmConfigs, users, worlds } from '../db/schema'
import { createTestDb } from '../test/db'
import { verificationFingerprint } from '../settings/connection-test'

type World = typeof worlds.$inferSelect

// 以真实当天为锚：bumpCalls/dailyCapHit 的"今天"取系统日期，写死日期会让测试跨天后自爆
const TODAY = new Date().toISOString().slice(0, 10)
const YESTERDAY = new Date(Date.parse(TODAY) - 86400_000).toISOString().slice(0, 10)

const CFG: BudgetConfig = {
  worldSpeed: 6,
  tickCallCap: 8,
  dailyCallCap: 400,
  summaryThreshold: 40,
  l1Batch: 30,
  l2Threshold: 10,
  l2Batch: 8,
  preworldDailyCap: 40,
  idleArchiveDays: 7,
  directorLlm: true,
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
    llmConfigJson: null,
    lastUserActivityAt: null,
    timeZone: null,
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
    expect(bumpCalls(TODAY, 0, 2)).toEqual({ callsDay: TODAY, callsToday: 2 })
    expect(bumpCalls(TODAY, 398, 2)).toEqual({ callsDay: TODAY, callsToday: 400 })
  })
  it('换天先清零再累加', () => {
    expect(bumpCalls(YESTERDAY, 400, 1, TODAY)).toEqual({ callsDay: TODAY, callsToday: 1 })
  })
})

describe('全局日预算(F5)', () => {
  const NOW = new Date().toISOString()

  async function seedOwner(cap?: number | null) {
    const fixture = createTestDb()
    await fixture.db.insert(users).values({ id: 'u1', username: 'u1', passwordHash: 'x', createdAt: NOW })
    await fixture.db.insert(worlds).values([
      { id: 'w1', userId: 'u1', name: 'W1', description: '', status: 'running' },
      { id: 'w2', userId: 'u1', name: 'W2', description: '', status: 'running' },
    ])
    await fixture.db.insert(timelines).values({ id: 't1', worldId: 'w1', simNow: NOW, createdAt: NOW })
    if (cap !== undefined) {
      const config = { baseUrl: 'https://personal.example/v1', apiKey: 'personal-key', model: 'model' }
      await fixture.db.insert(userLlmConfigs).values({ userId: 'u1', dailyCallCap: cap, updatedAt: NOW, ...config,
        verificationFingerprint: await verificationFingerprint('u1', config), verifiedAt: NOW })
    }
    return fixture
  }

  let logSeq = 0
  async function logCalls(fixture: ReturnType<typeof createTestDb>, n: number, createdAt: string) {
    await fixture.db.insert(llmCallLog).values(
      Array.from({ length: n }, () => ({ id: `log-${logSeq++}`, userId: 'u1', purpose: 'chat' as const, createdAt })))
  }

  it('缺省 400:无配置行时 399 未触顶、400 触顶', async () => {
    const fixture = await seedOwner()
    await logCalls(fixture, GLOBAL_DAILY_CAP_DEFAULT - 1, NOW)
    expect(await globalBudgetExceeded(fixture.db, 'u1')).toBe(false)
    await logCalls(fixture, 1, NOW)
    expect(await globalBudgetExceeded(fixture.db, 'u1')).toBe(true)
  })

  it('存储值生效;null = 不限', async () => {
    const fixture = await seedOwner(2)
    await logCalls(fixture, 2, NOW)
    expect(await globalBudgetExceeded(fixture.db, 'u1')).toBe(true)
    const unlimited = await seedOwner(null)
    await logCalls(unlimited, 500, NOW)
    expect(await globalBudgetExceeded(unlimited.db, 'u1')).toBe(false)
  })

  it('有限预算保留触顶暂停全部世界的规则', async () => {
    const fixture = await seedOwner(2)
    const meta = { timelineId: 't1', personId: null, purpose: 'chat' as const }
    expect(await reserveWorldCall(fixture.db, 'w1', CFG, meta)).toEqual(expect.any(String))
    expect(await reserveWorldCall(fixture.db, 'w2', CFG, meta)).toEqual(expect.any(String))
    expect(await reserveWorldCall(fixture.db, 'w1', CFG, meta)).toBeNull()
    for (const id of ['w1', 'w2']) {
      expect((await fixture.db.select().from(worlds).where(eq(worlds.id, id)).get()))
        .toMatchObject({ status: 'capped', pauseReason: GLOBAL_CAP_REASON })
    }
  })

  it('不限时已验证个人 Key 豁免;世界 Key、平台 Key 与旧来源共用 fallback 400 桶', async () => {
    const fixture = await seedOwner(null)
    const personal = { timelineId: 't1', personId: null, purpose: 'chat' as const,
      apiKeySource: 'personal_global' as const, verifiedPersonalKey: true,
      verifiedPersonalFingerprint: (await fixture.db.select().from(userLlmConfigs).get())!.verificationFingerprint }
    const worldKey = { ...personal, apiKeySource: 'world_override' as const, verifiedPersonalKey: false }
    const platform = { ...personal, apiKeySource: 'platform_fallback' as const, verifiedPersonalKey: false }
    const personalReceipt = await reserveWorldCall(fixture.db, 'w1', CFG, personal)
    const worldReceipt = await reserveWorldCall(fixture.db, 'w1', CFG, worldKey)
    expect(personalReceipt).toEqual(expect.any(String))
    expect(worldReceipt).toEqual(expect.any(String))
    await logCalls(fixture, 400, NOW)
    expect(await reserveWorldCall(fixture.db, 'w1', CFG, platform)).toBeNull()
    const rows = await fixture.db.select({ apiKeySource: llmCallLog.apiKeySource, budgetBucket: llmCallLog.budgetBucket })
      .from(llmCallLog).all()
    expect(rows.slice(0, 2)).toEqual([
      { apiKeySource: 'personal_global', budgetBucket: 'personal_unlimited' },
      { apiKeySource: 'world_override', budgetBucket: 'fallback_unlimited' },
    ])
  })

  it('回退桶中来源未知的旧账本调用保守计数', async () => {
    const fixture = await seedOwner(null)
    await fixture.db.insert(llmCallLog).values(Array.from({ length: 400 }, (_, i) => ({
      id: `legacy-${i}`, userId: 'u1', purpose: 'chat' as const, createdAt: NOW,
    })))
    const meta = { timelineId: 't1', personId: null, purpose: 'chat' as const,
      apiKeySource: 'platform_fallback' as const }
    expect(await reserveWorldCall(fixture.db, 'w1', CFG, meta)).toBeNull()
  })

  it('预世界不限模式仅个人验证 Key 豁免 fallback 桶,仍受创建类上限约束', async () => {
    const fixture = await seedOwner(null)
    const { reserveUserCall } = await import('./budget')
    const personal = await reserveUserCall(fixture.db, 'u1', CFG, 'world_draft', {
      apiKeySource: 'personal_global', verifiedPersonalKey: true,
      verifiedPersonalFingerprint: (await fixture.db.select().from(userLlmConfigs).get())!.verificationFingerprint,
    })
    expect(personal).toEqual(expect.any(String))
    expect(await reserveUserCall(fixture.db, 'u1', CFG, 'world_draft', {
      apiKeySource: 'platform_fallback', verifiedPersonalKey: false,
    })).toEqual(expect.any(String))
    const rows = await fixture.db.select({ budgetBucket: llmCallLog.budgetBucket }).from(llmCallLog).all()
    expect(rows.map(row => row.budgetBucket)).toEqual(['personal_unlimited', 'fallback_unlimited'])
  })

  it('有限模式的非个人历史调用仍占不限回退桶，触顶不暂停个人世界', async () => {
    const fixture = await seedOwner(null)
    await fixture.db.insert(llmCallLog).values(Array.from({ length: 400 }, (_, i) => ({
      id: `finite-fallback-${i}`, userId: 'u1', purpose: 'chat' as const, createdAt: NOW,
      apiKeySource: 'world_override', budgetBucket: 'finite_global',
    })))
    const details = { apiKeySource: 'personal_global' as const, verifiedPersonalKey: true,
      verifiedPersonalFingerprint: (await fixture.db.select().from(userLlmConfigs).get())!.verificationFingerprint }
    const meta = { timelineId: 't1', personId: null, purpose: 'chat' as const }
    expect(await reserveWorldCall(fixture.db, 'w1', CFG, meta, { apiKeySource: 'platform_fallback' })).toBeNull()
    expect(await reserveWorldCall(fixture.db, 'w1', CFG, meta, details)).toEqual(expect.any(String))
    expect((await fixture.db.select().from(worlds).where(eq(worlds.id, 'w2')).get())?.status).toBe('running')
    // Resolving before a configuration change does not retain its old exemption.
    await fixture.db.update(userLlmConfigs).set({ verificationFingerprint: null, verifiedAt: null })
    expect(await reserveWorldCall(fixture.db, 'w1', CFG, meta, details)).toBeNull()
  })

  it('连接测试只受日预算限制，创建类 40 次额度保持独立规则', async () => {
    const fixture = await seedOwner(100)
    const { reserveUserCall } = await import('./budget')
    await logCalls(fixture, 40, NOW)
    expect(await reserveUserCall(fixture.db, 'u1', CFG, 'world_draft')).toBeNull()
    expect(await reserveUserCall(fixture.db, 'u1', CFG, 'connection_test')).toEqual(expect.any(String))
  })

  it('未传验证指纹不能借个人来源或布尔值绕过回退上限', async () => {
    const fixture = await seedOwner(null)
    await logCalls(fixture, 400, NOW)
    expect(await reserveWorldCall(fixture.db, 'w1', CFG,
      { timelineId: 't1', personId: null, purpose: 'chat', apiKeySource: 'personal_global', verifiedPersonalKey: true })).toBeNull()
  })

  it('并发准入不超卖:cap=1 时两个并发 reserve 只进一个', async () => {
    const fixture = await seedOwner(1)
    const meta = { timelineId: 't1', personId: null, purpose: 'chat' as const }
    const results = await Promise.all([
      reserveWorldCall(fixture.db, 'w1', CFG, meta),
      reserveWorldCall(fixture.db, 'w1', CFG, meta),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await fixture.db.select({ id: llmCallLog.id }).from(llmCallLog).all()).toHaveLength(1)
  })

  it('换天恢复覆盖 global_daily_cap 与存量 daily_cap', async () => {
    const fixture = await seedOwner()
    const yesterday = new Date(Date.parse(`${TODAY}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10)
    await fixture.db.update(worlds).set({ status: 'capped', pauseReason: GLOBAL_CAP_REASON, callsDay: yesterday, callsToday: 5 })
      .where(eq(worlds.id, 'w1'))
    await fixture.db.update(worlds).set({ status: 'capped', pauseReason: 'daily_cap', callsDay: yesterday, callsToday: 5 })
      .where(eq(worlds.id, 'w2'))
    await recoverCappedWorlds(fixture.db, TODAY)
    for (const id of ['w1', 'w2']) {
      expect((await fixture.db.select().from(worlds).where(eq(worlds.id, id)).get()))
        .toMatchObject({ status: 'running', pauseReason: null, callsToday: 0 })
    }
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
  it('S2 分层压缩配置:缺省/覆盖/非法回退/批次截断 ≤30(N6/D8)', () => {
    const cfg = budgetFromEnv({ MEMORY_SUMMARY_L1_BATCH: '12', MEMORY_SUMMARY_L2_THRESHOLD: '4', MEMORY_SUMMARY_L2_BATCH: '3' })
    expect([cfg.l1Batch, cfg.l2Threshold, cfg.l2Batch]).toEqual([12, 4, 3])
    expect(budgetFromEnv({ MEMORY_SUMMARY_L1_BATCH: '0', MEMORY_SUMMARY_L2_THRESHOLD: 'x' })).toMatchObject(
      { l1Batch: 30, l2Threshold: 10 })
    expect(budgetFromEnv({ MEMORY_SUMMARY_L1_BATCH: '99', MEMORY_SUMMARY_L2_BATCH: '99' })).toMatchObject(
      { l1Batch: 30, l2Batch: 30 })
  })
  it('闲置天数与导演开关可配置', () => {
    const cfg = budgetFromEnv({ IDLE_ARCHIVE_DAYS: '3', DIRECTOR_LLM: '0' })
    expect(cfg.idleArchiveDays).toBe(3)
    expect(cfg.directorLlm).toBe(false)
    expect(budgetFromEnv({}).directorLlm).toBe(true)
  })
})

describe('isIdleActivity（闲置判定）', () => {
  const now = Date.parse('2026-09-17T00:00:00Z')
  it('超过 N 天未活动 = 闲置', () => {
    expect(isIdleActivity('2026-09-09T23:59:59Z', now, 7)).toBe(true)
  })
  it('N 天内活动过 = 不闲置', () => {
    expect(isIdleActivity('2026-09-16T12:00:00Z', now, 7)).toBe(false)
  })
  it('null 或无法解析 = 不可判定，不归档', () => {
    expect(isIdleActivity(null, now, 7)).toBe(false)
    expect(isIdleActivity('不是时间', now, 7)).toBe(false)
  })
})

describe('archiveIdleWorlds（闲置自动归档）', () => {
  const NOW = new Date('2026-09-30T00:00:00Z')
  const IDLE = '2026-09-01T00:00:00Z' // 远超缺省 7 天
  const FRESH = '2026-09-29T00:00:00Z'

  it('归档超期闲置世界，豁免演示世界', async () => {
    const { db } = createTestDb()
    await db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'unused', createdAt: FRESH })
    await db.insert(worlds).values([
      { id: 'idle-world', userId: 'u', name: 'Idle', description: '', status: 'running', lastUserActivityAt: IDLE },
      { id: 'fresh-world', userId: 'u', name: 'Fresh', description: '', status: 'running', lastUserActivityAt: FRESH },
      { id: 'demo-world', userId: 'u', name: 'Demo', description: '', status: 'running', isDemo: true, lastUserActivityAt: IDLE },
      { id: 'untouched-world', userId: 'u', name: 'Untouched', description: '', status: 'running' },
    ])
    await archiveIdleWorlds(db, CFG, NOW)
    const rows = await db.select({ id: worlds.id, status: worlds.status }).from(worlds)
    expect(Object.fromEntries(rows.map(r => [r.id, r.status]))).toEqual({
      'idle-world': 'archived',
      'fresh-world': 'running',
      'demo-world': 'running',
      'untouched-world': 'running',
    })
  })
})
