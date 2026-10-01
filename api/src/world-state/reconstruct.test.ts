import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { commitments, events, memories, persons, personStates, schedules, timelines, universeRevisions,
  worldCommands, worldFacts, worldModelVersions, worldPersons } from '../db/schema'
import { createRootProjectionBaseline } from './model'
import { commitWorldCommand } from './commit'
import type { WorldAction } from './types'
import { checkMoment, historyRange, reconstructAt, versionAtTime } from './reconstruct'
import { captureDailyAnchor } from './anchors'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

const T1 = '2026-09-21T09:00:00.000Z'
const T2 = '2026-09-21T10:00:00.000Z'
const T3 = '2026-09-21T11:00:00.000Z'
const FUTURE = '2026-09-22T00:00:00.000Z'

/** 完整钉住基线 + 三条 clock_advance 命令(T1/T2/T3),走正式命令通道以满足触发器 */
async function setupCompleteWorld(withNullBucket = false) {
  fixture = await createWorldFixture()
  const db = fixture.db
  const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [])
  await db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: '', locations: [], residents: [], projectionBaseline: baseline }) })
  await db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME, worldModelVersion: 1, updatedAt: WORLD_TIME })
  const times = [T1, T2, T3]
  for (let index = 0; index < 3; index++) {
    await commitWorldCommand(db, { id: `cmd${index + 1}`, worldId: 'home-world', timelineId: 'home-main',
      userId: 'owner', actorKind: 'system', expectedVersion: index,
      action: { type: 'clock_advance', from: index === 0 ? WORLD_TIME : times[index - 1], to: times[index], observedAt: times[index] } })
  }
  if (withNullBucket) {
    await db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'R', modelJson: '{}', createdAt: WORLD_TIME })
    await db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
    await db.insert(memories).values({ id: 'legacy-m', personId: 'resident', timelineId: null, type: 'event',
      content: 'legacy', simTime: T1, createdAt: WORLD_TIME, importance: 5 })
  }
}

describe('versionAtTime', () => {
  it('定位最后 simTime ≤ 目标时刻的版本', async () => {
    await setupCompleteWorld()
    expect(await versionAtTime(fixture!.db, 'home-main', T2)).toEqual({ version: 2, simTime: T2 })
    expect(await versionAtTime(fixture!.db, 'home-main', '2026-09-21T10:30:00.000Z')).toEqual({ version: 2, simTime: T2 })
    expect(await versionAtTime(fixture!.db, 'home-main', WORLD_TIME)).toBeNull()
  })
})

describe('historyRange', () => {
  it('基线完整且无 NULL 桶:earliest = 日志起点', async () => {
    await setupCompleteWorld()
    const range = await historyRange(fixture!.db, 'home-world', 'home-main')
    expect(range).toEqual({ earliest: WORLD_TIME, simNow: T3 })
  })

  it('主线存在 legacy NULL 记忆桶:earliest = null', async () => {
    await setupCompleteWorld(true)
    const range = await historyRange(fixture!.db, 'home-world', 'home-main')
    expect(range?.earliest).toBeNull()
  })

  it('基线不完整:earliest = null(锚点只封顶成本,不构成完整性证据)', async () => {
    fixture = await createWorldFixture()
    const db = fixture.db
    await db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
      modelJson: JSON.stringify({ name: 'Legacy', projectionBaseline: null }) })
    await db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME, worldModelVersion: 1, updatedAt: WORLD_TIME })
    expect((await historyRange(db, 'home-world', 'home-main'))?.earliest).toBeNull()
    const timeline = (await db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())!
    await captureDailyAnchor(db, timeline, WORLD_TIME)
    expect((await historyRange(db, 'home-world', 'home-main'))?.earliest).toBeNull()
  })

  it('时间线不存在返回 null', async () => {
    fixture = await createWorldFixture()
    expect(await historyRange(fixture.db, 'home-world', 'nope')).toBeNull()
  })
})

