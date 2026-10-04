import { afterEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { events, memories, persons, personStates, timelines, universeRevisions, voxelEventProjections, worldCommands, worldFacts, worldModelVersions, worldPersons, worlds } from '../db/schema'
import { createRootProjectionBaseline } from '../world-state/model'
import { commitWorldCommand } from '../world-state/commit'
import type { WorldAction } from '../world-state/types'
import { WorldStateError } from '../world-state/types'
import { captureDailyAnchor } from '../world-state/anchors'
import { auditUniverse } from '../world-state/invariants'
import { readForkSnapshot } from '../agent/visibility'
import { hydrateTimelines } from './snapshot-store'
import { forkTimeline } from './fork'
import { prepareForkAction } from './fork-action'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

const T1 = '2026-09-21T09:00:00.000Z'
const T2 = '2026-09-21T10:00:00.000Z'
const T3 = '2026-09-21T11:00:00.000Z'

const SCENARIO = { whatIf: '如果那天没有下雨', startTime: T2, changedVariable: '天气', participants: [], invariants: [] }

/** 完整基线 + 居民 + v1..v5(停在 T2),随后 v6..v10 推进到 T3 并做记忆维护/倒日期写入。 */
async function buildWorld(options: { anchor?: boolean } = {}) {
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
  await commit('cmd-clock2', { type: 'clock_advance', from: T1, to: T2, observedAt: T2 }, 'system')
  if (options.anchor !== false) {
    const timelineRow = (await db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())!
    await captureDailyAnchor(db, timelineRow)
  }
  // T2 之后:推进 + 维护 + 倒日期写入(不应泄漏进 T2 分叉)
  await commit('cmd-clock3', { type: 'clock_advance', from: T2, to: T3, observedAt: T3 }, 'system')
  const rowOf = async (id: string) => (await db.select().from(memories).where(eq(memories.id, id)).get())!
  const beforeOf = (row: typeof memories.$inferSelect) => ({ type: row.type, content: row.content,
    importance: row.importance, simTime: row.simTime, createdAt: row.createdAt, summarized: row.summarized })
  const rowA = await rowOf('cmd-s1:memory:0')
  const rowB = await rowOf('cmd-s1:memory:1')
  const rowC = await rowOf('cmd-s2:memory:0')
  await commit('cmd-correct', { type: 'memory_correct', memoryId: rowA.id, personId: 'resident',
    before: beforeOf(rowA), after: { content: 'mA corrected', importance: 7 } })
  await commit('cmd-forget', { type: 'memory_forget', memoryId: rowB.id, personId: 'resident', before: beforeOf(rowB) })
  await commit('cmd-summary', { type: 'memory_summary', personId: 'resident', sourceMemoryIds: [rowC.id],
    summaryId: 'sum-1', content: '一段压缩后的摘要', importance: 6,
    simTime: rowC.simTime ?? rowC.createdAt, createdAt: rowC.createdAt }, 'system')
  await commit('cmd-s3', { type: 'resident_state', personId: 'resident', cause: 'beat', windowStart: T1,
    patch: { activity: 'Resting' },
    events: [{ simTime: T1, title: '补记的旧经历', description: '倒日期写入,不属于 T2。' }], memories: [] }, 'system')
  return { db }
}

describe('forkTimeline 历史分叉(AC6)', () => {
  for (const anchor of [true, false]) {
    it(`历史时刻分叉成功(${anchor ? '锚点路径' : '全量回放'}):子线冻结在 T2,不含之后的历史`, async () => {
      const { db } = await buildWorld({ anchor })
      const fork = await forkTimeline(db, 'home-world', 'home-main', SCENARIO, 'req-historical-1')
      expect(fork.simNow).toBe(T2)
      const child = (await hydrateTimelines(db,
        await db.select().from(timelines).where(eq(timelines.id, fork.id))))[0]
      expect(child).toMatchObject({ parentTimelineId: 'home-main', simNow: T2, status: 'active' })
      // 快照(经 readForkSnapshot 校验放行 reconstruction 字段)
      const snapshot = readForkSnapshot(child)!
      expect(snapshot.sourceSimTime).toBe(T2)
      expect(snapshot.sourceStateVersion).toBe(4)
      expect(snapshot.reconstruction).toMatchObject({
        source: anchor ? 'anchor_replay' : 'full_replay', throughVersion: 4, invertedMaintenance: anchor ? 3 : 0 })
      expect(snapshot.historyComplete).toBe(true)
      // 可见历史截至 T2:倒日期补记与维护产物不得出现
      const eventIds = snapshot.events.map((event) => event.id)
      expect(eventIds).not.toContain('cmd-s3:story:0')
      const memoryIds = snapshot.memories.map((memory) => memory.id)
      expect(memoryIds).not.toContain('sum-1')
      const memoryById = new Map(snapshot.memories.map((memory) => [memory.id, memory]))
      expect(memoryById.get('cmd-s1:memory:0')).toMatchObject({ content: 'mA original', importance: 5 })
      expect(memoryById.get('cmd-s1:memory:1')).toMatchObject({ content: 'mB note' })
      expect(memoryById.get('cmd-s2:memory:0')).toMatchObject({ summarized: false })
      // 子线实况行:状态/日程已物化,创建水位 0
      const childStates = await db.select().from(personStates).where(eq(personStates.timelineId, fork.id))
      expect(childStates).toHaveLength(1)
      expect(childStates[0]).toMatchObject({ personId: 'resident', activity: 'Walking', mood: 'Happy' })
      // 源线不变:修订在推进后的版本,记忆维护结果保留
      expect(await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())
        .toMatchObject({ version: 9, simTime: T3 })
      expect((await db.select().from(memories).where(eq(memories.id, 'cmd-s1:memory:0')).get())?.content)
        .toBe('mA corrected')
      // 子线可审计:分叉基线完整,零命令回放零差异
      expect(await auditUniverse(db, 'home-world', fork.id)).toEqual([])
    })
  }
})

describe('forkTimeline 体素事件投影物化(S4/AC4)', () => {
  const VOXEL_ROW = (id: string, createdVersion: number) => ({
    id, timelineId: 'home-main',
    payloadJson: JSON.stringify({ event: { id }, sourceEventIds: [`src-${id}`], copySource: 'llm' }),
    createdVersion,
  })

  it('历史分叉:水位 ≤V 的投影物化给子线(id 重命名/水位 0),V 之后的不带过去', async () => {
    const { db } = await buildWorld()
    await db.insert(voxelEventProjections).values([
      VOXEL_ROW('vep:home-main:dlg:d1', 2),   // ≤ throughVersion(4)
      VOXEL_ROW('vep:home-main:dlg:d2', 8),   // T2 之后才投影,不进历史分叉
    ])
    const fork = await forkTimeline(db, 'home-world', 'home-main', SCENARIO, 'req-voxel-historical')
    const childRows = await db.select().from(voxelEventProjections).where(eq(voxelEventProjections.timelineId, fork.id))
    expect(childRows).toHaveLength(1)
    expect(childRows[0]).toMatchObject({ id: `vep:${fork.id}:dlg:d1`, timelineId: fork.id, createdVersion: 0 })
    // llm 文案随物化保留(子线不重复烧调用)
    expect(JSON.parse(childRows[0].payloadJson)).toMatchObject({ copySource: 'llm' })
    // 源线行不受影响
    expect(await db.select().from(voxelEventProjections).where(eq(voxelEventProjections.timelineId, 'home-main')))
      .toHaveLength(2)
  })

  it('实况分叉(startTime = 源 simNow):源线全部投影物化给子线', async () => {
    const { db } = await buildWorld()
    await db.insert(voxelEventProjections).values([
      VOXEL_ROW('vep:home-main:dlg:d1', 2),
      VOXEL_ROW('vep:home-main:dlg:d2', 8),
    ])
    const fork = await forkTimeline(db, 'home-world', 'home-main', { ...SCENARIO, startTime: T3 }, 'req-voxel-live')
    expect(fork.simNow).toBe(T3)
    const childRows = await db.select().from(voxelEventProjections).where(eq(voxelEventProjections.timelineId, fork.id))
    expect(childRows.map(row => row.id).sort()).toEqual([`vep:${fork.id}:dlg:d1`, `vep:${fork.id}:dlg:d2`])
    expect(childRows.every(row => row.createdVersion === 0)).toBe(true)
  })
})

describe('forkTimeline 历史分叉(AC7 纪律)', () => {  it('起点之前/未来时刻 → 400 文案;NULL 桶主线 → 409 baseline_incomplete', async () => {
    const { db } = await buildWorld()
    const tooEarly = await forkTimeline(db, 'home-world', 'home-main',
      { ...SCENARIO, startTime: '2020-01-01T00:00:00.000Z' }).catch((error: unknown) => error)
    expect(tooEarly).toBeInstanceOf(WorldStateError)
    expect((tooEarly as WorldStateError).message).toContain('早于这条线可回溯的起点')
    expect((tooEarly as WorldStateError).status).toBe(400)
    const future = await forkTimeline(db, 'home-world', 'home-main',
      { ...SCENARIO, startTime: '2026-12-31T00:00:00.000Z' }).catch((error: unknown) => error)
    expect((future as WorldStateError).message).toContain('尚未发生')
    expect((future as WorldStateError).status).toBe(400)
    // NULL 桶主线:历史证据不可信,拒绝历史分叉(当前时刻仍由既有路径覆盖)
    await db.insert(memories).values({ id: 'legacy-null', personId: 'resident', timelineId: null,
      type: 'world', content: 'unlogged legacy', createdAt: WORLD_TIME, importance: 5 })
    const incomplete = await forkTimeline(db, 'home-world', 'home-main', SCENARIO).catch((error: unknown) => error)
    expect((incomplete as WorldStateError).message).toContain('历史证据不完整')
    expect((incomplete as WorldStateError).status).toBe(409)
  })

  it('requestId 重放同一条子线;活跃上限/未运行/归档源线拒绝不变', async () => {
    const { db } = await buildWorld()
    const first = await forkTimeline(db, 'home-world', 'home-main', SCENARIO, 'req-replay-1')
    const replayed = await forkTimeline(db, 'home-world', 'home-main', SCENARIO, 'req-replay-1')
    expect(replayed.id).toBe(first.id)
    expect(await db.select().from(timelines).where(eq(timelines.worldId, 'home-world'))).toHaveLength(2)
    // 活跃上限:home-main + 两条分叉 = 3,第三条拒绝
    await forkTimeline(db, 'home-world', 'home-main', { ...SCENARIO, whatIf: 'B' }, 'req-replay-2')
    const limited = await forkTimeline(db, 'home-world', 'home-main', { ...SCENARIO, whatIf: 'C' }, 'req-replay-3')
      .catch((error: unknown) => error)
    expect((limited as Error).message).toContain('活跃时间线已达上限')
  })

  it('未运行世界/归档源线:既有拒绝不变', async () => {
    const { db } = await buildWorld()
    await db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-main'))
    const archived = await forkTimeline(db, 'home-world', 'home-main', SCENARIO).catch((error: unknown) => error)
    expect((archived as Error).message).toContain('只能分叉活跃时间线')
  })

  it('F1: 子线起点动作与快照原子创建，版本从 1 开始且源线不变', async () => {
    const { db } = await buildWorld()
    const initialAction = prepareForkAction({ type: 'environment', location: 'Library', condition: 'weather', value: '晴朗' }, {
      recipientIds: new Set(['resident']), locationNames: new Set(['Cafe', 'Library']), sourceFacts: [],
      allowedTimelineIds: new Set(['home-main']), sourceTimelineId: 'home-main', forkPointVersion: 9,
    })
    const before = await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get()
    const result = await forkTimeline(db, 'home-world', 'home-main', { ...SCENARIO, startTime: T3, expectedSourceVersion: 9 },
      'f1-atomic-success', { expectedSourceVersion: 9, initialAction })
    expect(result.action).toMatchObject({ version: 1, summary: 'Library的天气已设为：晴朗' })
    expect(await db.select().from(timelines).where(eq(timelines.id, result.id)).get()).toBeDefined()
    expect(await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, result.id)).get())
      .toMatchObject({ version: 1, simTime: T3 })
    expect(await db.select().from(worldCommands).where(eq(worldCommands.id, result.action!.commandId)).get())
      .toMatchObject({ expectedVersion: 0, resultVersion: 1, type: 'environment', timelineId: result.id })
    expect(await db.select().from(worldFacts).where(eq(worldFacts.id, result.action!.factId)).get())
      .toMatchObject({ timelineId: result.id, version: 1, simTime: T3, visibility: 'world', factType: 'environment' })
    expect(await db.select().from(events).where(eq(events.id, `command:${result.action!.commandId}`)).get())
      .toMatchObject({ timelineId: result.id, createdVersion: 1, simTime: T3 })
    expect(await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get()).toEqual(before)

    const replay = await forkTimeline(db, 'home-world', 'home-main', { ...SCENARIO, startTime: T3, expectedSourceVersion: 9 },
      'f1-atomic-success', { expectedSourceVersion: 9, initialAction })
    expect(replay).toMatchObject({ id: result.id, action: result.action })
    expect(await db.select().from(timelines).where(eq(timelines.worldId, 'home-world'))).toHaveLength(2)
    const different = prepareForkAction({ type: 'environment', location: 'Library', condition: 'weather', value: '大雪' }, {
      recipientIds: new Set(['resident']), locationNames: new Set(['Cafe', 'Library']), sourceFacts: [],
      allowedTimelineIds: new Set(['home-main']), sourceTimelineId: 'home-main', forkPointVersion: 9,
    })
    await expect(forkTimeline(db, 'home-world', 'home-main', { ...SCENARIO, startTime: T3, expectedSourceVersion: 9 },
      'f1-atomic-success', { expectedSourceVersion: 9, initialAction: different })).rejects.toThrow('不同初始动作')
  })

  it('F1: 暂停世界只允许带动作的起点初始化；普通 fork 仍受运行门禁限制', async () => {
    const { db } = await buildWorld()
    await db.update(worlds).set({ status: 'paused' }).where(eq(worlds.id, 'home-world'))
    const initialAction = prepareForkAction({ type: 'inform', recipientId: 'resident', topic: '消息', content: '请到图书馆' }, {
      recipientIds: new Set(['resident']), locationNames: new Set(['Cafe', 'Library']), sourceFacts: [],
      allowedTimelineIds: new Set(['home-main']), sourceTimelineId: 'home-main', forkPointVersion: 9,
    })
    const fork = await forkTimeline(db, 'home-world', 'home-main', { ...SCENARIO, startTime: T3, expectedSourceVersion: 9 },
      'f1-paused-initialization', { expectedSourceVersion: 9, initialAction })
    expect(fork.action?.version).toBe(1)
    await expect(forkTimeline(db, 'home-world', 'home-main', { ...SCENARIO, startTime: T3 }, 'legacy-paused-fork'))
      .rejects.toThrow('世界已暂停')
    expect(await db.select().from(timelines).where(eq(timelines.worldId, 'home-world'))).toHaveLength(2)
  })

  it('F1: batch 写入失败会回滚子线和全部初始动作记录', async () => {
    const { db } = await buildWorld()
    await db.update(worlds).set({ status: 'paused' }).where(eq(worlds.id, 'home-world'))
    const beforeCommandCount = await db.select().from(worldCommands)
    const beforeFactCount = await db.select().from(worldFacts)
    const beforeEventCount = await db.select().from(events)
    await db.run(sql.raw(`CREATE TRIGGER fail_f1_action_event BEFORE INSERT ON events
      WHEN NEW.id LIKE 'command:fork:%:initial'
      BEGIN SELECT RAISE(ABORT, 'f1_event_failure'); END`))
    const initialAction = prepareForkAction({ type: 'environment', location: 'Library', condition: 'lighting', value: '明亮' }, {
      recipientIds: new Set(['resident']), locationNames: new Set(['Cafe', 'Library']), sourceFacts: [],
      allowedTimelineIds: new Set(['home-main']), sourceTimelineId: 'home-main', forkPointVersion: 9,
    })
    await expect(forkTimeline(db, 'home-world', 'home-main', { ...SCENARIO, startTime: T3, expectedSourceVersion: 9 },
      'f1-atomic-failure', { expectedSourceVersion: 9, initialAction })).rejects.toThrow('f1_event_failure')
    expect(await db.select().from(timelines).where(eq(timelines.worldId, 'home-world'))).toHaveLength(1)
    expect(await db.select().from(worldCommands)).toHaveLength(beforeCommandCount.length)
    expect(await db.select().from(worldFacts)).toHaveLength(beforeFactCount.length)
    expect(await db.select().from(events)).toHaveLength(beforeEventCount.length)
    expect((await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(9)
    expect((await db.select().from(worlds).where(eq(worlds.id, 'home-world')).get())?.status).toBe('paused')
  })
})
