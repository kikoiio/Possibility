import { afterEach, describe, expect, it, vi } from 'vitest'
import { count, eq } from 'drizzle-orm'
import app from '../index'
import { conversations, llmCallLog, persons, personStates, timelines, universeEvidence, userLlmConfigs, worldPersons } from '../db/schema'
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

  it('用户 Key 401:502 文案含设置页提示,平台 env 端点零请求(AC7/F8)', async () => {
    const f = await createWorldFixture()
    await f.db.insert(userLlmConfigs).values({
      userId: 'owner', baseUrl: 'https://user-llm.invalid', apiKey: 'user-key', model: null, updatedAt: WORLD_TIME,
    })
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response('unauthorized', { status: 401 })
    }))
    const res = await app.request('/api/worlds/home-world/timelines/home-main/fork/preview', {
      method: 'POST', headers: owner, body: JSON.stringify({ whatIf: 'w' }),
    }, f.env)
    expect(res.status).toBe(502)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('设置页')
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.startsWith('https://user-llm.invalid'))).toBe(true) // 平台 https://llm.invalid 零请求
    expect(JSON.stringify(body)).not.toContain('user-key') // N4:错误不回显 Key
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

/* ---------- S4/F6:历史范围端点与历史分叉 ---------- */

const T1 = '2026-09-21T09:00:00.000Z'
const T2 = '2026-09-21T10:00:00.000Z'

async function buildHistoryWorld(f: Awaited<ReturnType<typeof createWorldFixture>>) {
  const { createRootProjectionBaseline } = await import('../world-state/model')
  const { commitWorldCommand } = await import('../world-state/commit')
  const { worldModelVersions, universeRevisions } = await import('../db/schema')
  await seedResident(f)
  const state = (await f.db.select().from(personStates).where(eq(personStates.personId, 'resident')).get())!
  const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [
    { ...state, currentDialogueId: null, lastBeatSimTime: null }])
  await f.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: '',
      locations: [{ name: 'Cafe', description: '' }, { name: 'Library', description: '' }],
      residents: [{ id: 'resident', name: 'Resident', model: {} }], projectionBaseline: baseline }) })
  await f.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })
  let version = 0
  const commit = async (id: string, action: import('../world-state/types').WorldAction) => {
    const result = await commitWorldCommand(f.db, { id, worldId: 'home-world', timelineId: 'home-main',
      userId: 'owner', expectedVersion: version, action, actorKind: 'system' })
    expect(result.version).toBe(++version)
  }
  await commit('h-clock1', { type: 'clock_advance', from: WORLD_TIME, to: T1, observedAt: T1 })
  await commit('h-s1', { type: 'resident_state', personId: 'resident', cause: 'beat', windowStart: WORLD_TIME,
    patch: { activity: 'Walking' }, events: [{ simTime: T1, title: '散步', description: '在 Cafe 散步。' }],
    memories: [{ type: 'thought', content: 'morning note', importance: 5 }] })
  await commit('h-clock2', { type: 'clock_advance', from: T1, to: T2, observedAt: T2 })
}

describe('历史范围与单点判定端点(S4/F6)', () => {
  it('GET history:完整世界 earliest=基线时刻;缺基线世界 earliest=null;不存在 → 404', async () => {
    const f = await createWorldFixture()
    await buildHistoryWorld(f)
    const res = await app.request('/api/worlds/home-world/timelines/home-main/history', { headers: owner }, f.env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ earliest: WORLD_TIME, simNow: T2 })
    const missing = await app.request('/api/worlds/home-world/timelines/nope/history', { headers: owner }, f.env)
    expect(missing.status).toBe(404)

    const legacy = await createWorldFixture()
    const noBaseline = await app.request('/api/worlds/home-world/timelines/home-main/history', { headers: owner }, legacy.env)
    expect(await noBaseline.json()).toEqual({ earliest: null, simNow: WORLD_TIME })
  })

  it('POST history/check:历史时刻吸附、未来/起点之前 400、归档 404、缺 at 400', async () => {
    const f = await createWorldFixture()
    await buildHistoryWorld(f)
    const url = '/api/worlds/home-world/timelines/home-main/history/check'
    const check = (body: unknown) => app.request(url, { method: 'POST', headers: owner, body: JSON.stringify(body) }, f.env)
    const snapped = await check({ at: '2026-09-21T09:30:00.000Z' })
    expect(snapped.status).toBe(200)
    expect(await snapped.json()).toEqual({ ok: true, effectiveMoment: T1 })
    expect((await check({ at: '2026-12-31T00:00:00.000Z' })).status).toBe(400)
    expect((await check({ at: '2020-01-01T00:00:00.000Z' })).status).toBe(400)
    expect((await check({})).status).toBe(400)
    await f.db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-main'))
    expect((await check({ at: T1 })).status).toBe(404)
  })

  it('fork 携带历史 startTime:吸附后重建分叉,子线 simNow=有效时刻;不可重建 → 400', async () => {
    const f = await createWorldFixture()
    await buildHistoryWorld(f)
    const res = await app.request('/api/worlds/home-world/timelines/home-main/fork', {
      method: 'POST', headers: owner,
      body: JSON.stringify({ requestId: 'req-hist', scenario: { whatIf: '如果那天没下雨', changedVariable: '天气',
        startTime: '2026-09-21T09:30:00.000Z' } }),
    }, f.env)
    expect(res.status, await res.clone().text()).toBe(200)
    const body = await res.json() as { id: string; simNow: string }
    expect(body.simNow).toBe(T1) // 09:30 吸附到最近命令边界 T1
    const row = await f.db.select().from(timelines).where(eq(timelines.id, body.id)).get()
    expect(JSON.parse(row!.forkScenarioJson!)).toMatchObject({ startTime: T1 })

    const rejected = await app.request('/api/worlds/home-world/timelines/home-main/fork', {
      method: 'POST', headers: owner,
      body: JSON.stringify({ scenario: { whatIf: 'w', changedVariable: 'c', startTime: '2020-01-01T00:00:00.000Z' } }),
    }, f.env)
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ error: expect.stringContaining('早于这条线可回溯的起点') })
  })

  it('fork/preview 携带历史 startTime:草稿吸附为有效时刻', async () => {
    const f = await createWorldFixture()
    await buildHistoryWorld(f)
    stubLlm(scenarioJson)
    const res = await app.request('/api/worlds/home-world/timelines/home-main/fork/preview', {
      method: 'POST', headers: owner, body: JSON.stringify({ whatIf: scenarioJson.whatIf, startTime: T1 }),
    }, f.env)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toMatchObject({ startTime: T1 })
  })
})
