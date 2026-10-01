import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { conversations, events, llmCallLog, messages, persons, personStates, sessions, timelines, universeEvidence, worldPersons, worlds } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { userLlmConfigs } from '../db/schema'
import { budgetFromEnv, reserveUserCall, reserveWorldCall, userCallsToday } from './budget'
import { gateUser } from './guard'

const owner = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
const other = { Authorization: 'Bearer other-token', 'Content-Type': 'application/json' }
const personModel = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] })
const cfg = { worldSpeed: 6, tickCallCap: 8, dailyCallCap: 1, summaryThreshold: 40, l1Batch: 30, l2Threshold: 10, l2Batch: 8, preworldDailyCap: 1, idleArchiveDays: 7, directorLlm: true }

async function seedModelRoutes(f: Awaited<ReturnType<typeof createWorldFixture>>) {
  await f.db.insert(persons).values([
    { id: 'resident', userId: 'owner', name: 'Resident', modelJson: personModel, createdAt: WORLD_TIME },
    { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: personModel, isUser: true, createdAt: WORLD_TIME },
  ])
  await f.db.insert(worldPersons).values(['resident', 'visitor'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
  await f.db.insert(personStates).values([
    { personId: 'resident', timelineId: 'home-main', simTime: '2026-09-19T08:00:00.000Z', location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME },
    { personId: 'visitor', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe', activity: 'Visiting', mood: 'Calm', goal: 'Explore', updatedRealAt: WORLD_TIME },
  ])
  await f.db.insert(conversations).values({ id: 'conversation', userId: 'owner', personId: 'resident', timelineId: 'home-main' })
  await f.db.insert(universeEvidence).values({ timelineId: 'home-main', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME }).onConflictDoNothing()
  f.env.DAILY_CALL_CAP = '1'
  f.env.PREWORLD_DAILY_CAP = '1'
}

function worldEndpointRequests() {
  return [
    () => app.request('/api/worlds/home-world/scene/intent', { method: 'POST', headers: owner,
      body: JSON.stringify({ timelineId: 'home-main', requestId: 'intent-budget', content: '带我去图书馆' }) }, current!.env),
    () => app.request('/api/worlds/home-world/scene', { method: 'POST', headers: owner,
      body: JSON.stringify({ timelineId: 'home-main', location: 'Cafe', content: '你好', requestId: 'scene-budget' }) }, current!.env),
    () => app.request('/api/conversations/conversation/messages', { method: 'POST', headers: owner,
      body: JSON.stringify({ content: '你好', requestId: 'chat-budget' }) }, current!.env),
    () => app.request('/api/conversations/conversation/catchup', { method: 'POST', headers: owner }, current!.env),
    () => app.request('/api/persons/resident/fork/preview', { method: 'POST', headers: owner,
      body: JSON.stringify({ whatIf: '咖啡馆提前开门' }) }, current!.env),
    () => app.request('/api/worlds/home-world/timelines/home-main/fork/preview', { method: 'POST', headers: owner,
      body: JSON.stringify({ whatIf: '咖啡馆提前开门' }) }, current!.env),
    () => app.request('/api/persons/resident/fork', { method: 'POST', headers: owner,
      body: JSON.stringify({ scenario: { whatIf: '咖啡馆提前开门', startTime: WORLD_TIME } }) }, current!.env),
    () => app.request('/api/worlds/home-world/chapters', { method: 'POST', headers: owner,
      body: JSON.stringify({ timelineId: 'home-main' }) }, current!.env),
  ]
}

let current: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { vi.unstubAllGlobals(); current?.close(); current = null })

describe('LLM 路由权限和预算门禁矩阵', () => {
  it('世界级模型入口在调用额度耗尽后全部拒绝，且不会写消息、Fork、章节或再记一次调用', async () => {
    current = await createWorldFixture()
    await seedModelRoutes(current)
    const fetchSpy = vi.fn(async () => new Response('unexpected provider call', { status: 500 }))
    vi.stubGlobal('fetch', fetchSpy)
    // 全局预算(F5):cap=1,一笔预留即触顶
    await current.db.insert(userLlmConfigs).values({ userId: 'owner', dailyCallCap: 1, updatedAt: WORLD_TIME })
    await reserveWorldCall(current.db, 'home-world', cfg, { timelineId: 'home-main', personId: 'resident', purpose: 'chat' })

    const results = []
    for (const request of worldEndpointRequests()) results.push(await request())
    expect(results.map(result => result.status)).toEqual([409, 409, 409, 409, 409, 409, 409, 409])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await current.db.select().from(llmCallLog)).toHaveLength(1)
    expect(await current.db.select().from(messages)).toHaveLength(0)
    expect((await current.db.select().from(worlds).where(eq(worlds.id, 'home-world')).get())?.status).toBe('capped')
  })

  it('paused and archived worlds block every world-level model route before provider or side effects', async () => {
    for (const status of ['paused', 'archived'] as const) {
      current = await createWorldFixture()
      await seedModelRoutes(current)
      await current.db.update(worlds).set({ status }).where(eq(worlds.id, 'home-world'))
      const fetchSpy = vi.fn(async () => new Response('unexpected provider call', { status: 500 }))
      vi.stubGlobal('fetch', fetchSpy)

      const results = []
      for (const request of worldEndpointRequests()) results.push(await request())
      expect(results.map(result => result.status), status).toEqual([409, 409, 409, 409, 409, 409, 409, 409])
      expect(fetchSpy, status).not.toHaveBeenCalled()
      expect(await current.db.select().from(llmCallLog), status).toHaveLength(0)
      expect(await current.db.select().from(messages), status).toHaveLength(0)
      expect(await current.db.select().from(conversations), status).toHaveLength(1)
      current.close()
      current = null
    }
  })

  it('incomplete evidence blocks every human model entry before requests, history, budget, or provider work', async () => {
    current = await createWorldFixture()
    await seedModelRoutes(current)
    await current.db.update(universeEvidence).set({ level: 'incomplete', reasonCodesJson: '["missing_baseline"]' })
      .where(eq(universeEvidence.timelineId, 'home-main'))
    const fetchSpy = vi.fn(async () => new Response('unexpected provider call', { status: 500 }))
    vi.stubGlobal('fetch', fetchSpy)
    const timelineCount = (await current.db.select().from(timelines).all()).length

    const results = []
    for (const request of worldEndpointRequests()) results.push(await request())
    expect(results.map(result => result.status)).toEqual([409, 409, 409, 409, 409, 409, 409, 409])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await current.db.select().from(llmCallLog)).toHaveLength(0)
    expect(await current.db.select().from(messages)).toHaveLength(0)
    expect(await current.db.select().from(timelines)).toHaveLength(timelineCount)
  })

  it('pre-world distill and world-draft routes enforce per-user caps and owner scope before provider calls', async () => {
    current = await createWorldFixture()
    current.env.PREWORLD_DAILY_CAP = '1'
    await current.db.insert(sessions).values({ token: 'other-token', userId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' })
    const fetchSpy = vi.fn(async () => new Response('unexpected provider call', { status: 500 }))
    vi.stubGlobal('fetch', fetchSpy)
    await reserveUserCall(current.db, 'owner', budgetFromEnv({ PREWORLD_DAILY_CAP: '1' }), 'world_draft')
    expect(await userCallsToday(current.db, 'owner')).toBe(1)
    expect(await gateUser(current.db, 'owner', budgetFromEnv(current.env))).toMatchObject({ ok: false, status: 429 })

    const routes = [
      ['/api/persons/distill', { description: 'Ada 是谨慎的档案管理员。' }],
      ['/api/worlds/draft', { prompt: '一个海边小镇' }],
    ] as const
    for (const [path, body] of routes) {
      const ownerResponse = await app.request(path, { method: 'POST', headers: owner, body: JSON.stringify(body) }, current.env)
      expect(ownerResponse.status, `${path}: ${await ownerResponse.clone().text()}`).toBe(429)
      expect((await app.request(path, { method: 'POST', headers: other, body: JSON.stringify(body) }, current.env)).status).toBe(429)
      expect((await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, current.env)).status).toBe(401)
    }
    // Owner's exhausted quota does not consume the other user's quota: the first
    // other-user request reaches the stubbed provider once, then its retry is fenced.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(await current.db.select().from(llmCallLog).where(eq(llmCallLog.userId, 'owner'))).toHaveLength(1)
    expect(await current.db.select().from(llmCallLog).where(eq(llmCallLog.userId, 'other'))).toHaveLength(1)
  })

  it('archived timelines cannot use chat, catch-up, scene, fork preview, or chapter generation', async () => {
    current = await createWorldFixture()
    await seedModelRoutes(current)
    await current.db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-main'))
    await current.db.insert(timelines).values({ id: 'active-line', worldId: 'home-world', parentTimelineId: 'home-main',
      simNow: WORLD_TIME, createdAt: WORLD_TIME })
    await current.db.insert(universeEvidence).values({ timelineId: 'active-line', level: 'complete', assessedVersion: 0,
      baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME })
    await current.db.insert(personStates).values([
      { personId: 'resident', timelineId: 'active-line', simTime: '2026-09-19T08:00:00.000Z', location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME },
      { personId: 'visitor', timelineId: 'active-line', simTime: WORLD_TIME, location: 'Cafe', activity: 'Visiting', mood: 'Calm', goal: 'Explore', updatedRealAt: WORLD_TIME },
    ])
    await current.db.insert(events).values(Array.from({ length: 3 }, (_, index) => ({ id: `archived-event-${index}`,
      timelineId: 'home-main', simTime: WORLD_TIME, title: `Archived event ${index}`, description: 'Only on archived root',
      kind: 'action', actorPersonId: null, dialogueId: null })))
    const fetchSpy = vi.fn(async () => new Response('unexpected provider call', { status: 500 }))
    vi.stubGlobal('fetch', fetchSpy)

    const requests = [
      app.request('/api/conversations/conversation/messages', { method: 'POST', headers: owner,
        body: JSON.stringify({ content: 'hello', requestId: 'archived-chat' }) }, current.env),
      app.request('/api/conversations/conversation/catchup', { method: 'POST', headers: owner }, current.env),
      app.request('/api/worlds/home-world/scene', { method: 'POST', headers: owner,
        body: JSON.stringify({ timelineId: 'home-main', content: 'hello' }) }, current.env),
      app.request('/api/persons/resident/fork/preview', { method: 'POST', headers: owner,
        body: JSON.stringify({ whatIf: '咖啡馆提前开门' }) }, current.env),
      app.request('/api/worlds/home-world/timelines/home-main/fork/preview', { method: 'POST', headers: owner,
        body: JSON.stringify({ whatIf: '咖啡馆提前开门' }) }, current.env),
      app.request('/api/worlds/home-world/chapters', { method: 'POST', headers: owner,
        body: JSON.stringify({ timelineId: 'home-main' }) }, current.env),
      app.request('/api/worlds/home-world/chapters', { method: 'POST', headers: owner, body: JSON.stringify({}) }, current.env),
    ]
    const results = await Promise.all(requests)
    expect(results.map(response => response.status)).toEqual([404, 404, 404, 404, 404, 404, 400])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await current.db.select().from(llmCallLog)).toHaveLength(0)
    expect(await current.db.select().from(messages)).toHaveLength(0)
  })
})
