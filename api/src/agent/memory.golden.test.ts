import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { memories, persons, timelines, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { retrieveForPrompt, type Memory, type Situation } from './memory'
import { retrievalConfig, type RetrievalConfig } from './retrieval-config'

/**
 * S1 检索质量基线(F6):六个 golden 场景。
 * SIM_NOW = 2026-09-21T08:00Z;halfLife 72h;默认权重 w1=1 w2=2 w3=1。
 * 配置取自环境变量(N6/AC10):RETRIEVAL_* 可直接作用于本文件,如
 * `RETRIEVAL_W3=0 vitest run src/agent/memory.golden.test.ts` 应使三个 AC3 场景失败。
 */

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

const SIM_NOW = WORLD_TIME

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
    mentionedPersonIdsJson: null, locationName: null, topicsJson: null, level: null, ...over,
  }
}

function situation(over: Partial<Situation> = {}): Situation {
  return { presentPersonIds: [], presentPersonNames: [], locationName: null, situationText: '', ...over }
}

/** 环境变量可覆盖的 golden 配置(AC10 证据入口) */
function envConfig(): RetrievalConfig {
  return retrievalConfig(process.env)
}

/** 强干扰:新近 + 高重要性(打分的双料高分) */
function strongDistractors(n: number, startHour: number): Memory[] {
  return Array.from({ length: n }, (_, i) => mem(`strong-${i}`, {
    createdAt: new Date(Date.parse(SIM_NOW) - (startHour + i) * 3.6e6).toISOString(),
    importance: 9,
  }))
}

/** 中等干扰:两周前 + 重要性 7(衰减后仅重要性分 1.4 左右) */
function midDistractors(n: number): Memory[] {
  return Array.from({ length: n }, (_, i) => mem(`mid-${i}`, {
    createdAt: new Date(Date.parse(SIM_NOW) - (336 + i) * 3.6e6).toISOString(),
    importance: 7,
  }))
}

const OLD = '2026-06-01T00:00:00Z' // 112 天前,新近度分衰减殆尽(≈200+ 拍)

/** 场景播种:目标记忆 + 5 强干扰 + 15 中干扰(目标既不在近 5,重要性也在 top15 之外) */
async function seed(db: Awaited<ReturnType<typeof setup>>['db'], target: Memory) {
  await db.insert(memories).values([target, ...strongDistractors(5, 1), ...midDistractors(15)])
}

