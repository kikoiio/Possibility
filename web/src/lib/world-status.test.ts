import { describe, expect, it } from 'vitest'
import { statusActionLabel, timelineStatusView, worldStatusView } from './world-status'

describe('world status copy', () => {
  it('maps every supported state to business copy without exposing enum reasons', () => {
    expect(worldStatusView('running').label).toBe('正在运行')
    expect(worldStatusView('paused').label).toBe('暂时不可用')
    expect(worldStatusView('capped').label).toBe('今日调用已达上限')
    expect(worldStatusView('capped').description).toBe('世界暂时冻结，额度恢复后会继续。')
    expect(worldStatusView('archived').label).toBe('已归档')
    expect(worldStatusView('unrecognized').label).toBe('状态待确认')
    expect(timelineStatusView('archived').nextStep).toBe('重新激活后继续推进')
    expect(statusActionLabel('reactivate')).toBe('重新激活')
  })
})
