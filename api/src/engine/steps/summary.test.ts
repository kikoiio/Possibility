import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { memories, persons, personStates, timelines, worldPersons } from '../../db/schema'
import { createWorldFixture, WORLD_TIME } from '../../test/world-fixture'
import { buildWorldSnapshot } from '../../agent/engine-context'
import type { Memory } from '../../agent/memory'
import { normalizeSummaryJson, summaryExecutor, type SummaryInput } from './summary'
import { mergeMemoryAnnotations } from './annotations'
import type { AgentStep } from './types'

/** S2 T10:压缩执行器分层——契约 v2、act 聚合/合并、perceive 按目标层取源 */

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

async function setup() {
  fixture = await createWorldFixture()
  const emptyModel = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [],
    relationships: [], boundaries: [], unknowns: [] })
  await fixture.db.insert(persons).values([
    { id: 'ada', userId: 'owner', name: 'Ada', modelJson: emptyModel, createdAt: WORLD_TIME },
    { id: 'bo', userId: 'owner', name: 'Bo', modelJson: emptyModel, createdAt: WORLD_TIME },
  ])
  await fixture.db.insert(worldPersons).values([
    { worldId: 'home-world', personId: 'ada', joinedAt: WORLD_TIME },
    { worldId: 'home-world', personId: 'bo', joinedAt: WORLD_TIME },
  ])
  await fixture.db.insert(personStates).values({ personId: 'ada', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Learn', updatedRealAt: WORLD_TIME })
  return { db: fixture.db, env: fixture.env }
}

function mem(id: string, over: Partial<Memory> & { createdAt: string }): Memory {
  return {
    id, personId: 'ada', timelineId: 'home-main', type: 'timeline', content: `记忆 ${id}`,
    simTime: over.createdAt, importance: 5, summarized: false,
    mentionedPersonIdsJson: null, locationName: null, topicsJson: null, level: null, createdVersion: null, ...over,
  }
}

function step(over: Partial<AgentStep> = {}): AgentStep {
  return { kind: 'summary', worldId: 'home-world', timelineId: 'home-main', personId: 'ada', priority: 5, ...over }
}

function actInput(db: Awaited<ReturnType<typeof setup>>['db'], s: AgentStep, batch: Memory[]): SummaryInput {
  void db
  return { step: s, snapshot: null as never, prompt: { system: '', user: '' },
    ctx: { person: { id: 'ada', name: 'Ada' } } as never, batch }
}

describe('normalizeSummaryJson(S2 契约 v2)', () => {
  it('只校验 content;importance 不再必需', () => {
    expect(normalizeSummaryJson({ content: '一段摘要' })).toEqual({ content: '一段摘要' })
    expect(normalizeSummaryJson({ content: '一段摘要', importance: 9 })).toEqual({ content: '一段摘要' })
    expect(() => normalizeSummaryJson({ importance: 9 })).toThrowError(/summary\/v2/)
    expect(() => normalizeSummaryJson(null)).toThrowError(/summary\/v2/)
  })
})

describe('summaryExecutor.act(S2 分层 act)', () => {
  it('L1:重要性=折中聚合(29×3+1×9 → 6),合并标注进负载,源标记退出', async () => {
    const { db, env } = await setup()
    const batch = [
      ...Array.from({ length: 29 }, (_, i) => mem(`raw-${i}`, {
        createdAt: `2026-09-19T${String(i % 24).padStart(2, '0')}:00:00Z`, importance: 3,
        ...(i === 0 ? { mentionedPersonIdsJson: '["bo"]', locationName: 'Cafe', topicsJson: '["葬礼"]' } : {}),
      })),
      mem('raw-key', { createdAt: '2026-09-20T00:00:00Z', importance: 9, topicsJson: '["葬礼","伞"]', locationName: 'Library' }),
    ]
    await db.insert(memories).values(batch)
    const report = await summaryExecutor.act(db, env, actInput(db, step({ level: 1, batchSize: 30 }), batch), { content: '一段 L1 摘要' })
    expect(report).toContain('L1')
    const rows = await db.select().from(memories).where(eq(memories.type, 'summary')).all()
    expect(rows).toHaveLength(1)
    // F4:折中取整 round((9 + 96/30)/2) = round(6.1) = 6;F5:合并标注
    expect(rows[0]).toMatchObject({ level: 1, importance: 6, mentionedPersonIdsJson: '["bo"]',
      locationName: 'Library', topicsJson: '["葬礼","伞"]', createdAt: '2026-09-20T00:00:00Z' })
    expect((await db.select().from(memories).where(eq(memories.id, 'raw-0')).get())?.summarized).toBe(true)
    expect((await db.select().from(memories).where(eq(memories.id, 'raw-key')).get())?.summarized).toBe(true)
  })

  it('L2:源为未上卷 L1,产物 level=2,水位对齐批次最新 L1', async () => {
    const { db, env } = await setup()
    const batch = [
      mem('l1-a', { createdAt: '2026-09-18T00:00:00Z', type: 'summary', level: 1, importance: 4, locationName: 'Cafe' }),
      mem('l1-b', { createdAt: '2026-09-19T00:00:00Z', type: 'summary', level: 1, importance: 8, locationName: 'Cafe' }),
    ]
    await db.insert(memories).values(batch)
    await summaryExecutor.act(db, env, actInput(db, step({ level: 2, batchSize: 8 }), batch), { content: '一段 L2 摘要' })
    const rows = await db.select().from(memories).where(eq(memories.level, 2)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'summary', level: 2, importance: 7, locationName: 'Cafe',
      createdAt: '2026-09-19T00:00:00Z' })
    expect((await db.select().from(memories).where(eq(memories.id, 'l1-a')).get())?.summarized).toBe(true)
  })
})

