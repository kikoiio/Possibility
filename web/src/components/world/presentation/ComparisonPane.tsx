import { useEffect, useState, type ReactNode } from 'react'
import type { PaneId, PaneLoadState, PaneSessionLoader, PaneTarget, PaneUnsupported, PaneWorldData } from './presentation-types'

export type { PaneSessionLoader }

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

/**
 * 把一次读取结果映射为 pane 状态：unsupported 原样透传；ready 结果与 target
 * 逐项比较，任一字段不符都转为错误，绝不把混合数据交给表现宿主。
 */
export function paneLoadStateFrom(
  loaded: PaneWorldData | PaneUnsupported,
  target: PaneTarget,
  paneId: PaneId,
): PaneLoadState {
  if ('kind' in loaded && loaded.kind === 'unsupported') {
    return {
      kind: 'unsupported',
      code: loaded.code,
      reason: loaded.reason,
      alternatives: loaded.alternatives ? [...loaded.alternatives] : undefined,
    }
  }
  const result = loaded as PaneWorldData
  const context = result.context
  if (context.worldId !== target.worldId
    || context.presentation !== target.presentation
    || (target.timelineId !== undefined && context.timelineId !== target.timelineId)
    || (target.spaceId !== undefined && context.spaceId !== target.spaceId)) {
    return { kind: 'error', message: '读取结果与当前视口目标不匹配。', retryable: false }
  }
  return {
    kind: 'ready',
    data: {
      ...result,
      context: {
        ...context,
        paneId,
        capabilities: { ...context.capabilities },
        availableSpaces: [...context.availableSpaces],
      },
    },
  }
}

/**
 * Loads only this pane's authorized session; its AbortController never owns a
 * sibling request. Ready results are validated field-by-field against the
 * target so a mismatched response never reaches the presentation host.
 */
export default function ComparisonPane({ paneId, target, loadSession, children }: ComparisonPaneProps) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<PaneLoadState>({ kind: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setState({ kind: 'loading' })
    void loadSession(target, controller.signal).then(loaded => {
      if (active && !controller.signal.aborted) setState(paneLoadStateFrom(loaded, target, paneId))
    }).catch(error => {
      if (active && !controller.signal.aborted) setState(errorState(error))
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [paneId, target.worldId, target.timelineId, target.spaceId, target.presentation, loadSession, attempt])

  return <>{children(state, () => setAttempt(value => value + 1))}</>
}