describe('checkMoment', () => {
  it('当前时刻永远可分叉(吸附即本身)', async () => {
    await setupCompleteWorld()
    expect(await checkMoment(fixture!.db, 'home-world', 'home-main', T3)).toEqual({ ok: true, effectiveMoment: T3 })
  })

  it('历史时刻吸附到最近 ≤T 的命令边界', async () => {
    await setupCompleteWorld()
    expect(await checkMoment(fixture!.db, 'home-world', 'home-main', '2026-09-21T10:30:00.000Z'))
      .toEqual({ ok: true, effectiveMoment: T2 })
  })

  it('基线时刻(V=0)可重建', async () => {
    await setupCompleteWorld()
    expect(await checkMoment(fixture!.db, 'home-world', 'home-main', WORLD_TIME))
      .toEqual({ ok: true, effectiveMoment: WORLD_TIME })
  })

  it('未来时刻 → future_time;起点之前 → before_history_start', async () => {
    await setupCompleteWorld()
    expect((await checkMoment(fixture!.db, 'home-world', 'home-main', FUTURE)).ok).toBe(false)
    expect((await checkMoment(fixture!.db, 'home-world', 'home-main', FUTURE)) as { reasonCode?: string })
      .toMatchObject({ reasonCode: 'future_time' })
    expect(await checkMoment(fixture!.db, 'home-world', 'home-main', '2026-09-20T00:00:00.000Z'))
      .toMatchObject({ ok: false, reasonCode: 'before_history_start' })
  })

  it('归档线 → timeline_not_active;不存在 → timeline_not_active', async () => {
    await setupCompleteWorld()
    await fixture!.db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-main'))
    expect(await checkMoment(fixture!.db, 'home-world', 'home-main', T1))
      .toMatchObject({ ok: false, reasonCode: 'timeline_not_active' })
    expect(await checkMoment(fixture!.db, 'home-world', 'ghost', T1))
      .toMatchObject({ ok: false, reasonCode: 'timeline_not_active' })
  })

  it('NULL 桶主线:历史时刻拒绝(baseline_incomplete),当前时刻仍可', async () => {
    await setupCompleteWorld(true)
    expect(await checkMoment(fixture!.db, 'home-world', 'home-main', T1))
      .toMatchObject({ ok: false, reasonCode: 'baseline_incomplete' })
    expect(await checkMoment(fixture!.db, 'home-world', 'home-main', T3)).toEqual({ ok: true, effectiveMoment: T3 })
  })
})

/* ---------- T6: reconstructAt 锚点路径 ---------- */

type Db = Awaited<ReturnType<typeof createWorldFixture>>['db']
type MemoryRow = typeof memories.$inferSelect

const beforeOf = (row: MemoryRow) => ({ type: row.type, content: row.content, importance: row.importance,
  simTime: row.simTime, createdAt: row.createdAt, summarized: row.summarized })

/** 完整基线 + 一名居民 + 五条 ≤T2 命令(v5 停在 T2),捕获日界锚点。 */
async function buildRichWorld() {
  fixture = await createWorldFixture()
  const db = fixture.db
  await db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Ada', modelJson: '{}', createdAt: WORLD_TIME })
  await db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  const state = { personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe',
    activity: 'Reading', mood: 'Calm', goal: 'Learn', updatedRealAt: WORLD_TIME,
    currentDialogueId: null, lastBeatSimTime: null }
  await db.insert(personStates).values(state)
  const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [state])
  await db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: '',
      locations: [{ name: 'Cafe', description: '' }, { name: 'Library', description: '' }],
      residents: [{ id: 'resident', name: 'Ada', model: {} }], projectionBaseline: baseline }) })
  await db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })
  let version = 0
  const commit = async (id: string, action: WorldAction, actorKind: 'owner' | 'system' = 'owner') => {
    const result = await commitWorldCommand(db, { id, worldId: 'home-world', timelineId: 'home-main',
      userId: 'owner', expectedVersion: version, action, actorKind })
    expect(result.version).toBe(++version)
    return result
  }
  await commit('cmd-clock1', { type: 'clock_advance', from: WORLD_TIME, to: T1, observedAt: T1 }, 'system')
  await commit('cmd-s1', { type: 'resident_state', personId: 'resident', cause: 'beat', windowStart: WORLD_TIME,
    patch: { activity: 'Walking' },
    events: [{ simTime: T1, title: '晨间散步', description: 'Ada 在 Cafe 散步。' }],
    memories: [{ type: 'thought', content: 'mA original', importance: 5 },
      { type: 'thought', content: 'mB note', importance: 4 }] }, 'system')
  await commit('cmd-s2', { type: 'resident_state', personId: 'resident', cause: 'beat', windowStart: T1,
    patch: { mood: 'Happy' }, events: [],
    memories: [{ type: 'thought', content: 'mC note', importance: 3 }] }, 'system')
  await commit('cmd-sched', { type: 'schedule_set', personId: 'resident', worldDate: '2026-09-21', generatedAt: T1,
    items: [{ start: '00:00', end: '08:00', location: 'Cafe', activity: 'Sleep', kind: 'sleep' },
      { start: '08:00', end: '10:00', location: 'Cafe', activity: 'Read' },
      { start: '10:00', end: '12:00', location: 'Cafe', activity: 'Write' },
      { start: '12:00', end: '14:00', location: 'Library', activity: 'Research' },
      { start: '14:00', end: '18:00', location: 'Cafe', activity: 'Discuss' },
      { start: '18:00', end: '00:00', location: 'Cafe', activity: 'Rest', kind: 'sleep' }] }, 'system')
  await commit('cmd-clock2', { type: 'clock_advance', from: T1, to: T2, observedAt: T2 }, 'system')
  const timelineRow = (await db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())!
  const anchor = await captureDailyAnchor(db, timelineRow)
  expect(anchor?.version).toBe(5)
  return { db, commit }
}

