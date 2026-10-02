/**
 * S3 体验导览:步骤常量、进度持久化与里程碑前缀闭合(纯函数,便于单测)。
 * 进度按 worldId 隔离存 localStorage;存储键不变(v1),重置仅由用户显式操作触发。
 */
export const tourSteps = [
  ['discover-event', '发现事件：选择正在发生变化的地点。'],
  ['inspect-person', '认识居民：选择一位人物查看其活动。'],
  ['enter-location', '进入地点：到达地点后继续。'],
  ['interact', '真实交谈：完成一次已提交的交谈。'],
  ['change-condition', '改变条件：传递一条消息或确认一项行动。'],
  ['fork', '创建分支：从当前发展建立平行宇宙。'],
  ['compare', '查看对照：读取两条时间线的记录差异。'],
  ['return', '返回地图：结束导览，继续探索。'],
] as const
export type TourStep = typeof tourSteps[number][0]
export const tourOrder = tourSteps.map(([id]) => id) as TourStep[]

export function tourStorageKey(worldId: string) { return `possibility:s03-tour:v1:${worldId}` }

export function loadTourProgress(worldId: string): TourStep[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(tourStorageKey(worldId)) ?? '[]')
    return Array.isArray(value) ? value.filter((step): step is TourStep => tourOrder.includes(step)) : []
  } catch { return [] }
}

/**
 * 完成里程碑:完成集 = 已完成 ∪ {milestone}(现语义,不改)。
 * 进度显示为「首个未完成步骤」,因此乱序完成的步骤会在此后缺口被填补时
 * 一次性跳过(报告问题 15 的 2/8→6/8 跳步)。autoCompleted 返回本次完成
 * 使显示进度跨过的、非 milestone 本身的步骤——用于「此前已完成」反馈(S3/F3)。
 */
export function applyTourMilestone(previous: TourStep[], milestone: TourStep): { next: TourStep[]; autoCompleted: TourStep[] } {
  const next = tourOrder.filter(step => previous.includes(step) || step === milestone)
  const beforeIdx = tourOrder.findIndex(step => !previous.includes(step))
  const afterFound = tourOrder.findIndex(step => !next.includes(step))
  const start = beforeIdx === -1 ? tourOrder.length : beforeIdx
  const end = afterFound === -1 ? tourOrder.length : afterFound
  const autoCompleted = end > start ? tourOrder.slice(start, end).filter(step => step !== milestone) : []
  return { next, autoCompleted }
}
