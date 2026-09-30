import { describe, expect, it } from 'vitest'
import type { TimelineComparison } from '../api/types'
import { buildAlignedAxis, filterAt } from './alignedTimeline'

const T0 = '2026-09-19T09:00:00.000Z'
const T1 = '2026-09-19T10:00:00.000Z'
const T2 = '2026-09-19T11:00:00.000Z'
const T3 = '2026-09-19T12:00:00.000Z'

function comparison(over: {
  sharedForkOrigin?: TimelineComparison['sharedForkOrigin']
  firstDivergence?: TimelineComparison['firstDivergence']
  events?: Partial<TimelineComparison['differences']['events']>
} = {}): TimelineComparison {
  const event = (id: string, simTime: string) => ({ id, simTime, title: `事件${id}`, description: '' })
  return {
    worldId: 'world',
    interpretation: 'observed_differences_not_causal_claims',
    timeAlignment: 'same_sim_time',
    alignedAt: null,
    firstDivergence: over.firstDivergence ?? null,
    left: { id: 'main', simNow: T3, status: 'active', parentTimelineId: null, historyComplete: true },
    right: { id: 'fork', simNow: T3, status: 'active', parentTimelineId: 'main', historyComplete: true },
    sharedForkOrigin: over.sharedForkOrigin === undefined
      ? { timelineId: 'main', leftFork: null, rightFork: { forkTimelineId: 'fork', sourceSimTime: T0 } }
      : over.sharedForkOrigin,
    differences: {
      states: [],
      facts: [],
      worldModelVersions: { left: 1, right: 1 },
      events: {
        shared: over.events?.shared ?? [event('s1', T0)],
        leftOnly: over.events?.leftOnly ?? [event('l1', T1)],
        rightOnly: over.events?.rightOnly ?? [event('r1', T2)],
      },
    },
    limitations: [],
  }
}

describe('buildAlignedAxis(S1 轴模型)', () => {
  it('origin 取分叉截点;一侧即共同祖先时取另一侧截点', () => {
    expect(buildAlignedAxis(comparison()).origin).toBe(T0)
    const bothForks = comparison({
      sharedForkOrigin: { timelineId: 'root', leftFork: { forkTimelineId: 'a', sourceSimTime: T1 }, rightFork: { forkTimelineId: 'b', sourceSimTime: T0 } },
    })
    expect(buildAlignedAxis(bothForks).origin).toBe(T0) // 两截点取较早
  })

  it('markers 合并三组按 simTime 排序;同时刻 shared < left < right', () => {
    const axis = buildAlignedAxis(comparison({
      events: {
        shared: [{ id: 's1', simTime: T1, title: '共同', description: '' }],
        leftOnly: [{ id: 'l1', simTime: T1, title: '左', description: '' }],
        rightOnly: [{ id: 'r1', simTime: T0, title: '右', description: '' }],
      },
    }))
    expect(axis.markers.map((m) => m.eventId)).toEqual(['r1', 's1', 'l1'])
    expect(axis.markers.map((m) => m.side)).toEqual(['right', 'shared', 'left'])
  })

  it('无共同祖先:origin 为 null,markers 仍给出(UI 走明示文案)', () => {
    const axis = buildAlignedAxis(comparison({ sharedForkOrigin: null }))
    expect(axis.origin).toBeNull()
    expect(axis.markers).toHaveLength(3)
  })

  it('firstDivergenceAt 透传 API 字段;无分歧为 null', () => {
    expect(buildAlignedAxis(comparison()).firstDivergenceAt).toBeNull()
    const axis = buildAlignedAxis(comparison({ firstDivergence: { simTime: T1, eventId: 'l1', side: 'left' } }))
    expect(axis.firstDivergenceAt).toBe(T1)
  })

  it('空事件组:markers 为空,leftNow/rightNow 仍在', () => {
    const axis = buildAlignedAxis(comparison({ events: { shared: [], leftOnly: [], rightOnly: [] } }))
    expect(axis.markers).toEqual([])
    expect(axis.leftNow).toBe(T3)
    expect(axis.rightNow).toBe(T3)
  })
})

describe('filterAt(S1 拖档截断)', () => {
  it('≤ at 的三组标记各归各组', () => {
    const axis = buildAlignedAxis(comparison())
    const at = filterAt(axis, T1)
    expect(at.shared.map((m) => m.eventId)).toEqual(['s1'])
    expect(at.left.map((m) => m.eventId)).toEqual(['l1'])
    expect(at.right).toEqual([])
  })

  it('at 早于一切:三组皆空;at 晚于一切:全量返回', () => {
    const axis = buildAlignedAxis(comparison())
    const early = filterAt(axis, '2026-09-18T00:00:00.000Z')
    expect(early.shared).toEqual([])
    expect(early.left).toEqual([])
    expect(early.right).toEqual([])
    const late = filterAt(axis, '2026-09-20T00:00:00.000Z')
    expect(late.shared).toHaveLength(1)
    expect(late.left).toHaveLength(1)
    expect(late.right).toHaveLength(1)
  })
})
