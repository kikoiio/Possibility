import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { memories, persons, timelines, universeRevisions, worldCommands, worldFacts, worldModelVersions, worldPersons } from '../db/schema'
import { createRootProjectionBaseline } from './model'
import { commitWorldCommand } from './commit'
import { checkMoment, historyRange, versionAtTime } from './reconstruct'
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

  it('基线不完整且无锚点:earliest = null;有锚点 → 首锚点时刻', async () => {
    fixture = await createWorldFixture()
    const db = fixture.db
    await db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
      modelJson: JSON.stringify({ name: 'Legacy', projectionBaseline: null }) })
    await db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME, worldModelVersion: 1, updatedAt: WORLD_TIME })
    expect((await historyRange(db, 'home-world', 'home-main'))?.earliest).toBeNull()
    const timeline = (await db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())!
    await captureDailyAnchor(db, timeline, WORLD_TIME)
    expect((await historyRange(db, 'home-world', 'home-main'))?.earliest).toBe(WORLD_TIME)
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

  it('NULL 桶主线:历史时刻拒绝,当前时刻仍可', async () => {
    await setupCompleteWorld(true)
    expect(await checkMoment(fixture!.db, 'home-world', 'home-main', T1))
      .toMatchObject({ ok: false, reasonCode: 'before_history_start' })
    expect(await checkMoment(fixture!.db, 'home-world', 'home-main', T3)).toEqual({ ok: true, effectiveMoment: T3 })
  })
})
