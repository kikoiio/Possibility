import type { WorldStreamEvent } from '../api/types'

export function createWorldStreamGuard(opts: {
  worldId: string
  timelineId: string
  generation: number
  isGenerationCurrent: (generation: number) => boolean
}) {
  let active = true
  let streamId: string | null = null
  let sequence = 0
  let version = -1
  return {
    accept(event: WorldStreamEvent): boolean {
      if (!active || !opts.isGenerationCurrent(opts.generation)) return false
      if (event.worldId !== opts.worldId || event.timelineId !== opts.timelineId) return false
      if (streamId === null) streamId = event.streamId
      if (event.streamId !== streamId || event.sequence <= sequence || event.stateVersion < version) return false
      sequence = event.sequence
      version = event.stateVersion
      return true
    },
    invalidate() { active = false },
  }
}
