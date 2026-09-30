import type { TimelineComparison } from '../api/types'

/**
 * S1 对齐时间轴模型(纯函数,组件只渲染不计算)。
 * origin = 共同祖先上的分叉截点;无共同祖先时退化为双当前时刻展示。
 */
export interface AxisMarker {
  eventId: string
  simTime: string
  title: string
  side: 'shared' | 'left' | 'right'
}

export interface AlignedAxis {
  /** 分叉点 simTime(sharedForkOrigin 截点);无法确认共同来源时为 null */
  origin: string | null
  leftNow: string
  rightNow: string
  /** 三组事件合并,按 simTime 排序(同时刻 shared < left < right,再按 id) */
  markers: AxisMarker[]
  firstDivergenceAt: string | null
}

const SIDE_ORDER: Record<AxisMarker['side'], number> = { shared: 0, left: 1, right: 2 }

export function buildAlignedAxis(comparison: TimelineComparison): AlignedAxis {
  // 截点 = 两线各自从共同祖先分叉的时刻中较早者;一侧即祖先本身时取另一侧
  const cutoffs = [
    comparison.sharedForkOrigin?.leftFork?.sourceSimTime,
    comparison.sharedForkOrigin?.rightFork?.sourceSimTime,
  ].filter((t): t is string => typeof t === 'string' && t.length > 0)
  const origin = comparison.sharedForkOrigin && cutoffs.length
    ? cutoffs.reduce((a, b) => (a <= b ? a : b))
    : null
  const { shared, leftOnly, rightOnly } = comparison.differences.events
  // 防御:缺 simTime 的事件不上轴(旧数据/异常响应不得拖垮页面)
  const markerOf = (e: { id: string; simTime?: string; title?: string }, side: AxisMarker['side']): AxisMarker[] =>
    typeof e.simTime === 'string' && e.simTime ? [{ eventId: e.id, simTime: e.simTime, title: e.title ?? '', side }] : []
  const markers: AxisMarker[] = [
    ...shared.flatMap((e) => markerOf(e, 'shared')),
    ...leftOnly.flatMap((e) => markerOf(e, 'left')),
    ...rightOnly.flatMap((e) => markerOf(e, 'right')),
  ].sort((a, b) => a.simTime.localeCompare(b.simTime)
    || SIDE_ORDER[a.side] - SIDE_ORDER[b.side]
    || a.eventId.localeCompare(b.eventId))
  return {
    origin,
    leftNow: comparison.left.simNow,
    rightNow: comparison.right.simNow,
    markers,
    firstDivergenceAt: comparison.firstDivergence?.simTime ?? null,
  }
}

/** 拖档截断:≤ at 的三组标记(事件流回放用;不重建历史世界状态) */
export function filterAt(axis: AlignedAxis, at: string): { left: AxisMarker[]; right: AxisMarker[]; shared: AxisMarker[] } {
  const visible = axis.markers.filter((m) => m.simTime <= at)
  return {
    shared: visible.filter((m) => m.side === 'shared'),
    left: visible.filter((m) => m.side === 'left'),
    right: visible.filter((m) => m.side === 'right'),
  }
}
