import type { AccessContext } from '../access/types'

export type WorldStatus = 'running' | 'paused' | 'capped' | 'archived'
export type TimelineStatus = 'active' | 'archived'
export type WorldStatusReason = 'manual' | 'daily_cap' | 'global_daily_cap' | 'idle' | null

export interface StatusView {
  key: string
  label: string
  description: string
  frozen: boolean
  nextStep: string | null
}

export interface VisitContext {
  phase: 'first_visit' | 'returning' | 'unknown'
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
  revisionVersion: number
  world: {
    status: WorldStatus
    reason: WorldStatusReason
    view: StatusView
  }
  timeline: {
    status: TimelineStatus
    view: StatusView
  }
  access: {
    identity: 'owner' | 'guest' | 'readonly'
    capabilities: Readonly<Record<'read' | 'write' | 'advance' | 'fork' | 'archive' | 'reactivate', boolean>>
  }
  visit: VisitContext
}

const WORLD_STATUS_LABELS: Record<WorldStatus, StatusView> = {
  running: { key: 'running', label: '正在运行', description: '世界会继续推进，居民按各自处境生活。', frozen: false, nextStep: null },
  paused: { key: 'paused', label: '手动暂停', description: '世界暂时冻结，已有记录仍可查看。', frozen: true, nextStep: '恢复世界后继续运行' },
  capped: { key: 'capped', label: '今日调用已达上限', description: '世界暂时冻结，达到新的可用额度后会恢复。', frozen: true, nextStep: '等待额度恢复或查看已有记录' },
  archived: { key: 'archived', label: '已归档', description: '世界已冻结，历史记录仍可查看。', frozen: true, nextStep: '恢复世界后继续使用' },
}

export function normalizeWorldStatus(value: string | null | undefined): WorldStatus {
  return value === 'running' || value === 'paused' || value === 'capped' || value === 'archived' ? value : 'paused'
}

export function normalizeTimelineStatus(value: string | null | undefined): TimelineStatus {
  return value === 'archived' ? 'archived' : 'active'
}

export function normalizeWorldStatusReason(value: string | null | undefined): WorldStatusReason {
  return value === 'manual' || value === 'daily_cap' || value === 'global_daily_cap' || value === 'idle' ? value : null
}

export function worldStatusView(status: string | null | undefined, reason: string | null | undefined): StatusView {
  const normalized = normalizeWorldStatus(status)
  const base = WORLD_STATUS_LABELS[normalized]
  if (normalized === 'paused' && reason !== 'manual') {
    return { ...base, label: '暂时不可用', description: '世界暂时冻结，已有记录仍可查看。', nextStep: '查看原因并等待或恢复' }
  }
  if (normalized === 'capped' && reason === 'global_daily_cap') {
    return { ...base, description: '今日共享调用额度已用完，额度恢复后会继续。', nextStep: '等待额度恢复或查看已有记录' }
  }
  if (normalized === 'archived' && reason === 'idle') {
    return { ...base, label: '闲置归档', description: '世界因长期没有交互而冻结，历史记录仍可查看。', nextStep: '恢复世界后继续使用' }
  }
  return { ...base }
}

export function timelineStatusView(status: string | null | undefined): StatusView {
  if (normalizeTimelineStatus(status) === 'archived') {
    return { key: 'timeline_archived', label: '时间线已归档', description: '这条时间线已冻结，历史记录仍可查看。', frozen: true, nextStep: '重新激活后继续推进' }
  }
  return { key: 'timeline_active', label: '时间线活跃', description: '这条时间线可以在世界运行时继续推进。', frozen: false, nextStep: null }
}

export function accessIdentity(access: AccessContext, ownsWorld: boolean): 'owner' | 'guest' | 'readonly' {
  if (access.kind === 'guest') return 'guest'
  if (access.kind === 'user' && ownsWorld) return 'owner'
  return 'readonly'
}

export function capabilityView(input: {
  access: AccessContext
  ownsWorld: boolean
  worldStatus: WorldStatus
  timelineStatus: TimelineStatus
  evidenceComplete: boolean
}): WorldTimeContext['access'] {
  const identity = accessIdentity(input.access, input.ownsWorld)
  const owner = identity === 'owner'
  const writable = owner && input.worldStatus === 'running' && input.timelineStatus === 'active' && input.evidenceComplete
  return {
    identity,
    capabilities: {
      read: true,
      write: writable,
      advance: writable,
      fork: owner && input.timelineStatus === 'active' && input.worldStatus !== 'archived' && input.evidenceComplete,
      archive: owner && input.timelineStatus === 'active',
      reactivate: owner && input.timelineStatus === 'archived' && input.evidenceComplete,
    },
  }
}
