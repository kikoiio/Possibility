import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { memories, memoryAccess, personStates, persons, timelines, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { buildEngineContext, buildWorldSnapshot } from './engine-context'
import { recordAccess, retrieveForPrompt, situationalScore, type Memory, type Situation } from './memory'
import { DEFAULT_RETRIEVAL_CONFIG, type RetrievalConfig } from './retrieval-config'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

const SIM_NOW = WORLD_TIME // 2026-09-21T08:00:00.000Z

async function setup() {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values([
    { id: 'ada', userId: 'owner', name: 'Ada', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'bo', userId: 'owner', name: 'Bo', modelJson: '{}', createdAt: WORLD_TIME },
  ])
  await fixture.db.insert(worldPersons).values([
    { worldId: 'home-world', personId: 'ada', joinedAt: WORLD_TIME },
    { worldId: 'home-world', personId: 'bo', joinedAt: WORLD_TIME },
  ])
  const timeline = await fixture.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get()
  return { db: fixture.db, timeline: timeline! }
}

function mem(id: string, over: Partial<Memory> & { createdAt: string }): Memory {
  return {
    id, personId: 'ada', timelineId: 'home-main', type: 'timeline', content: id,
    simTime: over.createdAt, importance: 5, summarized: false,
    mentionedPersonIdsJson: null, locationName: null, topicsJson: null, level: null, createdVersion: null, ...over,
  }
}

function situation(over: Partial<Situation> = {}): Situation {
  return { presentPersonIds: [], presentPersonNames: [], locationName: null, situationText: '', ...over }
}

function config(over: Partial<RetrievalConfig> = {}): RetrievalConfig {
  return { ...DEFAULT_RETRIEVAL_CONFIG, ...over }
}

async function insertMemories(db: NonNullable<typeof fixture>['db'], list: Memory[]) {
  await db.insert(memories).values(list)
}

describe('retrieveForPrompt(S1 检索器)', () => {
  it('新近保底:低分新记忆必入选,即使 topK=1', async () => {
    const { db, timeline } = await setup()
    const list = [
      mem('old-important', { createdAt: '2026-09-19T00:00:00Z', importance: 10 }),
      mem('fresh-trivial', { createdAt: '2026-09-21T07:00:00Z', importance: 1 }),
    ]
    await insertMemories(db, list)
    const selected = await retrieveForPrompt(db, 'ada', timeline, situation(), config({ recentFloor: 1, topK: 1, summaryFloorPerLevel: 0 }))
    expect(selected.map((m) => m.id).sort()).toEqual(['fresh-trivial', 'old-important'])
  })

  it('情境分翻盘:mentions 命中的 5 分记忆排在无命中的 10 分记忆之前', async () => {
    const { db, timeline } = await setup()
    await insertMemories(db, [
      mem('no-hit-10', { createdAt: SIM_NOW, importance: 10 }),
      mem('mentions-5', { createdAt: SIM_NOW, importance: 5, mentionedPersonIdsJson: '["bo"]' }),
    ])
    const selected = await retrieveForPrompt(db, 'ada', timeline,
      situation({ presentPersonIds: ['bo'], presentPersonNames: ['Bo'] }),
      config({ w2: 1, recentFloor: 0, topK: 1, summaryFloorPerLevel: 0 }))
    // w2=1 时情境分足以翻盘;验证打分排序取 top-1
    expect(selected[selected.length - 1]!.id).toBe('mentions-5')
  })

  it('候选限量上界:candidateImportant=3 时第 4 重要记忆不可达', async () => {
    const { db, timeline } = await setup()
    const list = Array.from({ length: 20 }, (_, i) =>
      mem(`m${i}`, { createdAt: `2026-09-${String(10 + (i % 9)).padStart(2, '0')}T00:00:00Z`, importance: i + 1 }))
    await insertMemories(db, list)
    const selected = await retrieveForPrompt(db, 'ada', timeline, situation(),
      config({ candidateRecent: 3, candidateImportant: 3, candidateAnnotated: 0 as never, summaryFloorPerLevel: 0, recentFloor: 1, topK: 15 }))
    const ids = selected.map((m) => m.id)
    // 第 4 重要(importance 17,m16)既不在近 3 也不在重要性前 3,不可达
    expect(ids).not.toContain('m16')
    expect(ids.length).toBeLessThanOrEqual(6)
  })

  it('去重且按虚拟时间升序', async () => {
    const { db, timeline } = await setup()
    await insertMemories(db, [
      mem('a', { createdAt: '2026-09-20T00:00:00Z', importance: 10 }),
      mem('b', { createdAt: '2026-09-19T00:00:00Z', importance: 9 }),
      mem('c', { createdAt: '2026-09-21T01:00:00Z', importance: 1 }),
    ])
    const selected = await retrieveForPrompt(db, 'ada', timeline, situation(), config({ summaryFloorPerLevel: 0 }))
    const ids = selected.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['b', 'a', 'c'])
  })

  it('summary 保底:每层级最新 floor 条入选(S2 F7;两条 L1 时只保最新一条)', async () => {
    const { db, timeline } = await setup()
    await insertMemories(db, [
      mem('s1', { createdAt: '2026-09-10T00:00:00Z', type: 'summary' }),
      mem('s2', { createdAt: '2026-09-18T00:00:00Z', type: 'summary' }),
      mem('x', { createdAt: '2026-09-21T01:00:00Z', importance: 1 }),
    ])
    const selected = await retrieveForPrompt(db, 'ada', timeline, situation(), config({ recentFloor: 1, topK: 1, summaryFloorPerLevel: 1 }))
    expect(selected.map((m) => m.id)).toContain('s2')
    expect(selected.map((m) => m.id)).not.toContain('s1')
  })

  it('分层保底:L1 与 L2 各保最新 1 条,选中集 ≤22(N1)', async () => {
    const { db, timeline } = await setup()
    await insertMemories(db, [
      mem('l1-old', { createdAt: '2026-09-01T00:00:00Z', type: 'summary', level: 1 }),
      mem('l2-old', { createdAt: '2026-09-05T00:00:00Z', type: 'summary', level: 2 }),
      mem('l1-new', { createdAt: '2026-09-10T00:00:00Z', type: 'summary', level: 1 }),
      mem('l2-new', { createdAt: '2026-09-12T00:00:00Z', type: 'summary', level: 2 }),
      // 旧摘要缺 level 按 L1 推导(N4)
      mem('legacy-summary', { createdAt: '2026-09-08T00:00:00Z', type: 'summary', level: null }),
      mem('x', { createdAt: '2026-09-21T01:00:00Z', importance: 1 }),
    ])
    const selected = await retrieveForPrompt(db, 'ada', timeline, situation(),
      config({ recentFloor: 1, topK: 1, summaryFloorPerLevel: 1 }))
    const ids = selected.map((m) => m.id)
    expect(ids).toContain('l1-new')
    expect(ids).toContain('l2-new')
    expect(ids).not.toContain('l1-old')
    expect(ids).not.toContain('l2-old')
    expect(ids).not.toContain('legacy-summary')
    expect(ids.length).toBeLessThanOrEqual(22)
  })

  it('recordAccess 幂等累加:两次检索后 access_count=2 且时钟刷新', async () => {
    const { db, timeline } = await setup()
    await insertMemories(db, [mem('x', { createdAt: '2026-09-20T00:00:00Z' })])
    await retrieveForPrompt(db, 'ada', timeline)
    await retrieveForPrompt(db, 'ada', timeline)
    const row = await db.select().from(memoryAccess).where(eq(memoryAccess.memoryId, 'x')).get()
    expect(row?.accessCount).toBe(2)
    expect(row?.lastAccessedSimAt).toBe(SIM_NOW)
  })

  it('排练保鲜:被检索过的同龄同分记忆打分更高(AC5)', async () => {
    const { db, timeline } = await setup()
    await insertMemories(db, [
      mem('accessed', { createdAt: '2026-09-11T00:00:00Z', importance: 5 }),
      mem('dormant', { createdAt: '2026-09-11T00:00:00Z', importance: 5 }),
    ])
    await recordAccess(db, ['accessed'], SIM_NOW)
    const selected = await retrieveForPrompt(db, 'ada', timeline, situation(),
      config({ recentFloor: 0 as never, topK: 1, summaryFloorPerLevel: 0 }))
    expect(selected.map((m) => m.id)).toEqual(['accessed'])
  })
})

