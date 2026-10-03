import { afterEach, describe, expect, it, vi } from 'vitest'
import { persons, personStates, timelines, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import app from '../index'

const mocked = vi.hoisted(() => ({ fail: false }))
vi.mock('../agent/loop', () => ({ runAgentTurn: async function* () {
  if (mocked.fail) yield { type: 'done', error: '推演失败', llmCalls: 0 }
  else yield { type: 'done', llmCalls: 0 }
} }))

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | undefined
const owner = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
const scenario = { name: '提前抵达', whatIf: '如果提前抵达', changedVariable: '抵达时刻', startTime: WORLD_TIME, participants: [], invariants: [] }
afterEach(() => { fixture?.close(); fixture = undefined; mocked.fail = false })
async function seed() {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: '居民', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ personId: 'resident', worldId: 'home-world', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe', activity: '等待', mood: '平静', goal: '抵达', updatedRealAt: WORLD_TIME })
}
const request = (value: unknown) => app.request('/api/persons/resident/fork', { method: 'POST', headers: owner, body: JSON.stringify({ scenario: value }) }, fixture!.env)

describe('人物分叉 SSE 精确完成契约', () => {
  it('中间事件不是完成结果，完成事件返回来源和本次新线及可读摘要', async () => {
    await seed()
    const response = await request(scenario)
    expect(response.status).toBe(200)
    const events = (await response.text()).split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
    expect(events[0]).toMatchObject({ type: 'timeline' })
    expect(events[0].fork).toBeUndefined()
    expect(events.at(-1)).toMatchObject({ type: 'done', fork: { id: events[0].timelineId, sourceTimelineId: 'home-main', simNow: WORLD_TIME, name: scenario.name, whatIf: scenario.whatIf } })
  })
  it('推演失败的 done 不冒充可比较的成功结果', async () => {
    await seed(); mocked.fail = true
    const events = (await (await request(scenario)).text()).split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
    expect(events.at(-1)).toMatchObject({ type: 'done', error: '推演失败' })
    expect(events.at(-1).fork).toBeUndefined()
  })
  it('无效新建字段没有时间线副作用', async () => {
    await seed()
    const before = await fixture!.db.select().from(timelines).all()
    for (const key of ['name', 'whatIf', 'changedVariable'] as const) expect((await request({ ...scenario, [key]: '' })).status).toBe(400)
    expect(await fixture!.db.select().from(timelines).all()).toEqual(before)
  })
})
