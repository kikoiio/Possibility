import { afterEach, describe, expect, it, vi } from 'vitest'
import { count, eq } from 'drizzle-orm'
import app from '../index'
import { llmCallLog, persons, personStates, timelines, worldPersons } from '../db/schema'
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
