import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { memories, persons, timelines, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import {
  aggregateImportance, needsCompression, oldestCompressible, summaryLevel, type Memory,
} from './memory'

/** S2 T2:层级推导、重要性聚合与按源层级泛化的压缩查询 */

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

async function setup() {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values([
    { id: 'ada', userId: 'owner', name: 'Ada', modelJson: '{}', createdAt: WORLD_TIME },
  ])
  await fixture.db.insert(worldPersons).values([
    { worldId: 'home-world', personId: 'ada', joinedAt: WORLD_TIME },
  ])
  const timeline = await fixture.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get()
  return { db: fixture.db, timeline: timeline! }
}

function mem(id: string, over: Partial<Memory> & { createdAt: string }): Memory {
  return {
    id, personId: 'ada', timelineId: 'home-main', type: 'timeline', content: id,
    simTime: over.createdAt, importance: 5, summarized: false,
    mentionedPersonIdsJson: null, locationName: null, topicsJson: null, level: null, ...over,
  }
}

describe('summaryLevel(S2 D6 唯一推导点)', () => {
  it('显式 level 优先;缺 level 时 summary 推导为 L1,原文为 null', () => {
    expect(summaryLevel({ type: 'summary', level: 2 })).toBe(2)
    expect(summaryLevel({ type: 'summary', level: 1 })).toBe(1)
    expect(summaryLevel({ type: 'summary', level: null })).toBe(1)
    expect(summaryLevel({ type: 'summary' })).toBe(1)
    expect(summaryLevel({ type: 'timeline', level: null })).toBeNull()
    expect(summaryLevel({ type: 'timeline' })).toBeNull()
  })
  it('非法 level 不推导为层级', () => {
    expect(summaryLevel({ type: 'summary', level: 3 })).toBeNull()
  })
})

describe('aggregateImportance(S2 F4 折中聚合)', () => {
  it('29 条 3 分 + 1 条 9 分 → 6(AC4)', () => {
    const sources = [...Array.from({ length: 29 }, () => ({ importance: 3 })), { importance: 9 }]
    expect(aggregateImportance(sources)).toBe(6)
  })
  it('极值钳制到 1-10;单条即其自身', () => {
    expect(aggregateImportance([{ importance: 10 }, { importance: 10 }])).toBe(10)
    expect(aggregateImportance([{ importance: 1 }, { importance: 1 }])).toBe(1)
    expect(aggregateImportance([{ importance: 7 }])).toBe(7)
    expect(aggregateImportance([])).toBe(5)
  })
})

describe('needsCompression / oldestCompressible(S2 按源层级泛化)', () => {
  it('源层级 0=原文:与旧 needsSummary 同语义(摘要不计入)', async () => {
    const { db, timeline } = await setup()
    await db.insert(memories).values([
      mem('r1', { createdAt: '2026-09-20T00:00:00Z' }),
      mem('r2', { createdAt: '2026-09-20T01:00:00Z' }),
      mem('s1', { createdAt: '2026-09-20T02:00:00Z', type: 'summary', level: 1 }),
    ])
    expect(await needsCompression(db, 'ada', timeline, 0, 1)).toBe(true)
    expect(await needsCompression(db, 'ada', timeline, 0, 2)).toBe(false)
    const batch = await oldestCompressible(db, 'ada', timeline, 0, 5)
    expect(batch.map((m) => m.id)).toEqual(['r1', 'r2'])
  })

  it('源层级 1=未上卷 L1:只数 L1 摘要,原文与已上卷者不计入', async () => {
    const { db, timeline } = await setup()
    await db.insert(memories).values([
      mem('r1', { createdAt: '2026-09-19T00:00:00Z' }),
      mem('l1-a', { createdAt: '2026-09-20T00:00:00Z', type: 'summary', level: 1 }),
      mem('l1-b', { createdAt: '2026-09-20T01:00:00Z', type: 'summary', level: 1 }),
      mem('l1-rolled', { createdAt: '2026-09-20T02:00:00Z', type: 'summary', level: 1, summarized: true }),
      mem('l2', { createdAt: '2026-09-20T03:00:00Z', type: 'summary', level: 2 }),
    ])
    expect(await needsCompression(db, 'ada', timeline, 1, 1)).toBe(true)
    expect(await needsCompression(db, 'ada', timeline, 1, 2)).toBe(false)
    const batch = await oldestCompressible(db, 'ada', timeline, 1, 5)
    expect(batch.map((m) => m.id)).toEqual(['l1-a', 'l1-b'])
  })

  it('桶隔离:分叉桶的原文不参与主线桶计数(沿用旧语义)', async () => {
    const { db, timeline } = await setup()
    await db.insert(timelines).values({ id: 'fork-1', worldId: 'home-world', parentTimelineId: 'home-main',
      simNow: WORLD_TIME, createdAt: '2026-09-15T00:00:00Z', status: 'active' })
    await db.insert(memories).values([
      mem('fork-r1', { createdAt: '2026-09-20T00:00:00Z', timelineId: 'fork-1' }),
      mem('fork-r2', { createdAt: '2026-09-20T01:00:00Z', timelineId: 'fork-1' }),
    ])
    expect(await needsCompression(db, 'ada', timeline, 0, 1)).toBe(false)
    const fork = await db.select().from(timelines).where(eq(timelines.id, 'fork-1')).get()
    expect(await needsCompression(db, 'ada', fork!, 0, 1)).toBe(true)
  })
})
