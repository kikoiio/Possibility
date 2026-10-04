import { describe, expect, it } from 'vitest'
import { fromLocalInputValue, planMomentCheck, toLocalInputValue } from './forkMoment'

const range = { earliest: '2026-09-21T08:00:00.000Z', simNow: '2026-09-21T12:00:00.000Z' }

describe('forkMoment 时刻判定(S4/F6)', () => {
  it('UTC 墙钟互转:输入值按 UTC 解释,与 simNow 展示一致;非法输入为 null', () => {
    expect(toLocalInputValue('2026-09-21T09:30:00.000Z')).toBe('2026-09-21T09:30:00')
    expect(toLocalInputValue('2026-09-21T09:30:45.000Z')).toBe('2026-09-21T09:30:45')
    expect(toLocalInputValue('2026-09-21T09:30:45.123Z')).toBe('2026-09-21T09:30:45.123')
    expect(toLocalInputValue('garbage')).toBe('')
    expect(fromLocalInputValue('2026-09-21T09:30')).toBe('2026-09-21T09:30:00.000Z')
    expect(fromLocalInputValue('2026-09-21T09:30:45')).toBe('2026-09-21T09:30:45.000Z')
    expect(fromLocalInputValue('2026-09-21T09:30:45.123')).toBe('2026-09-21T09:30:45.123Z')
    expect(fromLocalInputValue('')).toBeNull()
    expect(fromLocalInputValue('not-a-time')).toBeNull()
  })

  it('默认空输入与恰等于当前时刻 → current,不调用 check', () => {
    expect(planMomentCheck('', range)).toEqual({ kind: 'current' })
    expect(planMomentCheck('   ', range)).toEqual({ kind: 'current' })
    expect(planMomentCheck('2026-09-21T12:00', range)).toEqual({ kind: 'current' })
  })

  it('范围内过去时刻 → check,携带 UTC ISO 交服务端吸附', () => {
    expect(planMomentCheck('2026-09-21T09:30', range))
      .toEqual({ kind: 'check', at: '2026-09-21T09:30:00.000Z' })
    expect(planMomentCheck('2026-09-21T08:00', range))
      .toEqual({ kind: 'check', at: '2026-09-21T08:00:00.000Z' })
  })

  it('分叉预填保留秒,不会把有效检查点截到可回溯起点之前', () => {
    const preciseRange = { earliest: '2026-09-21T08:00:42.123Z', simNow: '2026-09-21T12:00:00.000Z' }
    const prefilled = toLocalInputValue(preciseRange.earliest)
    expect(prefilled).toBe('2026-09-21T08:00:42.123')
    expect(planMomentCheck(prefilled, preciseRange)).toEqual({ kind: 'check', at: preciseRange.earliest })
  })

  it('范围未加载/该线不支持历史 → invalid,原因引导回当前时刻', () => {
    expect(planMomentCheck('2026-09-21T09:30', null))
      .toMatchObject({ kind: 'invalid', reason: expect.stringContaining('没有可回溯的历史') })
    expect(planMomentCheck('2026-09-21T09:30', { earliest: null, simNow: range.simNow }))
      .toMatchObject({ kind: 'invalid', reason: expect.stringContaining('没有可回溯的历史') })
  })

  it('未来/早于起点/非法格式 → invalid 且附对应原因', () => {
    expect(planMomentCheck('2026-09-21T13:00', range))
      .toMatchObject({ kind: 'invalid', reason: expect.stringContaining('尚未发生') })
    expect(planMomentCheck('2026-09-21T07:59', range))
      .toMatchObject({ kind: 'invalid', reason: expect.stringContaining('早于') })
    expect(planMomentCheck('garbage', range))
      .toMatchObject({ kind: 'invalid', reason: expect.stringContaining('格式无效') })
  })
})
