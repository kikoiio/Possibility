import { describe, expect, it } from 'vitest'
import { buildWorldDisambiguationItems, worldPersonLabel, worldStatusLabel } from './world-disambiguation'
import type { PersonListItem, WorldSummary } from '../api/types'

const world = (overrides: Partial<WorldSummary> = {}): WorldSummary => ({
  id: 'world-1', name: '海边小镇', description: '', status: 'running', pauseReason: null,
  isDemo: false, hasScene: true, personIds: ['person-1'], callsToday: 2, personCount: 1,
  simNow: '2026-10-03T00:00:00.000Z', timeZone: 'UTC', createdAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
})

const person = (id: string, name: string): PersonListItem => ({ id, name, createdAt: '2026-10-01T00:00:00.000Z' })

describe('world-disambiguation', () => {
  it('maps real person names without exposing ids', () => {
    const items = buildWorldDisambiguationItems([
      world(), world({ id: 'world-2', personIds: ['person-2'], hasScene: false }),
    ], [person('person-1', '林岚'), person('person-2', '顾舟')])
    expect(items.map(item => item.personNames)).toEqual([['林岚'], ['顾舟']])
    expect(items[0].personNames).not.toContain('person-1')
    expect(worldStatusLabel(items[1])).toBe('待创建场景')
  })

  it('uses explicit fallback labels for missing people', () => {
    expect(worldPersonLabel([])).toBe('暂无关联人物')
    expect(worldPersonLabel(['甲', '乙', '丙'])).toBe('甲、乙等 3 人')
  })
})
