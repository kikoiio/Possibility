import { describe, expect, it } from 'vitest'
import {
  describeTimelineStatus,
  describeWorldStatus,
  normalizeTimelineStatus,
  normalizeWorldStatus,
} from '@possibility/world-contract'
import { capabilityView } from './status'

const owner = { kind: 'user' as const, userId: 'owner', username: 'owner', role: 'user' as const, ownerId: 'owner' }
const guest = { kind: 'guest' as const, sessionId: 'guest-session', ownerId: 'owner', worldId: 'world', generation: 0, expiresAt: '2099-01-01T00:00:00.000Z' }

describe('time and status semantics', () => {
  it('normalizes legacy or unknown states to safe read-only values', () => {
    expect(normalizeWorldStatus('running')).toBe('running')
    expect(normalizeWorldStatus('unknown')).toBe('paused')
    expect(normalizeTimelineStatus('archived')).toBe('archived')
    expect(normalizeTimelineStatus('legacy')).toBe('active')
  })

  it('keeps business labels distinct for manual, capped, idle archive and timeline archive', () => {
    expect(describeWorldStatus('paused', 'manual')).toMatchObject({ key: 'paused', label: '手动暂停', frozen: true })
    expect(describeWorldStatus('capped', 'global_daily_cap')).toMatchObject({ key: 'capped', label: '今日调用已达上限' })
    expect(describeWorldStatus('archived', 'idle')).toMatchObject({ key: 'archived', label: '闲置归档' })
    expect(describeTimelineStatus('archived')).toMatchObject({ key: 'timeline_archived', label: '时间线已归档', frozen: true })
  })

  it('derives capabilities from server identity, status and evidence', () => {
    expect(capabilityView({ access: owner, ownsWorld: true, worldStatus: 'running', timelineStatus: 'active', evidenceComplete: true })).toMatchObject({
      identity: 'owner', capabilities: { read: true, write: true, advance: true, fork: true, archive: true, reactivate: false },
    })
    expect(capabilityView({ access: owner, ownsWorld: true, worldStatus: 'paused', timelineStatus: 'active', evidenceComplete: true }).capabilities.write).toBe(false)
    expect(capabilityView({ access: owner, ownsWorld: true, worldStatus: 'running', timelineStatus: 'active', evidenceComplete: false }).capabilities.fork).toBe(false)
    expect(capabilityView({ access: guest, ownsWorld: true, worldStatus: 'running', timelineStatus: 'active', evidenceComplete: true })).toMatchObject({
      identity: 'guest', capabilities: { read: true, write: false, advance: false, fork: false, archive: false, reactivate: false },
    })
  })
})
