import { useEffect, useRef, useState } from 'react'
import { createPresentationLifecycle, type PresentationLifecycleAdapters } from './PresentationLifecycle'
import type { CameraSnapshot, PresentationStateStore } from './presentation-types'
import type { PresentationContext, PresentationTransitionResult } from './PresentationLifecycle'

export interface PresentationHostProps {
  context: PresentationContext
  adapters: PresentationLifecycleAdapters
  store: PresentationStateStore
  className?: string
  onCameraChange?: (camera: CameraSnapshot) => void
  onTransition?: (result: PresentationTransitionResult) => void
}

/** Owns one renderer lifecycle. A sibling pane always gets a separate host and lifecycle. */
export default function PresentationHost({
  context,
  adapters,
  store,
  className,
  onCameraChange,
  onTransition,
}: PresentationHostProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [failure, setFailure] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)
  const callbacksRef = useRef({ onCameraChange, onTransition })
  callbacksRef.current = { onCameraChange, onTransition }
  const capabilitiesKey = JSON.stringify(context.capabilities)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let active = true
    const lifecycle = createPresentationLifecycle({ adapters, store })
    setFailure(null)
    void lifecycle.transition(context, host, {
      onCameraChange: camera => callbacksRef.current.onCameraChange?.(camera),
    }).then(result => {
      if (!active) return
      if (result.kind === 'error') setFailure(result.error)
      callbacksRef.current.onTransition?.(result)
    })
    return () => {
      active = false
      lifecycle.destroy()
    }
  }, [context.paneId, context.worldId, context.timelineId, context.presentation, context.identity, context.stateVersion, context.simNow, capabilitiesKey, adapters, store, attempt])

  const message = failure instanceof Error ? failure.message : failure == null ? '' : String(failure)
  return (
    <div className={`relative min-h-0 min-w-0 ${className ?? ''}`} data-testid={`presentation-host-${context.paneId}`}>
      <div ref={hostRef} className="h-full min-h-0 min-w-0" data-presentation={context.presentation} />
      {failure != null && (
        <div role="alert" className="absolute inset-0 grid place-content-center gap-3 bg-sheet/95 p-4 text-center">
          <p>无法加载{context.presentation === 'native2d' ? '2D' : '3D'}视口：{message}</p>
          <button type="button" onClick={() => setAttempt(value => value + 1)}>重试视口</button>
        </div>
      )}
    </div>
  )
}
