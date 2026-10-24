import { useEffect, useMemo, useRef } from 'react'
import { worldsApi } from '../api/client'
import type { WorldTimeContext } from '../api/types'

interface WorldVisitTarget {
  worldId: string
  timelineId: string
  guest: boolean
}

interface WorldVisitOptions {
  target: WorldVisitTarget | null
  onContext(context: WorldTimeContext): void
  onError(message: string): void
}

export function useWorldVisit({ target, onContext, onError }: WorldVisitOptions): void {
  const callbacks = useRef({ onContext, onError })
  callbacks.current = { onContext, onError }

  const worldId = target?.worldId ?? null
  const timelineId = target?.timelineId ?? null
  const guest = target?.guest ?? false
  const clientSessionId = useMemo(() => {
    if (typeof window === 'undefined' || !worldId || !timelineId) return ''
    const key = `possibility:visit:${worldId}:${timelineId}`
    try {
      const existing = window.sessionStorage.getItem(key)
      if (existing) return existing
      const created = crypto.randomUUID()
      window.sessionStorage.setItem(key, created)
      return created
    } catch {
      return `${worldId}:${timelineId}`
    }
  }, [worldId, timelineId])

  useEffect(() => {
    if (!worldId || !timelineId || !clientSessionId) return
    let active = true
    const input = { timelineId, clientSessionId, requestId: crypto.randomUUID() }
    const shouldLeave = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

    void worldsApi.enterVisit(worldId, input).then(context => {
      if (active) callbacks.current.onContext(context)
      else if (shouldLeave()) {
        void worldsApi.leaveVisit(worldId, { ...input, requestId: crypto.randomUUID() }).catch(() => {})
      }
    }).catch(error => {
      if (active) callbacks.current.onError(error instanceof Error ? error.message : '到场状态暂时无法确认。')
    })

    return () => {
      active = false
      if (shouldLeave()) {
        void worldsApi.leaveVisit(worldId, { ...input, requestId: crypto.randomUUID() }).catch(() => {})
      }
    }
  }, [worldId, timelineId, guest, clientSessionId])
}
