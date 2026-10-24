import type { VisitPhase } from '../api/types'

export function visitStageLabel(phase: VisitPhase | string | null | undefined): string {
  if (phase === 'first_visit') return '首次到场'
  if (phase === 'returning') return '再次到场'
  return '到场状态待确认'
}

export function visitStageDescription(phase: VisitPhase | string | null | undefined): string {
  if (phase === 'first_visit') return '这是你第一次成功进入这条时间线。'
  if (phase === 'returning') return '你离开后，这条时间线可能已经继续发生变化。'
  return '暂时无法确认上次到场状态。'
}
