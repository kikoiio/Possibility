import type { AccessContext } from '../access/types'
import type { TimelineStatus, WorldStatus, WorldTimeContext } from '@wispiva/world-contract'

function accessIdentity(access: AccessContext, ownsWorld: boolean): 'owner' | 'guest' | 'readonly' {
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
