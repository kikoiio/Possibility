import { describe, expect, it } from 'vitest'
import { wanderDestination, wanderSlot, wanderWorldDay } from '../bridge/wander'

const ANCHOR = { x: 20, y: 2, z: 18 }

describe('wanderDestination(AC6)', () => {
  it('同人同日同槽位 → 同一目的地(种子确定性)', () => {
    const a = wanderDestination('p-1', '2026-10-15', ANCHOR, 7)
    const b = wanderDestination('p-1', '2026-10-15', ANCHOR, 7)
    expect(a).toEqual(b)
  })

  it('目的地恒在锚点邻域(2 ~ 4 格),y 与锚点一致', () => {
    for (let slot = 0; slot < 24; slot++) {
      const dest = wanderDestination('p-1', '2026-10-15', ANCHOR, slot)
      const dist = Math.hypot(dest.x - ANCHOR.x, dest.z - ANCHOR.z)
      expect(dist).toBeGreaterThanOrEqual(2)
      expect(dist).toBeLessThanOrEqual(4)
      expect(dest.y).toBe(ANCHOR.y)
    }
  })

  it('slot 递增遍历路径点(漫步位移 > 阈值),换日后轨迹重排', () => {
    const day1 = new Set<string>()
    for (let slot = 0; slot < 11; slot++) {
      const dest = wanderDestination('p-1', '2026-10-15', ANCHOR, slot)
      day1.add(`${dest.x},${dest.z}`)
    }
    // 素数环 × 互质步长 → 11 个槽位覆盖全环 11 站
    expect(day1.size).toBe(11)
    const seq1 = Array.from({ length: 11 }, (_, slot) => wanderDestination('p-1', '2026-10-15', ANCHOR, slot))
    const seq2 = Array.from({ length: 11 }, (_, slot) => wanderDestination('p-1', '2026-10-16', ANCHOR, slot))
    expect(seq1.map(d => `${d.x},${d.z}`).join('|')).not.toBe(seq2.map(d => `${d.x},${d.z}`).join('|'))
  })

  it('不同人同日 → 不同轨迹', () => {
    const a = wanderDestination('p-1', '2026-10-15', ANCHOR, 3)
    const b = wanderDestination('p-2', '2026-10-15', ANCHOR, 3)
    expect(a).not.toEqual(b)
  })
})

describe('wanderSlot / wanderWorldDay', () => {
  it('30 世界分钟一站;不可解析时间 → 槽位 0(防御)', () => {
    expect(wanderSlot('2026-10-15T10:00:00Z')).toBe(20)
    expect(wanderSlot('2026-10-15T10:29:00Z')).toBe(20)
    expect(wanderSlot('2026-10-15T10:30:00Z')).toBe(21)
    expect(wanderSlot('not a date')).toBe(0)
  })

  it('世界日取 ISO 日期部分', () => {
    expect(wanderWorldDay('2026-10-15T10:00:00Z')).toBe('2026-10-15')
  })
})