async function snapshotLive(db: Db) {
  const [states, scheduleRows, commitmentRows, memoryRows, eventRows, factRows] = await db.batch([
    db.select().from(personStates).where(eq(personStates.timelineId, 'home-main')),
    db.select().from(schedules).where(eq(schedules.timelineId, 'home-main')),
    db.select().from(commitments).where(eq(commitments.timelineId, 'home-main')),
    db.select().from(memories).where(eq(memories.timelineId, 'home-main')),
    db.select().from(events).where(eq(events.timelineId, 'home-main')),
    db.select().from(worldFacts).where(eq(worldFacts.timelineId, 'home-main')),
  ])
  return { states, schedules: scheduleRows, commitments: commitmentRows, memories: memoryRows, events: eventRows, facts: factRows }
}

const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id))
/** 记忆语义字段:逆放恢复的行 createdVersion 记 NULL(簿记不参与一致性) */
const semanticMemories = (rows: MemoryRow[]) => byId(rows).map(({ createdVersion, ...rest }) => rest)

describe('reconstructAt 锚点路径', () => {
  it('AC4: 重建与 T2 实况逐域一致——删除恢复/校正回滚/摘要复位/倒日期写入被版本水位隔离', async () => {
    const { db, commit } = await buildRichWorld()
    const truth = await snapshotLive(db)
    // 世界推进到 T3;随后:校正 mA、遗忘 mB、摘要 mC、写入一条倒日期(simTime=T1)经历
    await commit('cmd-clock3', { type: 'clock_advance', from: T2, to: T3, observedAt: T3 }, 'system')
    const rowA = (await db.select().from(memories).where(eq(memories.id, 'cmd-s1:memory:0')).get())!
    const rowB = (await db.select().from(memories).where(eq(memories.id, 'cmd-s1:memory:1')).get())!
    const rowC = (await db.select().from(memories).where(eq(memories.id, 'cmd-s2:memory:0')).get())!
    await commit('cmd-correct', { type: 'memory_correct', memoryId: rowA.id, personId: 'resident',
      before: beforeOf(rowA), after: { content: 'mA corrected', importance: 7 } })
    await commit('cmd-forget', { type: 'memory_forget', memoryId: rowB.id, personId: 'resident', before: beforeOf(rowB) })
    await commit('cmd-summary', { type: 'memory_summary', personId: 'resident', sourceMemoryIds: [rowC.id],
      summaryId: 'sum-1', content: '一段压缩后的摘要', importance: 6,
      simTime: rowC.simTime ?? rowC.createdAt, createdAt: rowC.createdAt }, 'system')
    await commit('cmd-s3', { type: 'resident_state', personId: 'resident', cause: 'beat', windowStart: T1,
      patch: { activity: 'Resting' },
      events: [{ simTime: T1, title: '补记的旧经历', description: '倒日期写入,不属于 T2。' }], memories: [] }, 'system')

    const result = await reconstructAt(db, 'home-world', 'home-main', T2)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.simTime).toBe(T2)
    expect(result.evidence).toMatchObject({ source: 'anchor_replay', throughVersion: 5, anchorVersion: 5,
      invertedMaintenance: 3 })
    // 核心域 = T2 实况(锚点 payload 即 T2 捕获)
    expect(result.rows.states).toEqual(truth.states)
    expect(result.rows.schedules).toEqual(truth.schedules)
    expect(result.rows.commitments).toEqual(truth.commitments)
    // 事件:与 T2 实况逐行一致;T2 之后的维护事件与倒日期事件不得出现
    expect(byId(result.rows.events)).toEqual(byId(truth.events))
    expect(result.rows.events.some((event) => event.id === 'cmd-s3:story:0')).toBe(false)
    // 记忆:mA 恢复原内容、mB 复活、mC 复位未摘要、sum-1 不存在
    expect(semanticMemories(result.rows.memories)).toEqual(semanticMemories(truth.memories))
    expect(result.rows.memories.some((memory) => memory.id === 'sum-1')).toBe(false)
    // 事实:版本水位 ≤5
    expect(byId(result.rows.worldFacts)).toEqual(byId(truth.facts))
    // 对话域为空(本场景无对话)
    expect(result.rows.dialogues).toEqual([])
    expect(result.rows.dialogueTurns).toEqual([])
    expect(result.rows.personaMessages).toEqual([])
  })

  it('AC5: 活表被非命令路径篡改 → integrity_mismatch,不产出状态', async () => {
    const { db, commit } = await buildRichWorld()
    // 推进到 T3,使维护命令落在 T2 之后——逆放监管链才会校验现行行
    await commit('cmd-clock3', { type: 'clock_advance', from: T2, to: T3, observedAt: T3 }, 'system')
    const rowA = (await db.select().from(memories).where(eq(memories.id, 'cmd-s1:memory:0')).get())!
    await commit('cmd-correct', { type: 'memory_correct', memoryId: rowA.id, personId: 'resident',
      before: beforeOf(rowA), after: { content: 'mA corrected', importance: 7 } })
    // 非命令路径直接改行:逆放校验 current == after 必然失败
    await db.update(memories).set({ content: 'tampered' }).where(eq(memories.id, rowA.id))
    const result = await reconstructAt(db, 'home-world', 'home-main', T2)
    expect(result).toMatchObject({ ok: false, reasonCode: 'integrity_mismatch' })
  })
})
