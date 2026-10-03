import { describe, expect, it } from 'vitest'
import { forkFieldsError, timelineDisplayName, timelineOptionLabel } from './timeline-display'

describe('可读时间线与新建分支校验', () => {
  it('主线、新分支和没有 name 的旧分支均有可读标签', () => {
    expect(timelineDisplayName({ parentTimelineId: null })).toBe('主宇宙')
    expect(timelineOptionLabel({ parentTimelineId: 'main', forkScenario: { name: '信提前到达', whatIf: '如果信准时送达' } })).toBe('信提前到达 · 如果信准时送达')
    expect(timelineDisplayName({ parentTimelineId: 'main', forkScenario: { whatIf: '旧分支假设' } })).toBe('旧分支假设')
  })
  it('名称、假设和改变条件必填且长度明确', () => {
    const valid = { name: '测试', whatIf: '如果', changedVariable: '条件' }
    expect(forkFieldsError(valid)).toBe('')
    for (const [field, max] of [['name', 80], ['whatIf', 500], ['changedVariable', 200]] as const) {
      expect(forkFieldsError({ ...valid, [field]: ' ' })).not.toBe('')
      expect(forkFieldsError({ ...valid, [field]: '字'.repeat(max + 1) })).not.toBe('')
      expect(forkFieldsError({ ...valid, [field]: '字'.repeat(max) })).toBe('')
    }
  })
})
