import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { projectVoxelEvents, type VoxelProjectionPayload } from './projection'
import { createTestDb } from '../test/db'
import { budgetFromEnv, type BudgetConfig } from '../engine/budget'
import type { TickBudget } from '../engine/guard'
import { dialogues, events, llmCallLog, memories, persons, personStates, timelines, universeEvidence, universeRevisions, users, voxelEventProjections, worldSceneRevisions, worldScenes, worlds } from '../db/schema'

const SIM_NOW = '2026-10-15T17:00:00.000Z'
const CFG: BudgetConfig = budgetFromEnv({})
const LLM = { baseUrl: 'https://llm.invalid', apiKey: 'test', model: 'test', source: 'env' as const,
  apiKeySource: 'platform_fallback' as const, apiKeyVerified: false }

const VOXEL_DOC = {
  size: { width: 48, height: 24, depth: 48 },
  objects: [{ id: 'house', anchor: { x: 20, y: 1, z: 18 } }],
  locations: [{ name: '主楼', objectId: 'house' }],
}

async function seed() {
  const { db, env } = createTestDb()
  const now = SIM_NOW
  await db.insert(users).values({ id: 'u1', username: 'u1', passwordHash: 'x', createdAt: now })
  await db.insert(worlds).values({ id: 'w1', userId: 'u1', name: '测试世界', description: '', status: 'running', createdAt: now })
  await db.insert(timelines).values({ id: 'tl1', worldId: 'w1', parentTimelineId: null, simNow: now, createdAt: now, status: 'active' })
  await db.insert(universeRevisions).values({ timelineId: 'tl1', version: 5, simTime: now, worldModelVersion: 1, updatedAt: now })
  await db.insert(universeEvidence).values({ timelineId: 'tl1', level: 'complete', assessedVersion: 5, baselineVersion: 0, reasonCodesJson: '[]', assessedAt: now })
  await db.insert(persons).values([
    { id: 'p-a', userId: 'u1', name: '甲', modelJson: '{}', createdAt: now },
    { id: 'p-b', userId: 'u1', name: '乙', modelJson: '{}', createdAt: now },
  ])
  await db.insert(personStates).values([
    { personId: 'p-a', timelineId: 'tl1', simTime: now, location: '主楼', activity: '打扫', mood: '平静', goal: '', updatedRealAt: now },
    { personId: 'p-b', timelineId: 'tl1', simTime: now, location: '主楼', activity: '看书', mood: '平静', goal: '', updatedRealAt: now },
  ])
  await db.insert(worldScenes).values({ worldId: 'w1', currentVersion: 1, themeId: 'mist-manor', updatedAt: now })
  await db.insert(worldSceneRevisions).values({ id: 'sr1', worldId: 'w1', version: 1, requestId: 'req1',
    contentHash: 'h', documentJson: JSON.stringify(VOXEL_DOC), summary: '', kind: 'voxel', createdAt: now })
  const world = (await db.select().from(worlds).where(eq(worlds.id, 'w1')).get())!
  const timeline = (await db.select().from(timelines).where(eq(timelines.id, 'tl1')).get())!
  return { db, env, world, timeline }
}

function stubFetchCopy(copy = { label: '夜话', teaser: '两人在主楼聊起秋收', scene: '灯下两人低声交谈。' }) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(copy) } }],
  }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function payloadsOf(db: Awaited<ReturnType<typeof seed>>['db']): Promise<VoxelProjectionPayload[]> {
  const rows = await db.select().from(voxelEventProjections).where(eq(voxelEventProjections.timelineId, 'tl1')).all()
  return rows.map(row => JSON.parse(row.payloadJson) as VoxelProjectionPayload)
}

afterEach(() => vi.unstubAllGlobals())

