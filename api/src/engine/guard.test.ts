import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { llmCallLog, timelines, universeEvidence, users, worlds } from '../db/schema'
import { createTestDb } from '../test/db'
import { gateUniverseWrite, gateUser, gateWorld, userReservation, worldReservation, type TickBudget } from './guard'
import { recoverCappedWorlds } from './budget'
import type { BudgetConfig } from './budget'

const NOW = new Date().toISOString()
const TODAY = NOW.slice(0, 10)
const YESTERDAY = new Date(Date.parse(`${TODAY}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10)
const CFG: BudgetConfig = {
  worldSpeed: 6, tickCallCap: 8, dailyCallCap: 2, summaryThreshold: 40, l1Batch: 30, l2Threshold: 10, l2Batch: 8,
  preworldDailyCap: 3, idleArchiveDays: 7, directorLlm: true,
}

let fixture: ReturnType<typeof createTestDb> | undefined
afterEach(() => { fixture?.close(); fixture = undefined })

async function setup() {
  fixture = createTestDb()
  await fixture.db.insert(users).values({ id: 'owner', username: 'owner', passwordHash: 'x', createdAt: NOW })
  await fixture.db.insert(worlds).values({ id: 'world', userId: 'owner', name: 'World', description: '', status: 'running' })
  await fixture.db.insert(timelines).values({ id: 'main', worldId: 'world', simNow: NOW, createdAt: NOW })
  await fixture.db.insert(universeEvidence).values({ timelineId: 'main', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: NOW })
  return fixture
}

describe('预算与模型调用出口门禁', () => {
  it('拒绝所有非 complete 证据状态，且发生在预算预留之前', async () => {
    const f = await setup()
    for (const level of ['unassessed', 'upgradeable', 'incomplete']) {
      await f.db.update(universeEvidence).set({ level }).where(eq(universeEvidence.timelineId, 'main'))
      expect(await gateUniverseWrite(f.db, 'world', 'main')).toMatchObject({ ok: false, status: 409 })
      const reserve = worldReservation(f.db, 'world', CFG, { timelineId: 'main', personId: null, purpose: 'scene' })
      await expect(reserve()).rejects.toMatchObject({ status: 409 })
      expect(await f.db.select().from(llmCallLog)).toEqual([])
      expect((await f.db.select().from(worlds).where(eq(worlds.id, 'world')).get())?.callsToday).toBe(0)
    }
  })

  it('世界不存在、暂停、归档和触顶时分别拒绝；跨日可恢复', async () => {
    const f = await setup()
    expect(await gateWorld(f.db, 'missing', CFG)).toMatchObject({ ok: false, status: 404 })

    await f.db.update(worlds).set({ status: 'paused' }).where(eq(worlds.id, 'world'))
    expect(await gateWorld(f.db, 'world', CFG)).toMatchObject({ ok: false, status: 409 })
    await f.db.update(worlds).set({ status: 'archived' }).where(eq(worlds.id, 'world'))
    expect(await gateWorld(f.db, 'world', CFG)).toMatchObject({ ok: false, status: 409 })

    await f.db.update(worlds).set({ status: 'running', callsDay: TODAY, callsToday: CFG.dailyCallCap }).where(eq(worlds.id, 'world'))
    expect(await gateWorld(f.db, 'world', CFG)).toMatchObject({ ok: false, status: 429 })
    expect((await f.db.select().from(worlds).where(eq(worlds.id, 'world')).get())?.status).toBe('capped')

    await f.db.update(worlds).set({ status: 'capped', pauseReason: 'daily_cap', callsDay: YESTERDAY, callsToday: CFG.dailyCallCap }).where(eq(worlds.id, 'world'))
    await recoverCappedWorlds(f.db, TODAY)
    expect((await gateWorld(f.db, 'world', CFG)).ok).toBe(true)
  })

  it('世界每日预留原子封顶；失败不记账，也不会进入 provider', async () => {
    const f = await setup()
    const reserve = worldReservation(f.db, 'world', CFG, { timelineId: 'main', personId: null, purpose: 'scene' })
    await reserve()
    await reserve()
    await expect(reserve()).rejects.toMatchObject({ status: 409 })
    expect(reserve.calls).toBe(2)
    expect(await f.db.select().from(llmCallLog)).toHaveLength(2)
    expect((await f.db.select().from(worlds).where(eq(worlds.id, 'world')).get())).toMatchObject({ status: 'capped', callsToday: 2, callsDay: TODAY })
    expect(await gateWorld(f.db, 'world', CFG)).toMatchObject({ ok: false, status: 409 })
  })

  it('returns an auditable receipt id and settles it exactly once without storing prompt text', async () => {
    const f = await setup()
    const reserve = worldReservation(f.db, 'world', CFG, {
      timelineId: 'main', personId: null, purpose: 'scene', requestId: 'route-request',
    })
    const receiptId = await reserve({ contextHash: 'a'.repeat(64), contractVersion: 'scene/v1' })
    expect(receiptId).toEqual(expect.any(String))
    expect(await f.db.select().from(llmCallLog).where(eq(llmCallLog.id, receiptId)).get()).toMatchObject({
      id: receiptId, requestId: 'route-request', contextHash: 'a'.repeat(64), contractVersion: 'scene/v1',
      status: 'reserved', errorCode: null, completedAt: null,
    })
    await reserve.settle(receiptId, 'completed')
    expect(await f.db.select().from(llmCallLog).where(eq(llmCallLog.id, receiptId)).get()).toMatchObject({
      status: 'completed', errorCode: null, completedAt: expect.any(String),
    })
    await expect(reserve.settle(receiptId, 'failed', 'late_failure')).rejects.toThrow('already terminal')
    expect(JSON.stringify(await f.db.select().from(llmCallLog).all())).not.toContain('private prompt')
  })

  it('拍内额度拒绝并发超额；失败的 SQL admission 释放拍内名额', async () => {
    const f = await setup()
    const tick: TickBudget = { used: 0, limit: 1 }
    const reserve = worldReservation(f.db, 'missing', CFG, { timelineId: 'main', personId: null, purpose: 'scene' }, tick)
    await expect(reserve()).rejects.toMatchObject({ status: 404 })
    expect(tick.used).toBe(0)

    const liveTick: TickBudget = { used: 0, limit: 1 }
    const live = worldReservation(f.db, 'world', CFG, { timelineId: 'main', personId: null, purpose: 'scene' }, liveTick)
    const results = await Promise.allSettled([live(), live()])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(liveTick.used).toBe(1)
    expect(live.calls).toBe(1)
  })

  it('预世界调用按用户每日原子封顶，且其他用户的额度相互隔离', async () => {
    const f = await setup()
    await f.db.insert(users).values({ id: 'other', username: 'other', passwordHash: 'x', createdAt: NOW })
    const reserve = userReservation(f.db, 'owner', CFG, 'world_draft')
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => reserve()))
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(CFG.preworldDailyCap)
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(8 - CFG.preworldDailyCap)
    expect(await f.db.select().from(llmCallLog).where(eq(llmCallLog.userId, 'owner'))).toHaveLength(CFG.preworldDailyCap)
    expect(await gateUser(f.db, 'owner', CFG)).toMatchObject({ ok: false, status: 429 })
    expect(await gateUser(f.db, 'other', CFG)).toEqual({ ok: true })
  })
})
