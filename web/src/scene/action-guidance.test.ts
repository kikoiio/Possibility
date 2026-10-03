import { describe, expect, it } from 'vitest'
import { actionAvailability, actionExample, refreshedActionLocation } from './action-guidance'

describe('current action capabilities', () => {
  const locations = [{ name: '庭院' }, { name: '温室' }]
  it('suggests an existing destination other than the current place', () => {
    expect(actionExample(locations, '庭院', [])).toBe('带我去温室')
    expect(actionExample([{ name: '庭院' }], '庭院', [{ name: '小夜' }])).toBe('告诉小夜：我今天来这里散步')
    expect(actionExample([{ name: '庭院' }], '庭院', [])).toBeNull()
    expect(actionExample([], null, [])).toBeNull()
  })
  it('selects the recovered identity location and excludes removed places', () => {
    expect(refreshedActionLocation('温室', locations)).toBe('温室')
    expect(refreshedActionLocation('旧楼', locations)).toBe('庭院')
    expect(refreshedActionLocation('庭院', [])).toBe('')
  })
  it('explains recovery for paused, read-only, capped, archived and absent identities', () => {
    expect(actionAvailability('paused', false, locations, true)).toContain('继续')
    expect(actionAvailability('running', true, locations, true)).toContain('体验副本')
    expect(actionAvailability('capped', false, locations, true)).toContain('次日')
    expect(actionAvailability('archived', false, locations, true)).toContain('切换')
    expect(actionAvailability('running', false, [], true)).toContain('完善世界地点')
    expect(actionAvailability('running', false, locations, false)).toContain('进入')
    expect(actionAvailability('running', false, locations, true)).toBeNull()
  })
})
