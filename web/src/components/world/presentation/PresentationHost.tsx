import { useEffect, useRef, useState } from 'react'
import { createPresentationLifecycle, type MountedPresentationForKind, type PresentationLifecycleAdapters } from './PresentationLifecycle'
import type { CameraSnapshot, PresentationStateStore } from './presentation-types'
import type { PresentationContext, PresentationTransitionResult } from './PresentationLifecycle'

export interface PresentationHostProps {
  data: PresentationContext
  adapters: PresentationLifecycleAdapters
  store: PresentationStateStore
  className?: string
  onCameraChange?: (camera: CameraSnapshot) => void
  onMounted?: (entry: MountedPresentationForKind | null) => void
  onTransition?: (result: PresentationTransitionResult) => void
}

/** Owns one renderer lifecycle. A sibling pane always gets a separate host and lifecycle. */
export default function PresentationHost({
  data,
  adapters,
  store,
  className,
  onCameraChange,
  onMounted,
  onTransition,
}: PresentationHostProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [failure, setFailure] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)
  const callbacksRef = useRef({ onCameraChange, onMounted, onTransition })
  callbacksRef.current = { onCameraChange, onMounted, onTransition }
  const context = data.context
  const capabilitiesKey = JSON.stringify(context.capabilities)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let active = true
    const lifecycle = createPresentationLifecycle({ adapters, store })
    setFailure(null)
    const cameraHost = host.parentElement ?? host
    cameraHost.removeAttribute('data-camera-state')
    void lifecycle.transition(data, host, {
      onCameraChange: camera => {
        cameraHost.dataset.cameraState = JSON.stringify(camera)
        callbacksRef.current.onCameraChange?.(camera)
      },
      onMounted: entry => {
        try {
          const camera = entry.mounted.captureCamera()
          if (camera) cameraHost.dataset.cameraState = JSON.stringify(camera)
        } catch { /* Camera diagnostics cannot break an otherwise mounted pane. */ }
        callbacksRef.current.onMounted?.(entry)
      },
    }).then(result => {
      if (!active) return
      if (result.kind === 'error') setFailure(result.error)
      callbacksRef.current.onTransition?.(result)
    })
    return () => {
      active = false
      callbacksRef.current.onMounted?.(null)
      lifecycle.destroy()
    }
  }, [data, adapters, store, attempt, context.paneId, context.worldId, context.timelineId, context.spaceId,
    context.presentation, context.identity, context.sceneId, context.sceneVersion, context.stateVersion,
    context.simNow, capabilitiesKey])

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
