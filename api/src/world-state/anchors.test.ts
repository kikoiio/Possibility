import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../test/db'
import { commitments, persons, personStates, schedules, timelineAnchors, timelines, universeRevisions, users, worlds } from '../db/schema'
import { captureDailyAnchor, hashAnchorCore, latestAnchorAtOrBefore, parseAnchorCore } from './anchors'

const DAY1 = '2026-10-01T08:00:00.000Z'
const DAY2 = '2026-10-02T00:30:00.000Z'
let fixture: ReturnType<typeof createTestDb>

function stateOf(personId: string, timelineId: string, simTime: string) {
  return { personId, timelineId, simTime, location: '广场', activity: '散步', mood: '平静', goal: '探索', updatedRealAt: DAY1 }
}

beforeEach(async () => {
  fixture = createTestDb()
  const db = fixture.db
  await db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'x', createdAt: DAY1 })
  await db.insert(worlds).values({ id: 'w', userId: 'u', name: 'W', description: '' })
  await db.insert(persons).values([
    { id: 'p1', userId: 'u', name: '甲', modelJson: '{}', createdAt: DAY1 },
    { id: 'p2', userId: 'u', name: '乙', modelJson: '{}', createdAt: DAY1 },
  ])
  await db.insert(timelines).values({ id: 'main', worldId: 'w', simNow: DAY2, createdAt: DAY1 })
  await db.insert(universeRevisions).values({ timelineId: 'main', version: 42, simTime: DAY2, worldModelVersion: 3, updatedAt: DAY2 })
  await db.insert(personStates).values([stateOf('p1', 'main', DAY2), stateOf('p2', 'main', DAY2)])
  await db.insert(schedules).values([
    { personId: 'p1', timelineId: 'main', worldDate: '2026-10-01', itemsJson: '[]', generatedAt: DAY1 },
    { personId: 'p1', timelineId: 'main', worldDate: '2026-10-02', itemsJson: '[{"start":"08:00"}]', generatedAt: DAY2 },
    { personId: 'p1', timelineId: 'main', worldDate: '2026-10-03', itemsJson: '[{"start":"09:00"}]', generatedAt: DAY2 },
  ])
  await db.insert(commitments).values([
    { id: 'c1', worldId: 'w', timelineId: 'main', personId: 'p1', visitorId: 'p2', title: '喝茶', location: '茶馆',
      dueSim: DAY2, status: 'accepted', createdSim: DAY1, updatedSim: DAY1, createdAt: DAY1 },
    { id: 'c2', worldId: 'w', timelineId: 'main', personId: 'p1', visitorId: 'p2', title: '旧事', location: '广场',
      dueSim: DAY1, status: 'fulfilled', createdSim: DAY1, updatedSim: DAY1, createdAt: DAY1 },
  ])
})

describe('captureDailyAnchor', () => {
  it('捕获可变核心:状态全量、日程仅当日及未来、承诺含已终结', async () => {
    const db = fixture.db
    const timeline = await db.select().from(timelines).all()
    const anchor = await captureDailyAnchor(db, timeline[0], DAY2)
    expect(anchor).not.toBeNull()
    expect(anchor!.simDay).toBe('2026-10-02')
    expect(anchor!.version).toBe(42)
    expect(anchor!.worldModelVersion).toBe(3)
    const payload = parseAnchorCore(anchor!.payloadJson)!
    expect(payload.states).toHaveLength(2)
    expect(payload.schedules.map((s) => s.worldDate)).toEqual(['2026-10-02', '2026-10-03'])
    expect(payload.commitments.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
    expect(anchor!.coreHash).toBe(await hashAnchorCore(payload))
  })

  it('同一日界重复捕获幂等:仍只有一行', async () => {
    const db = fixture.db
    const timeline = await db.select().from(timelines).all()
    await captureDailyAnchor(db, timeline[0], DAY2)
    await captureDailyAnchor(db, timeline[0], new Date().toISOString())
    const rows = await db.select().from(timelineAnchors).all()
    expect(rows).toHaveLength(1)
  })

  it('无宇宙修订行时不捕获', async () => {
    const db = fixture.db
    await db.insert(timelines).values({ id: 'orphan', worldId: 'w', simNow: DAY2, createdAt: DAY1 })
    const timeline = (await db.select().from(timelines).all()).find((t) => t.id === 'orphan')!
    expect(await captureDailyAnchor(db, timeline, DAY2)).toBeNull()
  })
})

describe('锚点查询', () => {
  it('latestAnchorAtOrBefore 取版本水位不超目标的最新锚点', async () => {
    const db = fixture.db
    const timeline = (await db.select().from(timelines).all())[0]
    await captureDailyAnchor(db, timeline, DAY2)
    await db.insert(timelineAnchors).values({ timelineId: 'main', simDay: '2026-10-03', version: 100,
      simTime: '2026-10-03T00:10:00.000Z', worldModelVersion: 3, coreHash: 'h', payloadJson: '{}', createdAt: DAY2 })
    expect((await latestAnchorAtOrBefore(db, 'main', 50))?.simDay).toBe('2026-10-02')
    expect((await latestAnchorAtOrBefore(db, 'main', 100))?.simDay).toBe('2026-10-03')
    expect(await latestAnchorAtOrBefore(db, 'main', 41)).toBeNull()
    expect(await latestAnchorAtOrBefore(db, 'nope', 100)).toBeNull()
  })

})
