import { describe, expect, it } from 'vitest'
import { nextSimTime, type ToolRunState } from './tools'

function run(patch: Partial<ToolRunState>): ToolRunState {
  return {
    db: null as never, // nextSimTime 不触库
    personId: 'p1',
    timelineId: 't1',
    isMain: true,
    mode: 'chat',
    clock: Date.parse('2026-09-17T10:00:00Z'),
    windowEnd: null,
    acts: 0,
    maxActs: 5,
    current: { location: '', activity: '', mood: '', goal: '' },
    ...patch,
  }
}

describe('nextSimTime（虚拟时钟钳制——bug#2/#6 的防护核心）', () => {
  it('chat 模式：模型给的过去时间被钳到当前 clock', () => {
    const r = run({ mode: 'chat', windowEnd: Date.parse('2026-09-17T10:00:00Z') })
    const t = nextSimTime(r, '2026-09-17T06:00:00Z')
    expect(t).toBe('2026-09-17T10:00:00.000Z')
  })

  it('chat 模式：模型给的遥远未来被钳到窗口右端（simNow），不能任意写飞', () => {
    const r = run({ mode: 'chat', windowEnd: Date.parse('2026-09-17T10:00:00Z') })
    const t = nextSimTime(r, '2031-01-01T00:00:00Z')
    expect(t).toBe('2026-09-17T10:00:00.000Z')
    expect(r.clock).toBe(Date.parse('2026-09-17T10:00:00Z'))
  })

  it('chat 模式：不给时间则停在 clock（不推进）', () => {
    const r = run({ mode: 'chat', windowEnd: Date.parse('2026-09-17T10:00:00Z') })
    expect(nextSimTime(r)).toBe('2026-09-17T10:00:00.000Z')
  })

  it('catchup 模式：按窗口剩余长度均匀分布（至少 1 分钟一步）', () => {
    const start = Date.parse('2026-09-17T08:00:00Z')
    const end = Date.parse('2026-09-17T10:00:00Z')
    const r = run({ mode: 'catchup', clock: start, windowEnd: end })
    const t = nextSimTime(r) // (end-clock)/8 = 15min
    expect(t).toBe('2026-09-17T08:15:00.000Z')
  })

  it('catchup 模式：模型给的超出窗口右端的时间被钳回（不回拨、不飞越）', () => {
    const start = Date.parse('2026-09-17T08:00:00Z')
    const end = Date.parse('2026-09-17T10:00:00Z')
    const r = run({ mode: 'catchup', clock: start, windowEnd: end })
    const t = nextSimTime(r, '2026-09-18T00:00:00Z')
    expect(t).toBe('2026-09-17T10:00:00.000Z')
  })

  it('simulate 模式：缺省步进一整天（分叉推演跨天推进）', () => {
    const r = run({ mode: 'simulate', windowEnd: null })
    expect(nextSimTime(r)).toBe('2026-09-18T10:00:00.000Z')
  })

  it('单调不减：模型给的早于 clock 的时间不会回拨时钟', () => {
    const r = run({ mode: 'simulate', windowEnd: null, clock: Date.parse('2026-09-20T00:00:00Z') })
    const t = nextSimTime(r, '2026-09-17T10:00:00Z')
    expect(Date.parse(t)).toBeGreaterThanOrEqual(Date.parse('2026-09-20T00:00:00Z'))
  })
})