describe('situationalScore(F2 legacy 回退)', () => {
  const legacy = mem('legacy', { createdAt: SIM_NOW, content: '在 Cafe 听 Bo 讲起葬礼的事' })
  it('无标注旧记忆:姓名子串命中 + 地点子串命中', () => {
    const s = situationalScore(legacy, situation({ presentPersonNames: ['Bo'], locationName: 'Cafe' }))
    expect(s).toBeCloseTo(1.6)
  })
  it('有标注记忆不走子串:mentions 未命中则人物分 0', () => {
    const annotated = mem('ann', { createdAt: SIM_NOW, content: '听 Bo 讲起', mentionedPersonIdsJson: '["ada"]' })
    const s = situationalScore(annotated, situation({ presentPersonIds: ['bo'], presentPersonNames: ['Bo'] }))
    expect(s).toBe(0)
  })
  it('主题词命中情境文本 +0.4', () => {
    const topical = mem('top', { createdAt: SIM_NOW, topicsJson: '["葬礼"]' })
    const s = situationalScore(topical, situation({ situationText: '村里在办葬礼' }))
    expect(s).toBeCloseTo(0.4)
  })
})

describe('snapshot 分叉双源(D6:冻结证据 + 本线 SQL)', () => {
  it('继承集只来自冻结证据;快照外的主线行不可见,本线新记忆参与打分', async () => {
    const { db } = await setup()
    const frozen = mem('snap-keep', { createdAt: '2026-09-01T00:00:00Z', importance: 9,
      content: '冻结的关键记忆' })
    const snapshot = {
      version: 1, sourceTimelineId: 'home-main', sourceSimTime: '2026-09-15T00:00:00Z',
      capturedAt: '2026-09-15T00:00:00Z', ancestorCutoffs: [],
      states: [], schedules: [], memories: [frozen], events: [], commitments: [], historyComplete: true,
    }
    await db.insert(timelines).values({ id: 'fork-snap', worldId: 'home-world', parentTimelineId: 'home-main',
      simNow: SIM_NOW, createdAt: '2026-09-15T00:00:00Z', status: 'active',
      forkSnapshotJson: JSON.stringify(snapshot) })
    await insertMemories(db, [
      frozen, // 冻结证据对应的源行(存在于库中,但继承只走快照)
      mem('main-not-in-snapshot', { createdAt: '2026-09-20T00:00:00Z', importance: 10 }),
      mem('fork-own', { createdAt: '2026-09-16T00:00:00Z', timelineId: 'fork-snap', importance: 6 }),
    ])
    const fork = await db.select().from(timelines).where(eq(timelines.id, 'fork-snap')).get()
    const selected = await retrieveForPrompt(db, 'ada', fork!, situation(), config({ summaryFloorPerLevel: 0 }))
    const ids = selected.map((m) => m.id)
    expect(ids).toContain('snap-keep')
    expect(ids).toContain('fork-own')
    expect(ids).not.toContain('main-not-in-snapshot')
  })
})

