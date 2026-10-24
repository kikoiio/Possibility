export type WorldStatus = 'running' | 'paused' | 'capped' | 'archived'
export type TimelineStatus = 'active' | 'archived'
export type WorldStatusReason = 'manual' | 'daily_cap' | 'global_daily_cap' | 'idle' | null
export type VisitPhase = 'first_visit' | 'returning' | 'unknown'

export interface StatusView {
  key: string
  label: string
  description: string
  frozen: boolean
  nextStep: string | null
}

export interface VisitContext {
  phase: VisitPhase
  sessionId: string | null
  enteredSimTime: string | null
  previousExitedSimTime: string | null
  hasValidPreviousWatermark: boolean
}

export interface WorldTimeContext {
  worldId: string
  timelineId: string
  simNow: string
  timeZone: string
  stateVersion: number
  /** Compatibility alias of stateVersion, not the voxel scene revision. */
  revisionVersion: number
  world: { status: WorldStatus; reason: WorldStatusReason; view: StatusView }
  timeline: { status: TimelineStatus; view: StatusView }
  access: {
    identity: 'owner' | 'guest' | 'readonly'
    capabilities: Readonly<Record<'read' | 'write' | 'advance' | 'fork' | 'archive' | 'reactivate', boolean>>
  }
  visit: VisitContext
}

const WORLD_STATUS_VIEWS: Record<WorldStatus, StatusView> = {
  running: { key: 'running', label: '正在运行', description: '世界会继续推进，居民按各自处境生活。', frozen: false, nextStep: null },
  paused: { key: 'paused', label: '手动暂停', description: '世界暂时冻结，已有记录仍可查看。', frozen: true, nextStep: '恢复世界后继续运行' },
  capped: { key: 'capped', label: '今日调用已达上限', description: '世界暂时冻结，达到新的可用额度后会恢复。', frozen: true, nextStep: '等待额度恢复或查看已有记录' },
  archived: { key: 'archived', label: '已归档', description: '世界已冻结，历史记录仍可查看。', frozen: true, nextStep: '恢复世界后继续使用' },
}

const UNKNOWN_STATUS_VIEW: StatusView = {
  key: 'unknown',
  label: '状态待确认',
  description: '当前状态暂时无法确认，请刷新后重试。',
  frozen: true,
  nextStep: '刷新状态',
}

const UI_STATUS_OVERRIDES: Partial<Record<WorldStatus, Partial<StatusView>>> = {
  capped: { description: '世界暂时冻结，额度恢复后会继续。' },
}

export function normalizeWorldStatus(raw: string | null | undefined): WorldStatus {
  return raw === 'running' || raw === 'paused' || raw === 'capped' || raw === 'archived' ? raw : 'paused'
}

export function normalizeTimelineStatus(raw: string | null | undefined): TimelineStatus {
  return raw === 'archived' ? 'archived' : 'active'
}

export function normalizeWorldStatusReason(raw: string | null | undefined): WorldStatusReason {
  return raw === 'manual' || raw === 'daily_cap' || raw === 'global_daily_cap' || raw === 'idle' ? raw : null
}

export function describeWorldStatus(status: WorldStatus, reason: WorldStatusReason): StatusView {
  const base = WORLD_STATUS_VIEWS[status]
  if (status === 'paused' && reason !== 'manual') {
    return { ...base, label: '暂时不可用', description: '世界暂时冻结，已有记录仍可查看。', nextStep: '查看原因并等待或恢复' }
  }
  if (status === 'capped' && reason === 'global_daily_cap') {
    return { ...base, description: '今日共享调用额度已用完，额度恢复后会继续。', nextStep: '等待额度恢复或查看已有记录' }
  }
  if (status === 'archived' && reason === 'idle') {
    return { ...base, label: '闲置归档', description: '世界因长期没有交互而冻结，历史记录仍可查看。', nextStep: '恢复世界后继续使用' }
  }
  return { ...base }
}

export function describeTimelineStatus(status: TimelineStatus): StatusView {
  if (status === 'archived') {
    return { key: 'timeline_archived', label: '时间线已归档', description: '这条时间线已冻结，历史记录仍可查看。', frozen: true, nextStep: '重新激活后继续推进' }
  }
  return { key: 'timeline_active', label: '时间线活跃', description: '这条时间线可以在世界运行时继续推进。', frozen: false, nextStep: null }
}

export function worldStatusView(raw: string | null | undefined, supplied?: StatusView | null): StatusView {
  if (supplied) return supplied
  if (raw === 'running' || raw === 'paused' || raw === 'capped' || raw === 'archived') {
    return { ...describeWorldStatus(raw, null), ...UI_STATUS_OVERRIDES[raw] }
  }
  return { ...UNKNOWN_STATUS_VIEW }
}

export function timelineStatusView(raw: string | null | undefined, supplied?: StatusView | null): StatusView {
  if (supplied) return supplied
  if (raw === 'active' || raw === 'archived') return describeTimelineStatus(raw)
  return { ...UNKNOWN_STATUS_VIEW }
}

export function statusActionLabel(action: 'resume' | 'pause' | 'archive' | 'reactivate'): string {
  return { resume: '恢复世界', pause: '暂停世界', archive: '归档', reactivate: '重新激活' }[action]
}
