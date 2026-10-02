import { describe, expect, it } from 'vitest'
import { applyTourMilestone, tourOrder, type TourStep } from './tour'

describe('applyTourMilestone', () => {
  it('空进度完成首步:仅该步完成,无连带步骤', () => {
    const { next, autoCompleted } = applyTourMilestone([], 'discover-event')
    expect(next).toEqual(['discover-event'])
    expect(autoCompleted).toEqual([])
  })

  it('顺序逐步完成:autoCompleted 恒为空', () => {
    let done: TourStep[] = []
    for (const step of tourOrder) {
      const result = applyTourMilestone(done, step)
      expect(result.autoCompleted).toEqual([])
      done = result.next
    }
    expect(done).toEqual(tourOrder)
  })

  it('乱序完成后填补缺口:显示跨过的步骤计入 autoCompleted(报告 2/8→6/8 跳步)', () => {
    // 已完成第 1、3、4、5 步(显示 2/8),此时完成第 2 步 → 显示跳到 6/8
    const previous: TourStep[] = ['discover-event', 'enter-location', 'interact', 'change-condition']
    const { next, autoCompleted } = applyTourMilestone(previous, 'inspect-person')
    expect(next).toEqual(tourOrder.slice(0, 5))
    expect(autoCompleted).toEqual(['enter-location', 'interact', 'change-condition'])
  })

  it('前期缺口未填补时完成后期里程碑:无跳步、无连带', () => {
    const previous: TourStep[] = ['discover-event', 'enter-location', 'interact']
    const { next, autoCompleted } = applyTourMilestone(previous, 'fork')
    expect(next).toEqual(['discover-event', 'enter-location', 'interact', 'fork'])
    expect(autoCompleted).toEqual([])
  })

  it('重复完成已完成步骤:完成集不变', () => {
    const previous: TourStep[] = ['discover-event', 'inspect-person']
    const { next, autoCompleted } = applyTourMilestone(previous, 'inspect-person')
    expect(next).toEqual(['discover-event', 'inspect-person'])
    expect(autoCompleted).toEqual([])
  })

  it('完成最后一步:完成集为全量,无连带', () => {
    const previous = tourOrder.slice(0, 7)
    const { next, autoCompleted } = applyTourMilestone(previous, 'return')
    expect(next).toEqual(tourOrder)
    expect(autoCompleted).toEqual([])
  })
})
