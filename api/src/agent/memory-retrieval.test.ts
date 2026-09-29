import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { memories, memoryAccess, persons, timelines, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
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
    mentionedPersonIdsJson: null, locationName: null, topicsJson: null, ...over,
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
    const selected = await retrieveForPrompt(db, 'ada', timeline, situation(), config({ recentFloor: 1, topK: 1, summaryK: 0 }))
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
      config({ w2: 1, recentFloor: 0, topK: 1, summaryK: 0 }))
    // w2=1 时情境分足以翻盘;验证打分排序取 top-1
    expect(selected[selected.length - 1]!.id).toBe('mentions-5')
  })

  it('候选限量上界:candidateImportant=3 时第 4 重要记忆不可达', async () => {
    const { db, timeline } = await setup()
    const list = Array.from({ length: 20 }, (_, i) =>
      mem(`m${i}`, { createdAt: `2026-09-${String(10 + (i % 9)).padStart(2, '0')}T00:00:00Z`, importance: i + 1 }))
    await insertMemories(db, list)
    const selected = await retrieveForPrompt(db, 'ada', timeline, situation(),
      config({ candidateRecent: 3, candidateImportant: 3, candidateAnnotated: 0 as never, summaryK: 0, recentFloor: 1, topK: 15 }))
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
    const selected = await retrieveForPrompt(db, 'ada', timeline, situation(), config({ summaryK: 0 }))
    const ids = selected.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['b', 'a', 'c'])
  })

  it('summary 保底:最新 summaryK 条摘要入选', async () => {
    const { db, timeline } = await setup()
    await insertMemories(db, [
      mem('s1', { createdAt: '2026-09-10T00:00:00Z', type: 'summary' }),
      mem('s2', { createdAt: '2026-09-18T00:00:00Z', type: 'summary' }),
      mem('x', { createdAt: '2026-09-21T01:00:00Z', importance: 1 }),
    ])
    const selected = await retrieveForPrompt(db, 'ada', timeline, situation(), config({ recentFloor: 1, topK: 1, summaryK: 1 }))
    expect(selected.map((m) => m.id)).toContain('s2')
    expect(selected.map((m) => m.id)).not.toContain('s1')
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
      config({ recentFloor: 0 as never, topK: 1, summaryK: 0 }))
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
