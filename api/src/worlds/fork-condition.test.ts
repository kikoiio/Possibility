import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { visibleKnowledgeForPerson } from '../agent/knowledge'
import { events, persons, sessions, timelines, universeEvidence, universeRevisions, worldCommands, worldFacts, worldModelVersions, worldPersons, worlds } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { commitWorldCommand } from '../world-state/commit'

const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
let fixture: Awaited<ReturnType<typeof createWorldFixture>> | undefined
afterEach(() => { fixture?.close(); fixture = undefined; vi.unstubAllGlobals() })

async function seedResident() {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident-a', userId: 'owner', name: 'Ada', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident-a', joinedAt: WORLD_TIME })
  return fixture
}

const request = (path: string, method: string, body: unknown) => app.request(path, {
  method, headers, body: JSON.stringify(body),
}, fixture!.env)

describe('F1 登录用户 fork 条件执行 API', () => {
  it('一次预览建议动作；用户编辑后在暂停世界确认，幂等返回相同私有结果', async () => {
    const f = await seedResident()
    const proposed = { type: 'inform', recipientId: 'resident-a', topic: '包裹', content: '包裹已到' }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [
      { message: { content: JSON.stringify({ name: '信件分支', whatIf: '如果包裹提前到达', startTime: WORLD_TIME,
        changedVariable: '包裹到达时间', participants: ['Ada'], invariants: ['地点不变'], actionProposal: proposed }) } },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const previewResponse = await request('/api/worlds/home-world/timelines/home-main/fork/preview', 'POST', {
      whatIf: '如果包裹提前到达',
    })
    expect(previewResponse.status).toBe(200)
    const preview = await previewResponse.json() as Record<string, any>
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(preview).toMatchObject({ sourceVersion: 0, actionProposal: proposed,
      actionTargets: { residents: [{ id: 'resident-a', name: 'Ada' }], locations: ['Cafe', 'Library'] } })
    expect(preview.sourceCandidates).toEqual([])
    const scenario = { name: preview.name, whatIf: preview.whatIf, changedVariable: preview.changedVariable,
      participants: preview.participants, invariants: preview.invariants, startTime: preview.startTime }
    const editedAction = { ...proposed, content: '包裹已送到图书馆' }
    await f.db.update(worlds).set({ status: 'paused' }).where(eq(worlds.id, 'home-world'))
    const body = { requestId: 'f1-route-request', scenario, expectedSourceVersion: preview.sourceVersion, initialAction: editedAction }
    const created = await request('/api/worlds/home-world/timelines/home-main/fork', 'POST', body)
    expect(created.status).toBe(200)
    const result = await created.json() as { id: string; action: { commandId: string; factId: string; version: number; summary: string } }
    expect(result.action).toMatchObject({ version: 1, summary: '已向指定居民传递消息' })
    expect(fetchMock).toHaveBeenCalledTimes(1) // confirmation does not call the model
    expect((await f.db.select().from(worlds).where(eq(worlds.id, 'home-world')).get())?.status).toBe('paused')
    expect(await f.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, result.id)).get())
      .toMatchObject({ version: 1, simTime: WORLD_TIME })
    const messageFact = await f.db.select().from(worldFacts).where(eq(worldFacts.id, result.action.factId)).get()
    const messageValue = JSON.parse(messageFact!.valueJson)
    expect(messageValue)
      .toMatchObject({ recipientId: 'resident-a', content: editedAction.content, certainty: 'rumor', sourceFactId: null })
    const residentEvidence = [{ id: messageFact!.id, timelineId: messageFact!.timelineId, simTime: messageFact!.simTime,
      version: messageFact!.version, factType: messageFact!.factType, visibility: messageFact!.visibility, value: messageValue }]
    expect(visibleKnowledgeForPerson(residentEvidence, 'resident-a').map(evidence => evidence.text)).toContain(`包裹：${editedAction.content}`)
    expect(visibleKnowledgeForPerson(residentEvidence, 'another-resident')).toEqual([])
    const publicEvent = await f.db.select().from(events).where(eq(events.timelineId, result.id)).get()
    expect(`${publicEvent!.title} ${publicEvent!.description}`).not.toContain(editedAction.content)

    const replay = await request('/api/worlds/home-world/timelines/home-main/fork', 'POST', body)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ id: result.id, action: result.action, replayed: true })
    const conflictingReplay = await request('/api/worlds/home-world/timelines/home-main/fork', 'POST', {
      ...body, initialAction: { ...editedAction, content: '不同的内容' },
    })
    expect(conflictingReplay.status).toBe(409)
    expect(await f.db.select().from(timelines).where(eq(timelines.worldId, 'home-world'))).toHaveLength(2)
    expect(await f.db.select().from(worldCommands).where(eq(worldCommands.timelineId, result.id))).toHaveLength(1)
    expect(await f.db.select().from(universeEvidence).where(eq(universeEvidence.timelineId, result.id)).get())
      .toMatchObject({ level: 'complete', assessedVersion: 1 })
  })

  it('拒绝过期预览版本且不创建子线', async () => {
    const f = await seedResident()
    await f.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
      worldModelVersion: 1, updatedAt: WORLD_TIME })
    await f.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1,
      modelJson: JSON.stringify({ name: 'Home world', description: 'A small town',
        locations: [{ name: 'Cafe', description: '' }, { name: 'Library', description: '' }],
        residents: [{ id: 'resident-a', name: 'Ada', model: {} }] }), createdAt: WORLD_TIME })
    await commitWorldCommand(f.db, { id: 'advance-before-confirm', worldId: 'home-world', timelineId: 'home-main',
      userId: 'owner', expectedVersion: 0,
      action: { type: 'environment', location: 'Cafe', condition: 'weather', value: 'rain' } })
    const response = await request('/api/worlds/home-world/timelines/home-main/fork', 'POST', {
      requestId: 'f1-stale-preview', expectedSourceVersion: 0,
      scenario: { name: '旧预览', whatIf: '旧设定', changedVariable: '天气', startTime: WORLD_TIME },
      initialAction: { type: 'environment', location: 'Library', condition: 'lighting', value: '明亮' },
    })
    expect(response.status).toBe(409)
    expect(await f.db.select().from(timelines).where(eq(timelines.worldId, 'home-world'))).toHaveLength(1)
    expect(await f.db.select().from(worldCommands).where(eq(worldCommands.timelineId, 'f1-stale-preview'))).toHaveLength(0)
  })

  it('环境动作的首次成功和幂等重放返回相同回执', async () => {
    const f = await seedResident()
    const body = {
      requestId: 'f1-environment-replay', expectedSourceVersion: 0,
      scenario: { name: '晴日', whatIf: '如果天气转晴', changedVariable: '天气', startTime: WORLD_TIME },
      initialAction: { type: 'environment', location: 'Cafe', condition: 'weather', value: '晴朗' },
    }
    const first = await request('/api/worlds/home-world/timelines/home-main/fork', 'POST', body)
    expect(first.status).toBe(200)
    const firstResult = await first.json() as { action: { summary: string; commandId: string; factId: string; version: number } }
    const replay = await request('/api/worlds/home-world/timelines/home-main/fork', 'POST', body)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ action: firstResult.action, replayed: true })
    expect(firstResult.action.summary).toBe('Cafe的天气已设为：晴朗')
    expect(await f.db.select().from(timelines).where(eq(timelines.worldId, 'home-world'))).toHaveLength(2)
    expect(await f.db.select().from(worldCommands).where(eq(worldCommands.id, firstResult.action.commandId))).toHaveLength(1)
  })

  it('拒绝未登录、非所有者、无效动作和归档源线且不留下写入', async () => {
    const f = await seedResident()
    await f.db.insert(sessions).values({ token: 'other-token', userId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' })
    const body = {
      requestId: 'f1-gate-failures', expectedSourceVersion: 0,
      scenario: { name: '分支', whatIf: '假设', changedVariable: '天气', startTime: WORLD_TIME },
      initialAction: { type: 'environment', location: 'Cafe', condition: 'weather', value: '晴朗' },
    }
    const path = '/api/worlds/home-world/timelines/home-main/fork'
    const unauthenticated = await app.request(path, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, f.env)
    const nonOwner = await app.request(path, { method: 'POST',
      headers: { Authorization: 'Bearer other-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, f.env)
    const invalidAction = await request(path, 'POST', { ...body, requestId: 'f1-invalid-action',
      initialAction: { type: 'environment', location: 'Cafe', condition: 'arbitrary', value: 'x' } })
    await f.db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-main'))
    const archivedSource = await request(path, 'POST', { ...body, requestId: 'f1-archived-source' })

    expect(unauthenticated.status).toBeGreaterThanOrEqual(400)
    expect(nonOwner.status).toBeGreaterThanOrEqual(400)
    expect(invalidAction.status).toBe(400)
    expect(archivedSource.status).toBeGreaterThanOrEqual(400)
    expect(await f.db.select().from(timelines).where(eq(timelines.worldId, 'home-world'))).toHaveLength(1)
    expect(await f.db.select().from(worldCommands).where(eq(worldCommands.timelineId, 'home-main'))).toHaveLength(0)
    expect(await f.db.select().from(worldFacts).where(eq(worldFacts.timelineId, 'home-main'))).toHaveLength(0)
    expect(await f.db.select().from(events).where(eq(events.timelineId, 'home-main'))).toHaveLength(0)
  })
})
