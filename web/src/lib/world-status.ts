import type { StatusView, TimelineStatus, WorldStatus } from '../api/types'

const fallback: StatusView = { key: 'unknown', label: '状态待确认', description: '当前状态暂时无法确认，请刷新后重试。', frozen: true, nextStep: '刷新状态' }

export function worldStatusView(status: WorldStatus | string | null | undefined, view?: StatusView | null): StatusView {
  if (view) return view
  if (status === 'running') return { key: 'running', label: '正在运行', description: '世界会继续推进，居民按各自处境生活。', frozen: false, nextStep: null }
  if (status === 'paused') return { key: 'paused', label: '暂时不可用', description: '世界暂时冻结，已有记录仍可查看。', frozen: true, nextStep: '查看原因并等待或恢复' }
  if (status === 'capped') return { key: 'capped', label: '今日调用已达上限', description: '世界暂时冻结，额度恢复后会继续。', frozen: true, nextStep: '等待额度恢复或查看已有记录' }
  if (status === 'archived') return { key: 'archived', label: '已归档', description: '世界已冻结，历史记录仍可查看。', frozen: true, nextStep: '恢复世界后继续使用' }
  return fallback
}

export function timelineStatusView(status: TimelineStatus | string | null | undefined, view?: StatusView | null): StatusView {
  if (view) return view
  if (status === 'active') return { key: 'timeline_active', label: '时间线活跃', description: '这条时间线可以在世界运行时继续推进。', frozen: false, nextStep: null }
  if (status === 'archived') return { key: 'timeline_archived', label: '时间线已归档', description: '这条时间线已冻结，历史记录仍可查看。', frozen: true, nextStep: '重新激活后继续推进' }
  return fallback
}

export function statusActionLabel(action: 'resume' | 'pause' | 'archive' | 'reactivate'): string {
  return { resume: '恢复世界', pause: '暂停世界', archive: '归档', reactivate: '重新激活' }[action]
}
