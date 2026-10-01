import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { memories, persons, timelines, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { budgetFromEnv } from '../engine/budget'
import { summaryExecutor, type SummaryInput } from '../engine/steps/summary'
import type { AgentStep } from '../engine/steps/types'
import {
  needsCompression, oldestCompressible, retrieveForPrompt, type Memory, type Situation,
} from './memory'
import { DEFAULT_RETRIEVAL_CONFIG, type RetrievalConfig } from './retrieval-config'

/**
 * S2 分层摘要 golden(F8):五个场景。
 * 阈值取自环境变量(N6 证据入口):`MEMORY_SUMMARY_L2_THRESHOLD=2 vitest run
 * src/agent/memory-hierarchy.golden.test.ts` 应使场景一的上卷节奏可复现地提前。
 * 检索类断言一律分库运行(对照/场景各一座库),避免排练刷新互相污染(S1 教训)。
 */

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
  return { db: fixture.db, env: fixture.env, timeline: timeline! }
}

function mem(id: string, over: Partial<Memory> & { createdAt: string }): Memory {
  return {
    id, personId: 'ada', timelineId: 'home-main', type: 'timeline', content: `记忆 ${id}`,
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

function step(over: Partial<AgentStep> = {}): AgentStep {
  return { kind: 'summary', worldId: 'home-world', timelineId: 'home-main', personId: 'ada', priority: 5, ...over }
}

function actInput(s: AgentStep, batch: Memory[]): SummaryInput {
  return { step: s, snapshot: null as never, prompt: { system: '', user: '' },
    ctx: { person: { id: 'ada', name: 'Ada' } } as never, batch }
}

/** executor act 直驱压缩:取批 → act(LLM 输出钉死为 content) */
async function compress(db: Awaited<ReturnType<typeof setup>>['db'], env: Awaited<ReturnType<typeof setup>>['env'],
  timeline: Awaited<ReturnType<typeof setup>>['timeline'], level: 1 | 2, batchSize: number, content: string) {
  const batch = await oldestCompressible(db, 'ada', timeline, level - 1 as 0 | 1, batchSize)
  expect(batch.length).toBeGreaterThan(0)
  await summaryExecutor.act(db, env, actInput(step({ level, batchSize }), batch), { content })
  return batch
}

describe('golden 场景(S2 F8 分层摘要质量基线)', () => {
  it('分层上卷:原文→L1→L2 全链路,水位逐级对齐,上卷节奏随 env 阈值变化(AC3/N6)', async () => {
    const { db, env, timeline } = await setup()
    const cfg = budgetFromEnv(process.env)
    // 逐轮播种 30 条原文并压 L1,直到未上卷 L1 超 l2Threshold
    let round = 0
    while (!(await needsCompression(db, 'ada', timeline, 1, cfg.l2Threshold))) {
      round++
      const base = Date.parse('2026-08-01T00:00:00Z') + round * 86400_000
      await db.insert(memories).values(Array.from({ length: 30 }, (_, i) => mem(`r${round}-${i}`, {
        createdAt: new Date(base + i * 600_000).toISOString(), importance: 3 + (i % 5),
      })))
      expect(await needsCompression(db, 'ada', timeline, 0, cfg.summaryThreshold)).toBe(false)
      const batch = await compress(db, env, timeline, 1, cfg.l1Batch, `L1 摘要第 ${round} 轮`)
      // AC2:L1 行为不变——原文退出候选、写入时间对齐批次最新原文
      const latest = batch[batch.length - 1]!
      const l1 = (await db.select().from(memories).where(eq(memories.type, 'summary')).all())
        .find((m) => m.content === `L1 摘要第 ${round} 轮`)!
      expect(l1).toMatchObject({ level: 1, createdAt: latest.createdAt })
      expect((await db.select().from(memories).where(eq(memories.id, batch[0]!.id)).get())?.summarized).toBe(true)
    }
    // 上卷节奏钉死:默认 l2Threshold=10 → 11 轮;MEMORY_SUMMARY_L2_THRESHOLD=2 → 3 轮
    expect(round).toBe(cfg.l2Threshold + 1)
    // L2 上卷
    const l1Batch = await compress(db, env, timeline, 2, cfg.l2Batch, 'L2 周级摘要')
    const l2 = (await db.select().from(memories).where(eq(memories.level, 2)).all())[0]!
    const latestL1 = l1Batch[l1Batch.length - 1]!
    expect(l2).toMatchObject({ type: 'summary', level: 2, createdAt: latestL1.createdAt,
      simTime: latestL1.simTime ?? latestL1.createdAt })
    // 源 L1 退出检索候选;剩余未上卷 L1 仍在
    for (const source of l1Batch) {
      expect((await db.select().from(memories).where(eq(memories.id, source.id)).get())?.summarized).toBe(true)
    }
    const selected = await retrieveForPrompt(db, 'ada', timeline, situation())
    const ids = selected.map((m) => m.id)
    expect(ids).toContain(l2.id)
    for (const source of l1Batch) expect(ids).not.toContain(source.id)
  })

  it('L2 情境浮上:久远 L2 凭合并 mentions 命中在场人物进选中集(AC7)', async () => {
    const OLD = '2026-06-01T00:00:00Z'
    const target = () => mem('ancient-l2', { createdAt: OLD, type: 'summary', level: 2, importance: 6,
      content: '那年雨季,Bo 与我守着漏雨的屋檐修了三天', mentionedPersonIdsJson: '["bo"]' })
    const seedAll = async (db: Awaited<ReturnType<typeof setup>>['db']) => {
      await db.insert(memories).values([
        target(),
        // 更新的 L1/L2 占位:分层保底被它们占走,ancient-l2 只能靠情境分浮上
        mem('newer-l1', { createdAt: '2026-09-20T00:00:00Z', type: 'summary', level: 1, importance: 5 }),
        mem('newer-l2', { createdAt: '2026-09-19T00:00:00Z', type: 'summary', level: 2, importance: 5 }),
        // 强干扰:新近+重要性 9;中干扰:两周前+重要性 7
        ...Array.from({ length: 5 }, (_, i) => mem(`strong-${i}`, {
          createdAt: new Date(Date.parse(SIM_NOW) - (1 + i) * 3.6e6).toISOString(), importance: 9 })),
        ...Array.from({ length: 15 }, (_, i) => mem(`mid-${i}`, {
          createdAt: new Date(Date.parse(SIM_NOW) - (336 + i) * 3.6e6).toISOString(), importance: 7 })),
      ])
    }
    // 对照(独立库):Bo 不在场,ancient-l2 进不了候选池
    let run = await setup()
    await seedAll(run.db)
    const control = await retrieveForPrompt(run.db, 'ada', run.timeline, situation())
    expect(control.map((m) => m.id)).not.toContain('ancient-l2')
    fixture!.close(); fixture = null
    // 场景:Bo 在场,mentions 路把 ancient-l2 捞回候选并凭情境分入选
    run = await setup()
    await seedAll(run.db)
    const selected = await retrieveForPrompt(run.db, 'ada', run.timeline,
      situation({ presentPersonIds: ['bo'], presentPersonNames: ['Bo'] }))
    const ids = selected.map((m) => m.id)
    expect(ids).toContain('ancient-l2')
    expect(ids).toContain('newer-l1') // 分层保底:最新 L1
    expect(ids).toContain('newer-l2') // 分层保底:最新 L2
  })

  it('摘要不再霸占:29×3分+1×9分批次压出 6 分摘要,不居高分区前列亦不沉底(AC4)', async () => {
    const batch = () => [
      ...Array.from({ length: 29 }, (_, i) => mem(`trivia-${i}`, {
        createdAt: new Date(Date.parse('2026-09-10T00:00:00Z') + i * 600_000).toISOString(), importance: 3 })),
      mem('key-9', { createdAt: '2026-09-11T00:00:00Z', importance: 9 }),
    ]
    const distractors = () => [
      mem('fresh-9-a', { createdAt: new Date(Date.parse(SIM_NOW) - 3.6e6).toISOString(), importance: 9 }),
      mem('fresh-9-b', { createdAt: new Date(Date.parse(SIM_NOW) - 2 * 3.6e6).toISOString(), importance: 9 }),
      mem('fresh-1', { createdAt: new Date(Date.parse(SIM_NOW) - 3 * 3.6e6).toISOString(), importance: 1 }),
    ]
    // 库一:topK=2 时高分区前列被两条 9 分占据,6 分摘要挤不进去(旧 max 语义下它会并列 9 分且更新)
    let run = await setup()
    await run.db.insert(memories).values([...batch(), ...distractors()])
    await compress(run.db, run.env, run.timeline, 1, 30, '琐事与关键并存的一批')
    const summary = (await run.db.select().from(memories).where(eq(memories.type, 'summary')).all())[0]!
    expect(summary.importance).toBe(6)
    const topOnly = await retrieveForPrompt(run.db, 'ada', run.timeline, situation(),
      config({ recentFloor: 0 as never, topK: 2, summaryFloorPerLevel: 0 }))
    expect(topOnly.map((m) => m.id).sort()).toEqual(['fresh-9-a', 'fresh-9-b'])
    fixture!.close(); fixture = null
    // 库二:摘要凭打分入选(不沉底;打分 1.23 压过低分新记忆 fresh-1 的 1.16),非靠保底
    run = await setup()
    await run.db.insert(memories).values([...batch(), ...distractors()])
    await compress(run.db, run.env, run.timeline, 1, 30, '琐事与关键并存的一批')
    const selected = await retrieveForPrompt(run.db, 'ada', run.timeline, situation(),
      config({ recentFloor: 1, topK: 3, summaryFloorPerLevel: 0 }))
    const ids = selected.map((m) => m.id)
    expect(ids).toContain(summary.id)
    expect(ids).toContain('fresh-9-a')
    expect(ids).not.toContain('fresh-1')
  })

  it('旧摘要兼容:无 level 摘要按 L1 可读、可检索保底、可作为 L2 压缩源(AC1/N4)', async () => {
    const { db, env, timeline } = await setup()
    // 模拟迁移前的摘要行(level NULL):迁移会回填 level=1,此处验证缺层级推导路径
    await db.insert(memories).values([
      mem('legacy-s1', { createdAt: '2026-09-01T00:00:00Z', type: 'summary', level: null, importance: 5 }),
      mem('legacy-s2', { createdAt: '2026-09-02T00:00:00Z', type: 'summary', level: null, importance: 5 }),
      mem('fresh', { createdAt: '2026-09-21T01:00:00Z', importance: 1 }),
    ])
    // 可检索:legacy-s2 按 L1 推导进分层保底
    const selected = await retrieveForPrompt(db, 'ada', timeline, situation(),
      config({ recentFloor: 1, topK: 1, summaryFloorPerLevel: 1 }))
    expect(selected.map((m) => m.id)).toContain('legacy-s2')
    // 可上卷:两条遗留摘要计入 L2 源并压出 L2
    expect(await needsCompression(db, 'ada', timeline, 1, 1)).toBe(true)
    expect(await needsCompression(db, 'ada', timeline, 0, 1)).toBe(false) // 遗留摘要不混入原文池
    const batch = await compress(db, env, timeline, 2, 8, '遗留摘要上卷')
    expect(batch.map((m) => m.id)).toEqual(['legacy-s1', 'legacy-s2'])
    const l2 = (await db.select().from(memories).where(eq(memories.level, 2)).all())[0]!
    expect(l2).toMatchObject({ type: 'summary', level: 2, createdAt: '2026-09-02T00:00:00Z' })
  })

  it('可见性水位:分叉线上 L2 与源 L1 同见/同不见(AC7)', async () => {
    const { db } = await setup()
    const FORK_AT = '2026-09-15T00:00:00Z'
    await db.insert(timelines).values({ id: 'fork-wm', worldId: 'home-world', parentTimelineId: 'home-main',
      simNow: SIM_NOW, createdAt: FORK_AT, status: 'active' })
    await db.insert(memories).values([
      // 分叉前上卷的一对:L1 源与其 L2 同见
      mem('l1-before-a', { createdAt: '2026-09-10T00:00:00Z', type: 'summary', level: 1, summarized: true, importance: 4 }),
      mem('l1-before-b', { createdAt: '2026-09-11T00:00:00Z', type: 'summary', level: 1, summarized: true, importance: 6 }),
      mem('l2-before', { createdAt: '2026-09-11T00:00:00Z', type: 'summary', level: 2, importance: 5 }),
      // 分叉后上卷的一对:同不见
      mem('l1-after-a', { createdAt: '2026-09-18T00:00:00Z', type: 'summary', level: 1, summarized: true, importance: 4 }),
      mem('l1-after-b', { createdAt: '2026-09-19T00:00:00Z', type: 'summary', level: 1, summarized: true, importance: 6 }),
      mem('l2-after', { createdAt: '2026-09-19T00:00:00Z', type: 'summary', level: 2, importance: 5 }),
      mem('fork-own', { createdAt: '2026-09-16T00:00:00Z', timelineId: 'fork-wm', importance: 6 }),
    ])
    const fork = await db.select().from(timelines).where(eq(timelines.id, 'fork-wm')).get()
    const visible = await import('./memory').then((m) => m.visibleMemories(db, 'ada', fork!))
    const ids = visible.map((m) => m.id)
    // 同见:L2 写入时间对齐其批次最新 L1(09-11),分叉点(09-15)前 → 同在水位内
    expect(ids).toContain('l2-before')
    expect(ids).toContain('l1-before-a')
    expect(ids).toContain('l1-before-b')
    // 同不见:整批在水位外
    expect(ids).not.toContain('l2-after')
    expect(ids).not.toContain('l1-after-a')
    expect(ids).not.toContain('l1-after-b')
    expect(ids).toContain('fork-own')
  })
})
