import { describe, expect, it } from 'vitest'
import { eligibleAt, eligibleBoard } from './eligible'
import type { WorldSnapshot } from '../agent/engine-context'

function person(id: string, isUser = false) {
  return { id, isUser } as never
}

function snapshot(opts: {
  simNow: string
  entries: { id: string; location: string; currentDialogueId?: string | null; items?: unknown; isUser?: boolean }[]
  locations?: { name: string; description: string }[]
}): WorldSnapshot {
  const states = new Map()
  const schedules = new Map()
  for (const e of opts.entries) {
    states.set(e.id, { personId: e.id, location: e.location, currentDialogueId: e.currentDialogueId ?? null })
    if (e.items) schedules.set(e.id, { itemsJson: JSON.stringify(e.items) })
  }
  return {
    timeline: { simNow: opts.simNow },
    persons: opts.entries.map((e) => person(e.id, e.isUser ?? false)),
    states,
    schedules,
    locations: opts.locations ?? [],
  } as unknown as WorldSnapshot
}

const SLEEP = [{ start: '13:00', end: '14:00', location: '大厅', activity: '午睡', kind: 'sleep' }]

describe('eligibleAt（可交谈者资格）', () => {
  it('排除用户身份、对话中、睡眠中的人物', () => {
    const snap = snapshot({
      simNow: '2026-09-17T13:30:00.000Z', // 世界日换算后落在 13:00-14:00 睡眠段（按 HH:MM 判定）
      entries: [
        { id: 'u1', location: '大厅', isUser: true },
        { id: 'busy', location: '大厅', currentDialogueId: 'd1' },
        { id: 'asleep', location: '大厅', items: SLEEP },
        { id: 'awake', location: '大厅', items: [{ start: '12:00', end: '15:00', location: '大厅', activity: '读书' }] },
        { id: 'nosched', location: '图书室' },
      ],
    })
    expect(eligibleAt(snap).map((p) => p.id).sort()).toEqual(['awake', 'nosched'])
  })

  it('按地点过滤', () => {
    const snap = snapshot({
      simNow: '2026-09-17T10:00:00.000Z',
      entries: [
        { id: 'a', location: '大厅' },
        { id: 'b', location: '图书室' },
      ],
    })
    expect(eligibleAt(snap, '图书室').map((p) => p.id)).toEqual(['b'])
  })

  it('跨越 UTC 午夜时继续按跨夜睡眠日程过滤', () => {
    const nightShift = [{ start: '23:00', end: '07:00', location: '卧室', activity: '睡觉', kind: 'sleep' }]
    const cases = [
      { simNow: '2026-09-17T22:59:00.000Z', expected: ['resident'] },
      { simNow: '2026-09-17T23:00:00.000Z', expected: [] },
      { simNow: '2026-09-18T00:00:00.000Z', expected: [] },
      { simNow: '2026-09-18T06:59:00.000Z', expected: [] },
      { simNow: '2026-09-18T07:00:00.000Z', expected: ['resident'] },
    ]
    for (const testCase of cases) {
      const snap = snapshot({ simNow: testCase.simNow,
        entries: [{ id: 'resident', location: '卧室', items: nightShift }] })
      expect(eligibleAt(snap).map(p => p.id), testCase.simNow).toEqual(testCase.expected)
    }
  })
})

describe('eligibleBoard（可交谈地点看板）', () => {
  it('按世界地点统计；名单外地点归入「他处」', () => {
    const snap = snapshot({
      simNow: '2026-09-17T10:00:00.000Z',
      locations: [
        { name: '大厅', description: '' },
        { name: '图书室', description: '' },
      ],
      entries: [
        { id: 'a', location: '大厅' },
        { id: 'b', location: '大厅', currentDialogueId: 'd1' },
        { id: 'c', location: '图书室' },
        { id: 'd', location: '月球' },
      ],
    })
    expect(eligibleBoard(snap)).toEqual([
      { location: '大厅', count: 1 },
      { location: '图书室', count: 1 },
      { location: '他处', count: 1 },
    ])
  })
})
