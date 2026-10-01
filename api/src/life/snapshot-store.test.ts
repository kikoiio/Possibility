import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../test/db'
import { forkSnapshots, timelines, users, worlds } from '../db/schema'
import { hydrateTimelines, isSnapshotRef, SNAPSHOT_REF_JSON, writeForkSnapshot } from './snapshot-store'
import type { ForkSnapshot } from '../agent/visibility'

const NOW = '2026-10-01T00:00:00.000Z'
let fixture: ReturnType<typeof createTestDb>

function snapshotOf(sourceTimelineId: string): ForkSnapshot {
  return {
    version: 1, sourceTimelineId, sourceSimTime: NOW, capturedAt: NOW,
    ancestorCutoffs: [{ timelineId: sourceTimelineId, realTime: NOW, simTime: NOW }],
    states: [], schedules: [], memories: [], events: [], commitments: [], historyComplete: true,
  }
}

beforeEach(async () => {
  fixture = createTestDb()
  const db = fixture.db
  await db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'x', createdAt: NOW })
  await db.insert(worlds).values({ id: 'w', userId: 'u', name: 'W', description: '' })
  await db.insert(timelines).values([
    { id: 'main', worldId: 'w', simNow: NOW, createdAt: NOW },
    { id: 'fork-ref', worldId: 'w', parentTimelineId: 'main', simNow: NOW, createdAt: NOW, forkSnapshotJson: SNAPSHOT_REF_JSON },
    { id: 'fork-inline', worldId: 'w', parentTimelineId: 'main', simNow: NOW, createdAt: NOW,
      forkSnapshotJson: JSON.stringify(snapshotOf('main')) },
  ])
})

describe('isSnapshotRef', () => {
  it('识别指针 / v1 内联 / 非 JSON / null', () => {
    expect(isSnapshotRef(SNAPSHOT_REF_JSON)).toBe(true)
    expect(isSnapshotRef(JSON.stringify(snapshotOf('main')))).toBe(false)
    expect(isSnapshotRef('not-json')).toBe(false)
    expect(isSnapshotRef(null)).toBe(false)
    expect(isSnapshotRef('[1,2]')).toBe(false)
  })
})

describe('writeForkSnapshot', () => {
  it('正文落 fork_snapshots 且可解析还原', async () => {
    const db = fixture.db
    const snapshot = snapshotOf('main')
    await writeForkSnapshot(db, 'fork-ref', snapshot, NOW)
    const row = await db.select().from(forkSnapshots).where(eq(forkSnapshots.timelineId, 'fork-ref')).get()
    expect(row?.version).toBe(1)
    expect(JSON.parse(row!.payloadJson)).toEqual(snapshot)
  })
})

describe('hydrateTimelines', () => {
  it('指针行回填正文,内联行原样保留', async () => {
    const db = fixture.db
    const snapshot = snapshotOf('main')
    await writeForkSnapshot(db, 'fork-ref', snapshot, NOW)
    const rows = await db.select().from(timelines).all()
    const hydrated = await hydrateTimelines(db, rows)
    const byId = new Map(hydrated.map((row) => [row.id, row]))
    expect(JSON.parse(byId.get('fork-ref')!.forkSnapshotJson!)).toEqual(snapshot)
    expect(byId.get('fork-inline')!.forkSnapshotJson).toBe(JSON.stringify(snapshotOf('main')))
    expect(byId.get('main')!.forkSnapshotJson).toBeNull()
  })

  it('无指针时直通(同一数组引用)', async () => {
    const db = fixture.db
    const rows = (await db.select().from(timelines).all()).filter((row) => row.id !== 'fork-ref')
    expect(await hydrateTimelines(db, rows)).toBe(rows)
  })

  it('指针悬空抛错', async () => {
    const db = fixture.db
    const rows = await db.select().from(timelines).all()
    await expect(hydrateTimelines(db, rows)).rejects.toThrow('分叉快照存储缺失')
  })
})
