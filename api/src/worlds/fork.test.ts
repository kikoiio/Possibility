import { afterEach, describe, expect, it, vi } from 'vitest'
import { count, eq } from 'drizzle-orm'
import app from '../index'
import { conversations, llmCallLog, persons, personStates, timelines, universeEvidence, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'

const owner = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
const other = { Authorization: 'Bearer other-token', 'Content-Type': 'application/json' }

const scenarioJson = {
  whatIf: '如果那封信在暴雨前送达',
  startTime: '2020-01-01T00:00:00.000Z', // LLM 可能起草过去时刻，端点必须强制对齐
  changedVariable: '信件是否送达',
  participants: ['Resident'],
  invariants: ['分叉前的共同历史不变', '世界地理不变'],
}

function stubLlm(content: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
  }), { status: 200 })))
}

async function seedResident(f: Awaited<ReturnType<typeof createWorldFixture>>) {
  await f.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await f.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })
}

afterEach(() => vi.unstubAllGlobals())

describe('世界级 fork 五字段扩展（S2/F4）', () => {
  const fork = (env: Awaited<ReturnType<typeof createWorldFixture>>['env'], body: unknown) =>
    app.request('/api/worlds/home-world/timelines/home-main/fork', {
      method: 'POST', headers: owner, body: JSON.stringify(body),
    }, env)

  it('五字段确认后新线 forkScenarioJson 完整保存', async () => {
    const f = await createWorldFixture()
    const res = await fork(f.env, {
      requestId: 'req-five', scenario: {
        whatIf: '如果信送到了', changedVariable: '信件是否送达',
        participants: ['Resident', 'Visitor'], invariants: ['共同历史不变', '地理不变'],
      },
    }, )
    expect(res.status).toBe(200)
    const { id } = await res.json() as { id: string }
    const row = await f.db.select().from(timelines).where(eq(timelines.id, id)).get()
    const stored = JSON.parse(row!.forkScenarioJson!) as Record<string, unknown>
    expect(stored.whatIf).toBe('如果信送到了')
    expect(stored.changedVariable).toBe('信件是否送达')
    expect(stored.participants).toEqual(['Resident', 'Visitor'])
    expect(stored.invariants).toEqual(['共同历史不变', '地理不变'])
    expect(stored.startTime).toBe(WORLD_TIME)
  })

  it('仅两字段的旧调用方成功且回落现状默认', async () => {
    const f = await createWorldFixture()
    const res = await fork(f.env, { requestId: 'req-two', scenario: { whatIf: 'w', changedVariable: 'c' } })
    expect(res.status).toBe(200)
    const { id } = await res.json() as { id: string }
    const row = await f.db.select().from(timelines).where(eq(timelines.id, id)).get()
    const stored = JSON.parse(row!.forkScenarioJson!) as Record<string, unknown>
    expect(stored.participants).toEqual([])
    expect(stored.invariants).toEqual(['分叉前的共同历史与设定版本保持不变'])
  })

  it('同 requestId 同五字段重放返回同一时间线；不同 participants → 409', async () => {
    const f = await createWorldFixture()
    const scenario = { whatIf: 'w', changedVariable: 'c', participants: ['A'], invariants: ['i'] }
    const first = await fork(f.env, { requestId: 'req-replay', scenario })
    expect(first.status).toBe(200)
    const { id } = await first.json() as { id: string }
    expect(id).toBe('req-replay')
    const replay = await fork(f.env, { requestId: 'req-replay', scenario })
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as { id: string }).id).toBe(id)
    const conflict = await fork(f.env, { requestId: 'req-replay', scenario: { ...scenario, participants: ['B'] } })
    expect(conflict.status).toBe(409)
  })

  it('两字段重放命中两字段记录；五字段重放同一 requestId → 409', async () => {
    const f = await createWorldFixture()
    const first = await fork(f.env, { requestId: 'req-legacy', scenario: { whatIf: 'w', changedVariable: 'c' } })
    expect(first.status).toBe(200)
    const replay = await fork(f.env, { requestId: 'req-legacy', scenario: { whatIf: 'w', changedVariable: 'c' } })
    expect(replay.status).toBe(200)
    // 显式传入与默认值相同的 invariants 也命中（归一化后四项全等）
    const explicit = await fork(f.env, { requestId: 'req-legacy', scenario: { whatIf: 'w', changedVariable: 'c', invariants: ['分叉前的共同历史与设定版本保持不变'] } })
    expect(explicit.status).toBe(200)
    const conflict = await fork(f.env, { requestId: 'req-legacy', scenario: { whatIf: 'w', changedVariable: 'c', participants: ['A'] } })
    expect(conflict.status).toBe(409)
  })

  it('participants/invariants 超限 → 400', async () => {
    const f = await createWorldFixture()
    const tooMany = await fork(f.env, { scenario: { whatIf: 'w', changedVariable: 'c', participants: Array(21).fill('a') } })
    expect(tooMany.status).toBe(400)
    const tooLong = await fork(f.env, { scenario: { whatIf: 'w', changedVariable: 'c', invariants: ['x'.repeat(201)] } })
    expect(tooLong.status).toBe(400)
    const notArray = await fork(f.env, { scenario: { whatIf: 'w', changedVariable: 'c', participants: 'nope' } })
    expect(notArray.status).toBe(400)
  })
})