describe('golden 场景(S1 F6 检索质量基线)', () => {
  it('重逢故人:200+ 拍前的关系记忆在对方在场时进入选中集(AC3)', async () => {
    const target = () => mem('old-bo-memory', { createdAt: OLD, importance: 6, type: 'relationship',
      content: 'Bo 在雨夜借给我半把伞', mentionedPersonIdsJson: '["bo"]' })
    // 对照(独立库):不在场时进不了选中集(独立库避免排练刷新互相污染)
    let run = await setup()
    await seed(run.db, target())
    const control = await retrieveForPrompt(run.db, 'ada', run.timeline, situation(), envConfig())
    expect(control.map((m) => m.id)).not.toContain('old-bo-memory')
    fixture!.close(); fixture = null
    run = await setup()
    await seed(run.db, target())
    const selected = await retrieveForPrompt(run.db, 'ada', run.timeline,
      situation({ presentPersonIds: ['bo'], presentPersonNames: ['Bo'] }), envConfig())
    expect(selected.map((m) => m.id)).toContain('old-bo-memory')
  })

  it('故地重游:老地点记忆在回到该地点时进入选中集(AC3)', async () => {
    const target = () => mem('old-library-memory', { createdAt: OLD, importance: 6,
      content: '在 Library 的阁楼发现一沓旧信', locationName: 'Library' })
    let run = await setup()
    await seed(run.db, target())
    const control = await retrieveForPrompt(run.db, 'ada', run.timeline, situation({ locationName: 'Cafe' }), envConfig())
    expect(control.map((m) => m.id)).not.toContain('old-library-memory')
    fixture!.close(); fixture = null
    run = await setup()
    await seed(run.db, target())
    const selected = await retrieveForPrompt(run.db, 'ada', run.timeline, situation({ locationName: 'Library' }), envConfig())
    expect(selected.map((m) => m.id)).toContain('old-library-memory')
  })

  it('主题重提:主题词命中情境文本的老记忆进入选中集(AC3)', async () => {
    const target = () => mem('old-funeral-memory', { createdAt: OLD, importance: 6,
      content: '山上那户人家在办葬礼,白幡挂了三天', topicsJson: '["葬礼"]' })
    let run = await setup()
    await seed(run.db, target())
    const control = await retrieveForPrompt(run.db, 'ada', run.timeline, situation({ situationText: '今天天气晴朗' }), envConfig())
    expect(control.map((m) => m.id)).not.toContain('old-funeral-memory')
    fixture!.close(); fixture = null
    run = await setup()
    await seed(run.db, target())
    const selected = await retrieveForPrompt(run.db, 'ada', run.timeline,
      situation({ situationText: '村口又响起了葬礼的唢呐' }), envConfig())
    expect(selected.map((m) => m.id)).toContain('old-funeral-memory')
  })

  it('新近保底:刚发生的 1 分事件不丢失(AC6)', async () => {
    const { db, timeline } = await setup()
    const fresh = mem('fresh-trivial', { createdAt: new Date(Date.parse(SIM_NOW) - 3.6e6).toISOString(),
      importance: 1 })
    await db.insert(memories).values([...strongDistractors(10, 2), fresh])
    const selected = await retrieveForPrompt(db, 'ada', timeline, situation())
    expect(selected.map((m) => m.id)).toContain('fresh-trivial')
  })

  it('琐事不挤占:30 条低分新记忆后 9 分关键记忆仍在(AC6)', async () => {
    const { db, timeline } = await setup()
    const trivia = Array.from({ length: 30 }, (_, i) => mem(`trivia-${i}`, {
      createdAt: new Date(Date.parse(SIM_NOW) - i * 3.6e6).toISOString(), importance: 3,
    }))
    const key = mem('key-relationship', { createdAt: '2026-09-07T00:00:00Z', importance: 9,
      type: 'relationship', content: 'Bo 把地窖钥匙托付给了我' })
    await db.insert(memories).values([...trivia, key])
    const selected = await retrieveForPrompt(db, 'ada', timeline, situation())
    expect(selected.map((m) => m.id)).toContain('key-relationship')
  })

  it('可见性水位:分叉检索不出现 cutoff 之后的条目(AC8)', async () => {
    const { db } = await setup()
    const FORK_AT = '2026-09-15T00:00:00Z'
    await db.insert(timelines).values({ id: 'fork-1', worldId: 'home-world', parentTimelineId: 'home-main',
      simNow: SIM_NOW, createdAt: FORK_AT, status: 'active' })
    await db.insert(memories).values([
      mem('main-before', { createdAt: '2026-09-10T00:00:00Z', importance: 9 }),
      mem('main-after', { createdAt: '2026-09-18T00:00:00Z', importance: 10 }),
      mem('null-before', { createdAt: '2026-09-10T00:00:00Z', timelineId: null, importance: 9 }),
      mem('null-after', { createdAt: '2026-09-18T00:00:00Z', timelineId: null, importance: 10 }),
      mem('fork-own', { createdAt: '2026-09-16T00:00:00Z', timelineId: 'fork-1', importance: 6 }),
    ])
    const fork = await db.select().from(timelines).where(eq(timelines.id, 'fork-1')).get()
    const selected = await retrieveForPrompt(db, 'ada', fork!, situation())
    const ids = selected.map((m) => m.id)
    expect(ids).toContain('main-before')
    expect(ids).toContain('null-before')
    expect(ids).toContain('fork-own')
    expect(ids).not.toContain('main-after')
    expect(ids).not.toContain('null-after')
  })
})
