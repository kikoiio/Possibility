import { useEffect, useState, type ReactNode } from 'react'
import type { PaneLoadState, PaneTarget, WorldPresentationContext } from './presentation-types'

export type PaneSessionLoader = (
  target: PaneTarget,
  signal: AbortSignal,
) => Promise<WorldPresentationContext | { kind: 'unsupported'; reason: string }>

export interface ComparisonPaneProps {
  paneId: 'single' | 'left' | 'right'
  target: PaneTarget
  loadSession: PaneSessionLoader
  children: (state: PaneLoadState, retry: () => void) => ReactNode
}

function errorState(error: unknown): Extract<PaneLoadState, { kind: 'error' }> {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : null
  const message = error instanceof Error ? error.message : String(error || '读取世界失败')
  return { kind: 'error', message, retryable: status !== 403 && status !== 404 }
}

/** Loads only this pane's authorized session; its AbortController never owns a sibling request. */
export default function ComparisonPane({ paneId, target, loadSession, children }: ComparisonPaneProps) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<PaneLoadState>({ kind: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setState({ kind: 'loading' })
    void loadSession(target, controller.signal).then(result => {
      if (!active || controller.signal.aborted) return
      if ('kind' in result && result.kind === 'unsupported') {
        setState({ kind: 'unsupported', reason: result.reason })
        return
      }
      const context = result as WorldPresentationContext
      if (context.worldId !== target.worldId
        || context.presentation !== target.presentation
        || (target.timelineId && context.timelineId !== target.timelineId)) {
        setState({ kind: 'error', message: '读取结果与当前视口目标不匹配。', retryable: false })
        return
      }
      setState({ kind: 'ready', context: { ...context, paneId, capabilities: { ...context.capabilities } } })
    }).catch(error => {
      if (active && !controller.signal.aborted) setState(errorState(error))
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [paneId, target.worldId, target.timelineId, target.presentation, loadSession, attempt])

  return <>{children(state, () => setAttempt(value => value + 1))}</>
}