describe('世界级 fork 预览（S2/F2）', () => {
  it('正路径：返回五字段，startTime 强制为源线 simNow，不落库，记账 fork_preview', async () => {
    const f = await createWorldFixture()
    await seedResident(f)
    stubLlm(scenarioJson)
    const before = await f.db.select({ n: count() }).from(timelines).get()

    const res = await app.request('/api/worlds/home-world/timelines/home-main/fork/preview', {
      method: 'POST', headers: owner, body: JSON.stringify({ whatIf: scenarioJson.whatIf }),
    }, f.env)

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.whatIf).toBe(scenarioJson.whatIf)
    expect(body.startTime).toBe(WORLD_TIME) // 不是 LLM 起草的 2020
    expect(body.changedVariable).toBe('信件是否送达')
    expect(body.participants).toEqual(['Resident'])
    expect(body.invariants).toEqual(['分叉前的共同历史不变', '世界地理不变'])

    const after = await f.db.select({ n: count() }).from(timelines).get()
    expect(after?.n).toBe(before?.n)
    const logs = await f.db.select().from(llmCallLog).where(eq(llmCallLog.purpose, 'fork_preview'))
    expect(logs.length).toBeGreaterThan(0)
  })

  it('缺 whatIf → 400；超长 whatIf → 400', async () => {
    const f = await createWorldFixture()
    const missing = await app.request('/api/worlds/home-world/timelines/home-main/fork/preview', {
      method: 'POST', headers: owner, body: JSON.stringify({}),
    }, f.env)
    expect(missing.status).toBe(400)
    const long = await app.request('/api/worlds/home-world/timelines/home-main/fork/preview', {
      method: 'POST', headers: owner, body: JSON.stringify({ whatIf: 'x'.repeat(501) }),
    }, f.env)
    expect(long.status).toBe(400)
  })

  it('世界不存在 → 404；无会话 → 401；时间线不属于世界 → 404', async () => {
    const f = await createWorldFixture()
    const noWorld = await app.request('/api/worlds/nope/timelines/home-main/fork/preview', {
      method: 'POST', headers: owner, body: JSON.stringify({ whatIf: 'w' }),
    }, f.env)
    expect(noWorld.status).toBe(404)
    const noSession = await app.request('/api/worlds/home-world/timelines/home-main/fork/preview', {
      method: 'POST', headers: other, body: JSON.stringify({ whatIf: 'w' }),
    }, f.env)
    expect(noSession.status).toBe(401)
    const badTimeline = await app.request('/api/worlds/home-world/timelines/other-main/fork/preview', {
      method: 'POST', headers: owner, body: JSON.stringify({ whatIf: 'w' }),
    }, f.env)
    expect(badTimeline.status).toBe(404)
  })

  it('LLM 两次都失败 → 502', async () => {
    const f = await createWorldFixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const res = await app.request('/api/worlds/home-world/timelines/home-main/fork/preview', {
      method: 'POST', headers: owner, body: JSON.stringify({ whatIf: 'w' }),
    }, f.env)
    expect(res.status).toBe(502)
  })
})

describe('人物级 fork 预览 startTime 纪律（S2/T1）', () => {
  it('LLM 起草过去时刻时,返回 startTime 仍强制为源线 simNow', async () => {
    const f = await createWorldFixture()
    const personModel = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] })
    await f.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: personModel, createdAt: WORLD_TIME })
    await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
    await f.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })
    await f.db.insert(conversations).values({ id: 'conversation', userId: 'owner', personId: 'resident', timelineId: 'home-main' })
    stubLlm({ ...scenarioJson, startTime: '2020-01-01T00:00:00.000Z' })

    const res = await app.request('/api/persons/resident/fork/preview', {
      method: 'POST', headers: owner, body: JSON.stringify({ whatIf: scenarioJson.whatIf }),
    }, f.env)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.startTime).toBe(WORLD_TIME)
    expect(body.changedVariable).toBe('信件是否送达')
  })
})