describe('projectVoxelEvents 门控(AC2)', () => {
  it('仅 low 事件:投影落库、零 LLM 记账、fetch 未调用', async () => {
    const { db, env, world, timeline } = await seed()
    await db.insert(events).values({ id: 'e1', timelineId: 'tl1', simTime: '2026-10-15T10:00:00.000Z',
      title: '在主楼打扫', description: '把落叶归到墙角', kind: 'action', actorPersonId: 'p-a', dialogueId: null })
    const fetchMock = stubFetchCopy()
    const tickBudget: TickBudget = { used: 0, limit: 8 }
    const run = await projectVoxelEvents(db, env, { world, timeline, cfg: CFG, tickBudget, llm: LLM, allowCopyLlm: true })
    expect(run).toMatchObject({ projected: 1, copyLlm: false })
    const payloads = await payloadsOf(db)
    expect(payloads).toHaveLength(1)
    expect(payloads[0].copySource).toBe('template')
    expect(payloads[0].sourceEventIds).toEqual(['e1'])
    expect(payloads[0].event.at).toEqual({ x: 20, y: 2, z: 18 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await db.select().from(llmCallLog).all()).toHaveLength(0)
  })

  it('medium 事件:purpose=voxel_distill 记账,文案落库 copySource=llm', async () => {
    const { db, env, world, timeline } = await seed()
    await db.insert(dialogues).values({ id: 'd1', timelineId: 'tl1', location: '主楼', participantIdsJson: '["p-a","p-b"]', simStart: '2026-10-15T14:00:00.000Z' })
    await db.insert(events).values([
      { id: 'e1', timelineId: 'tl1', simTime: '2026-10-15T14:00:00.000Z', title: '两人交谈', description: '聊起秋收', kind: 'dialogue', actorPersonId: 'p-a', dialogueId: 'd1' },
      { id: 'e2', timelineId: 'tl1', simTime: '2026-10-15T14:03:00.000Z', title: '两人交谈', description: '笑声不断', kind: 'dialogue', actorPersonId: 'p-b', dialogueId: 'd1' },
    ])
    const fetchMock = stubFetchCopy()
    const tickBudget: TickBudget = { used: 0, limit: 8 }
    const run = await projectVoxelEvents(db, env, { world, timeline, cfg: CFG, tickBudget, llm: LLM, allowCopyLlm: true })
    expect(run).toMatchObject({ projected: 1, copyLlm: true })
    const payloads = await payloadsOf(db)
    expect(payloads[0].copySource).toBe('llm')
    expect(payloads[0].event.label).toBe('夜话')
    expect(payloads[0].event.importance).toBe('medium')
    const logs = await db.select().from(llmCallLog).all()
    expect(logs).toHaveLength(1)
    expect(logs[0].purpose).toBe('voxel_distill')
    expect(logs[0].status).toBe('completed')
    expect(tickBudget.used).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 第二拍:源事件未变 → 沿用 llm 文案,不再烧调用
    const run2 = await projectVoxelEvents(db, env, { world, timeline, cfg: CFG, tickBudget, llm: LLM, allowCopyLlm: true })
    expect(run2?.copyLlm).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await payloadsOf(db))[0].event.label).toBe('夜话')
  })

  it('LLM 失败:事件仍上线,文案退模板(fail-closed)', async () => {
    const { db, env, world, timeline } = await seed()
    await db.insert(dialogues).values({ id: 'd1', timelineId: 'tl1', location: '主楼', participantIdsJson: '["p-a","p-b"]', simStart: '2026-10-15T14:00:00.000Z' })
    await db.insert(events).values([
      { id: 'e1', timelineId: 'tl1', simTime: '2026-10-15T14:00:00.000Z', title: '两人交谈', description: '聊起秋收', kind: 'dialogue', actorPersonId: 'p-a', dialogueId: 'd1' },
      { id: 'e2', timelineId: 'tl1', simTime: '2026-10-15T14:03:00.000Z', title: '两人交谈', description: '笑声不断', kind: 'dialogue', actorPersonId: 'p-b', dialogueId: 'd1' },
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream down', { status: 502 })))
    const run = await projectVoxelEvents(db, env, { world, timeline, cfg: CFG, tickBudget: { used: 0, limit: 8 }, llm: LLM, allowCopyLlm: true })
    expect(run?.copyLlm).toBe(false)
    const payloads = await payloadsOf(db)
    expect(payloads).toHaveLength(1)
    expect(payloads[0].copySource).toBe('template')
    expect(payloads[0].event.label).toBe('交谈')
  })

  it('本拍预算触顶:不发 LLM、不记账,模板文案保留', async () => {
    const { db, env, world, timeline } = await seed()
    await db.insert(dialogues).values({ id: 'd1', timelineId: 'tl1', location: '主楼', participantIdsJson: '["p-a","p-b"]', simStart: '2026-10-15T14:00:00.000Z' })
    await db.insert(events).values([
      { id: 'e1', timelineId: 'tl1', simTime: '2026-10-15T14:00:00.000Z', title: '两人交谈', description: '聊起秋收', kind: 'dialogue', actorPersonId: 'p-a', dialogueId: 'd1' },
      { id: 'e2', timelineId: 'tl1', simTime: '2026-10-15T14:03:00.000Z', title: '两人交谈', description: '笑声不断', kind: 'dialogue', actorPersonId: 'p-b', dialogueId: 'd1' },
    ])
    const fetchMock = stubFetchCopy()
    const run = await projectVoxelEvents(db, env, { world, timeline, cfg: CFG, tickBudget: { used: 8, limit: 8 }, llm: LLM, allowCopyLlm: true })
    expect(run?.copyLlm).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await db.select().from(llmCallLog).all()).toHaveLength(0)
    expect((await payloadsOf(db))[0].copySource).toBe('template')
  })

  it('无体素文档的世界 → null(2D 场景世界管线不适用)', async () => {
    const { db, env, world, timeline } = await seed()
    await db.update(worldSceneRevisions).set({ documentJson: JSON.stringify({ schemaVersion: 1 }) }).where(eq(worldSceneRevisions.worldId, 'w1'))
    await db.insert(events).values({ id: 'e1', timelineId: 'tl1', simTime: '2026-10-15T10:00:00.000Z',
      title: '打扫', description: '', kind: 'action', actorPersonId: 'p-a', dialogueId: null })
    const run = await projectVoxelEvents(db, env, { world, timeline, cfg: CFG, tickBudget: { used: 0, limit: 8 }, llm: LLM, allowCopyLlm: true })
    expect(run).toBeNull()
    expect(await db.select().from(voxelEventProjections).all()).toHaveLength(0)
  })

  it('legacy NULL 桶世界:蒸馏不崩,投影照常(AC4)', async () => {
    const { db, env, world, timeline } = await seed()
    // 主线遗留 NULL 桶记忆(历史分叉因此对主线不可用,但蒸馏管线不得受影响)
    await db.insert(memories).values({ id: 'legacy-m', personId: 'p-a', timelineId: null, type: 'event',
      content: 'legacy', simTime: '2026-10-15T09:00:00.000Z', createdAt: '2026-10-15T09:00:00.000Z', importance: 5 })
    await db.insert(events).values({ id: 'e1', timelineId: 'tl1', simTime: '2026-10-15T10:00:00.000Z',
      title: '在主楼打扫', description: '', kind: 'action', actorPersonId: 'p-a', dialogueId: null })
    const run = await projectVoxelEvents(db, env, { world, timeline, cfg: CFG, tickBudget: { used: 0, limit: 8 }, llm: LLM, allowCopyLlm: false })
    expect(run).toMatchObject({ projected: 1 })
  })

  it('其他时间线(非祖先)的事件不进入本线投影', async () => {
    const { db, env, world, timeline } = await seed()
    await db.insert(timelines).values({ id: 'tl2', worldId: 'w1', parentTimelineId: null, simNow: SIM_NOW, createdAt: SIM_NOW, status: 'active' })
    await db.insert(events).values({ id: 'e9', timelineId: 'tl2', simTime: '2026-10-15T10:00:00.000Z',
      title: '别线事件', description: '', kind: 'action', actorPersonId: 'p-a', dialogueId: null })
    const run = await projectVoxelEvents(db, env, { world, timeline, cfg: CFG, tickBudget: { used: 0, limit: 8 }, llm: LLM, allowCopyLlm: false })
    expect(run).toMatchObject({ projected: 0 })
  })
})
