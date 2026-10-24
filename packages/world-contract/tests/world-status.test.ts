import { describe, expect, it } from 'vitest'
import {
  describeTimelineStatus,
  describeWorldStatus,
  normalizeTimelineStatus,
  normalizeWorldStatus,
  normalizeWorldStatusReason,
  statusActionLabel,
  timelineStatusView,
  worldStatusView,
} from '../src'

describe('world status contract', () => {
  it('normalizes persisted values at the boundary', () => {
    expect(normalizeWorldStatus('running')).toBe('running')
    expect(normalizeWorldStatus('unrecognized')).toBe('paused')
    expect(normalizeTimelineStatus('archived')).toBe('archived')
    expect(normalizeTimelineStatus('legacy')).toBe('active')
    expect(normalizeWorldStatusReason('global_daily_cap')).toBe('global_daily_cap')
    expect(normalizeWorldStatusReason('unrecognized')).toBeNull()
  })

  it('preserves server descriptions for manual pause, global cap, and idle archive', () => {
    expect(describeWorldStatus('paused', 'manual')).toEqual({
      key: 'paused', label: '手动暂停', description: '世界暂时冻结，已有记录仍可查看。', frozen: true, nextStep: '恢复世界后继续运行',
    })
    expect(describeWorldStatus('paused', 'idle').label).toBe('暂时不可用')
    expect(describeWorldStatus('capped', 'global_daily_cap')).toMatchObject({
      key: 'capped', label: '今日调用已达上限', description: '今日共享调用额度已用完，额度恢复后会继续。',
    })
    expect(describeWorldStatus('archived', 'idle').label).toBe('闲置归档')
  })

  it('keeps server views authoritative and uses the UI fallback for unknown values', () => {
    const supplied = { key: 'paused', label: '服务端文案', description: '详情', frozen: true, nextStep: null }
    expect(worldStatusView('paused', supplied)).toEqual(supplied)
    expect(worldStatusView('paused').label).toBe('暂时不可用')
    expect(worldStatusView('unknown').label).toBe('状态待确认')
    expect(timelineStatusView('archived').nextStep).toBe('重新激活后继续推进')
    expect(timelineStatusView('unknown').label).toBe('状态待确认')
    expect(describeTimelineStatus('active')).toMatchObject({ key: 'timeline_active', frozen: false })
  })

  it('labels supported status actions', () => {
    expect(statusActionLabel('resume')).toBe('恢复世界')
    expect(statusActionLabel('reactivate')).toBe('重新激活')
  })
})
