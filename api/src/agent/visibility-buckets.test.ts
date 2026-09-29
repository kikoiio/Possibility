import { describe, expect, it } from 'vitest'
import type { memories, timelines } from '../db/schema'
import { selectVisibleMemories, visibilityBuckets, type MemoryBucket } from './visibility'

type Timeline = typeof timelines.$inferSelect
type Memory = typeof memories.$inferSelect

function timeline(id: string, parentTimelineId: string | null, createdAt: string): Timeline {
  return {
    id, worldId: 'w', parentTimelineId, forkScenarioJson: null,
    simNow: '2026-09-20T00:00:00Z', createdAt, status: 'active',
    ancestorIdsJson: '[]', lastRealTickAt: null, forkSnapshotJson: null,
  }
}

function memory(id: string, timelineId: string | null, createdAt: string): Memory {
  return {
    id, personId: 'p', timelineId, type: 'timeline', content: id, simTime: null,
    createdAt, importance: 5, summarized: false,
    mentionedPersonIdsJson: null, locationName: null, topicsJson: null,
  }
}

/** 用桶条件过滤内存行集(与检索器 SQL 析取同规则),返回 id 集合 */
function filterByBuckets(rows: Memory[], buckets: MemoryBucket[]): Set<string> {
  return new Set(rows.filter((m) => buckets.some((b) =>
    m.timelineId === b.timelineId && (!b.createdAtLte || m.createdAt <= b.createdAtLte),
  )).map((m) => m.id))
}

const MAIN = '2026-09-01T00:00:00Z'
const FORK1_AT = '2026-09-10T00:00:00Z'
const FORK2_AT = '2026-09-15T00:00:00Z'

describe('visibilityBuckets(S1:可见性桶 SQL 化,与 selectVisibleMemories 同源同义)', () => {
  const main = timeline('main', null, MAIN)
  const fork1 = timeline('fork1', 'main', FORK1_AT)
  const fork2 = timeline('fork2', 'fork1', FORK2_AT)
  const worldTimelines = [main, fork1, fork2]

  it('主线:本线桶 + NULL 桶,均无 cutoff', () => {
    expect(visibilityBuckets(main, worldTimelines, false)).toEqual([
      { timelineId: 'main' },
      { timelineId: null },
    ])
  })

  it('一级分叉:本线 + 主线(cutoff) + NULL(同 cutoff)', () => {
    expect(visibilityBuckets(fork1, worldTimelines, false)).toEqual([
      { timelineId: 'fork1' },
      { timelineId: 'main', createdAtLte: FORK1_AT },
      { timelineId: null, createdAtLte: FORK1_AT },
    ])
  })

  it('二级分叉:祖先链逐级带 cutoff', () => {
    expect(visibilityBuckets(fork2, worldTimelines, false)).toEqual([
      { timelineId: 'fork2' },
      { timelineId: 'fork1', createdAtLte: FORK2_AT },
      { timelineId: 'main', createdAtLte: FORK1_AT },
      { timelineId: null, createdAtLte: FORK1_AT },
    ])
  })

  it('跨世界复用:排除 NULL 桶', () => {
    expect(visibilityBuckets(main, worldTimelines, true)).toEqual([{ timelineId: 'main' }])
    expect(visibilityBuckets(fork1, worldTimelines, true)).toEqual([
      { timelineId: 'fork1' },
      { timelineId: 'main', createdAtLte: FORK1_AT },
    ])
  })

  it('对拍:同一行集下桶过滤与 selectVisibleMemories 逐条一致(二级分叉)', () => {
    const rows = [
      memory('own-after-cutoff', 'fork2', '2026-09-16T00:00:00Z'),
      memory('fork1-before', 'fork1', '2026-09-14T00:00:00Z'),
      memory('fork1-after-cutoff', 'fork1', '2026-09-16T00:00:00Z'),
      memory('main-before', 'main', '2026-09-05T00:00:00Z'),
      memory('main-after-cutoff', 'main', '2026-09-12T00:00:00Z'),
      memory('null-before', null, '2026-09-05T00:00:00Z'),
      memory('null-after-cutoff', null, '2026-09-12T00:00:00Z'),
      memory('other-person', 'fork2', '2026-09-16T00:00:00Z'),
    ]
    rows[7]!.personId = 'someone-else'
    const expected = new Set(selectVisibleMemories(rows, 'p', fork2, worldTimelines).map((m) => m.id))
    const actual = filterByBuckets(rows.filter((m) => m.personId === 'p'), visibilityBuckets(fork2, worldTimelines, false)!)
    expect(actual).toEqual(expected)
    expect([...actual].sort()).toEqual(['fork1-before', 'main-before', 'null-before', 'own-after-cutoff'])
  })
})
