import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { timelines } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { normalizeScenario } from '../timelines/routes'
import { normalizeForkFields } from '../life/fork-fields'

const owner = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
const scenario = { name: '提前收到信', whatIf: '如果信提前到达', changedVariable: '抵达时间' }
let fixture: Awaited<ReturnType<typeof createWorldFixture>> | undefined
const fork = (body: unknown) => app.request('/api/worlds/home-world/timelines/home-main/fork', { method: 'POST', headers: owner, body: JSON.stringify(body) }, fixture!.env)
afterEach(() => { fixture?.close(); fixture = undefined })

describe('S4C 新建名称与精确创建结果', () => {
  it('名称在新建结果、详情和比较证据中完整传递，幂等绑定本次请求', async () => {
    fixture = await createWorldFixture()
    const response = await fork({ requestId: 'named-fork', scenario })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'named-fork', sourceTimelineId: 'home-main', simNow: WORLD_TIME, name: scenario.name, whatIf: scenario.whatIf })
    const row = await fixture.db.select().from(timelines).where(eq(timelines.id, 'named-fork')).get()
    expect(JSON.parse(row!.forkScenarioJson!)).toMatchObject(scenario)
    const detail = await app.request('/api/timelines/named-fork', { headers: owner }, fixture.env)
    expect(await detail.json()).toMatchObject({ timeline: { forkScenario: scenario } })
    const compare = await app.request('/api/worlds/home-world/compare?left=home-main&right=named-fork', { headers: owner }, fixture.env)
    expect(await compare.json()).toMatchObject({ timeAlignment: 'same_sim_time', sharedForkOrigin: { rightFork: { scenario } } })
    expect((await fork({ requestId: 'named-fork', scenario })).status).toBe(200)
    expect((await fork({ requestId: 'named-fork', scenario: { ...scenario, name: '另一名称' } })).status).toBe(409)
  })
  it('缺失、空值、超长或非文字字段拒绝创建且没有新时间线', async () => {
    fixture = await createWorldFixture()
    const before = await fixture.db.select().from(timelines).all()
    for (const [field, max] of [['name', 80], ['whatIf', 500], ['changedVariable', 200]] as const) {
      for (const value of [undefined, '', ' ', '字'.repeat(max + 1), 123]) {
        expect((await fork({ scenario: { ...scenario, [field]: value } })).status).toBe(400)
      }
    }
    expect(await fixture.db.select().from(timelines).all()).toEqual(before)
  })
  it('预览提供可编辑名称建议，旧 scenario 读取不必新增名称', () => {
    expect(normalizeScenario({ ...scenario, name: '建议名' }, '假设', WORLD_TIME).name).toBe('建议名')
    expect(normalizeScenario({}, '旧预览假设', WORLD_TIME).name).toBe('旧预览假设')
    expect(normalizeForkFields({ ...scenario, name: undefined })).toBeNull()
  })
})
