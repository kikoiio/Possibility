import { describe, expect, it } from 'vitest'
import { worldSnapshot } from './queries'
import { createTestDb } from '../test/db'
import { timelines, users, voxelEventProjections, worlds } from '../db/schema'

const NOW = '2026-10-15T17:00:00.000Z'

function payload(label: string) {
  return JSON.stringify({
    event: {
      id: `dlg:d-${label}`, type: 'daily', at: { x: 20, y: 2, z: 18 }, importance: 'medium',
      timeWindow: { start: '2026-10-15T14:00:00.000Z', end: '2026-10-15T14:30:00.000Z' },
      label, teaser: `${label}预告`, scene: `${label}场景`,
    },
    sourceEventIds: [`e-${label}`],
    copySource: 'template',
  })
}

async function seed() {
  const { db } = createTestDb()
  await db.insert(users).values({ id: 'u1', username: 'u1', passwordHash: 'x', createdAt: NOW })
  await db.insert(worlds).values({ id: 'w1', userId: 'u1', name: '测试世界', description: '', status: 'running', createdAt: NOW })
  await db.insert(timelines).values([
    { id: 'tl-main', worldId: 'w1', parentTimelineId: null, simNow: NOW, createdAt: NOW, status: 'active' },
    { id: 'tl-fork', worldId: 'w1', parentTimelineId: 'tl-main', simNow: NOW, createdAt: NOW, status: 'active', forkSnapshotJson: null },
  ])
  // 不写 universeRevisions:有 revision 会触发固定设定版本读取,需额外 model 夹具;本测试不依赖版本号
  await db.insert(voxelEventProjections).values([
    { id: 'vep:tl-main:a', timelineId: 'tl-main', payloadJson: payload('主线事件'), createdVersion: 2 },
    { id: 'vep:tl-fork:b', timelineId: 'tl-fork', payloadJson: payload('分叉事件'), createdVersion: 0 },
  ])
  return { db }
}

describe('worldSnapshot.voxelEvents(AC3/AC4)', () => {
  it('snapshot 携带本线体素事件;坏行跳过不致命', async () => {
    const { db } = await seed()
    await db.insert(voxelEventProjections).values({ id: 'vep:tl-main:bad', timelineId: 'tl-main', payloadJson: '{oops', createdVersion: 2 })
    const snapshot = await worldSnapshot(db, 'w1', 'tl-main')
    expect(snapshot).not.toBeNull()
    expect(snapshot!.voxelEvents).toHaveLength(1)
    expect(snapshot!.voxelEvents[0].label).toBe('主线事件')
  })

  it('两条线各见各的投影(分叉隔离)', async () => {
    const { db } = await seed()
    const main = await worldSnapshot(db, 'w1', 'tl-main')
    const fork = await worldSnapshot(db, 'w1', 'tl-fork')
    expect(main!.voxelEvents.map(e => e.label)).toEqual(['主线事件'])
    expect(fork!.voxelEvents.map(e => e.label)).toEqual(['分叉事件'])
  })

  it('无投影行的线 → 空数组(旧存档零事件行为不变)', async () => {
    const { db } = createTestDb()
    await db.insert(users).values({ id: 'u1', username: 'u1', passwordHash: 'x', createdAt: NOW })
    await db.insert(worlds).values({ id: 'w1', userId: 'u1', name: '空世界', description: '', status: 'running', createdAt: NOW })
    await db.insert(timelines).values({ id: 'tl1', worldId: 'w1', parentTimelineId: null, simNow: NOW, createdAt: NOW, status: 'active' })
    const snapshot = await worldSnapshot(db, 'w1')
    expect(snapshot!.voxelEvents).toEqual([])
  })
})