describe('summaryExecutor.perceive(S2 按目标层取源)', () => {
  it('level=1 取原文,level=2 只取未上卷 L1,batchSize 生效', async () => {
    const { db } = await setup()
    await db.insert(memories).values([
      mem('raw-1', { createdAt: '2026-09-19T00:00:00Z' }),
      mem('l1-a', { createdAt: '2026-09-19T01:00:00Z', type: 'summary', level: 1 }),
      mem('l1-b', { createdAt: '2026-09-19T02:00:00Z', type: 'summary', level: 1 }),
      mem('l1-c', { createdAt: '2026-09-19T03:00:00Z', type: 'summary', level: 1 }),
      mem('l1-rolled', { createdAt: '2026-09-19T04:00:00Z', type: 'summary', level: 1, summarized: true }),
    ])
    const snapshot = (await buildWorldSnapshot(db, 'home-world', 'home-main'))!
    const l1 = await summaryExecutor.perceive(db, step({ level: 1, batchSize: 30 }), snapshot)
    expect(l1?.batch.map((m) => m.id)).toEqual(['raw-1'])
    const l2 = await summaryExecutor.perceive(db, step({ level: 2, batchSize: 2 }), snapshot)
    expect(l2?.batch.map((m) => m.id)).toEqual(['l1-a', 'l1-b'])
  })
})

describe('mergeMemoryAnnotations 与 act 的衔接', () => {
  it('act 写入的标注与纯函数输出一致(无 LLM 参与)', async () => {
    const { db, env } = await setup()
    const batch = [
      mem('raw-a', { createdAt: '2026-09-19T00:00:00Z', mentionedPersonIdsJson: '["bo"]', topicsJson: '["伞"]' }),
      mem('raw-b', { createdAt: '2026-09-19T01:00:00Z', locationName: 'Library', topicsJson: '["伞"]' }),
    ]
    await db.insert(memories).values(batch)
    await summaryExecutor.act(db, env, actInput(db, step({ level: 1 }), batch), { content: '摘要' })
    const row = (await db.select().from(memories).where(eq(memories.type, 'summary')).all())[0]!
    const expected = mergeMemoryAnnotations(batch)
    expect(row?.mentionedPersonIdsJson).toBe(expected.mentions.length ? JSON.stringify(expected.mentions) : null)
    expect(row?.locationName).toBe(expected.location)
    expect(row?.topicsJson).toBe(JSON.stringify(expected.topics))
  })
})