describe('relationMemories 双路径(S1:mentions 优先,无标注回退姓名子串)', () => {
  it('mentions 命中(内容无名字)与 legacy 子串命中都进入关系记忆', async () => {
    const { db } = await setup()
    await db.insert(personStates).values([
      { personId: 'ada', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe',
        activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME },
      { personId: 'bo', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Library',
        activity: 'Reading', mood: 'Calm', goal: 'Read', updatedRealAt: WORLD_TIME },
    ])
    await insertMemories(db, [
      mem('mentions-only', { createdAt: '2026-09-20T00:00:00Z', type: 'relationship',
        content: '那把伞还在我柜子里', mentionedPersonIdsJson: '["bo"]', importance: 8 }),
      mem('legacy-name', { createdAt: '2026-09-19T00:00:00Z', type: 'relationship',
        content: 'Bo 在雨夜借给我半把伞', importance: 8 }),
    ])
    const snapshot = await buildWorldSnapshot(db, 'home-world', 'home-main')
    const ctx = await buildEngineContext(db, 'ada', snapshot!)
    const bo = ctx?.others.find((o) => o.person.id === 'bo')
    expect(bo?.relationMemories).toContain('那把伞还在我柜子里')
    expect(bo?.relationMemories).toContain('Bo 在雨夜借给我半把伞')
  })
})
