import { describe, expect, it } from 'vitest'
import { resolveSceneEntryLocation } from './entry-location'

const locations = [{ name: '大厅' }, { name: '书房' }, { name: '温室花房' }]

describe('resolveSceneEntryLocation', () => {
  it('传入地点有效时优先,即使 persona 记忆地点不同', () => {
    const result = resolveSceneEntryLocation('大厅', '书房', locations)
    expect(result).toEqual({ location: '大厅', notice: null })
  })

  it('传入地点失效时回退 persona 记忆地点并提示', () => {
    const result = resolveSceneEntryLocation('旧车站', '书房', locations)
    expect(result.location).toBe('书房')
    expect(result.notice).toContain('旧车站')
    expect(result.notice).toContain('已不在当前地点列表中')
  })

  it('传入地点失效且 persona 无记忆地点时回退列表首项', () => {
    const result = resolveSceneEntryLocation('旧车站', null, locations)
    expect(result.location).toBe('大厅')
    expect(result.notice).toContain('旧车站')
  })

  it('空传入时保持现状:persona 记忆地点优先', () => {
    const result = resolveSceneEntryLocation('', '书房', locations)
    expect(result).toEqual({ location: '书房', notice: null })
  })

  it('空传入且 persona 无记忆地点时取列表首项', () => {
    expect(resolveSceneEntryLocation('', null, locations)).toEqual({ location: '大厅', notice: null })
  })

  it('全空时返回空串', () => {
    expect(resolveSceneEntryLocation('', null, [])).toEqual({ location: '', notice: null })
  })
})
