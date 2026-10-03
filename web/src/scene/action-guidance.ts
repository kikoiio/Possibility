import type { WorldSummary } from '../api/types'

/** Examples use only current engine destinations and present recipients. */
export function actionExample(locations: { name: string }[], currentLocation: string | null, residents: { name: string }[]): string | null {
  const destination = locations.find(item => item.name !== currentLocation)
  if (destination) return `带我去${destination.name}`
  const recipient = residents[0]
  return recipient ? `告诉${recipient.name}：我今天来这里散步` : null
}

export function actionAvailability(status: WorldSummary['status'], readOnly: boolean, locations: { name: string }[], present: boolean): string | null {
  if (readOnly) return '这个世界当前只读，无法提出或执行行动。请进入可参与的体验副本，或切换到历史证据完整的宇宙。'
  if (status === 'paused') return '世界已暂停。请关闭面板，在世界页面选择“继续”，恢复后刷新行动状态。'
  if (status === 'capped') return '世界已达今日调用上限。请等待次日恢复，再刷新行动状态。'
  if (status === 'archived') return '世界已归档，当前只能阅读。请切换到可参与的世界。'
  if (!locations.length) return '当前没有可用地点。请先完善世界地点，再刷新行动状态。'
  if (!present) return '请先选择有效地点并进入，再生成行动提议。'
  return null
}

export function refreshedActionLocation(personaLocation: string | null, locations: { name: string }[]): string {
  return locations.some(item => item.name === personaLocation) ? personaLocation! : locations[0]?.name ?? ''
}
