import { useEffect, useRef, useState } from 'react'
import type {
  MovePreview,
  Native2dViewport as Native2dViewportApi,
  SceneDefinition,
  ScenePresentation,
  Selection,
  ViewportDiagnostics,
  ViewportEvent,
} from './types'
import { createNative2dViewport } from './viewport'

declare global {
  interface Window {
    __native2dDiagnostics?: () => ViewportDiagnostics | undefined
  }
}

interface Native2dViewportProps {
  readonly scene: SceneDefinition
  readonly presentation: ScenePresentation | null
  readonly selection: Selection | null
  readonly followPersonId: string | null
  readonly movePreview: MovePreview | null
  readonly overviewRequest: number
  readonly onEvent: (event: ViewportEvent) => void
}

export default function Native2dViewport({
  scene,
  presentation,
  selection,
  followPersonId,
  movePreview,
  overviewRequest,
  onEvent,
}: Native2dViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<Native2dViewportApi | null>(null)
  const eventRef = useRef(onEvent)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  eventRef.current = onEvent

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let active = true
    setError(null)
    setReady(false)

    void createNative2dViewport(host, scene, {
      onEvent: (event) => eventRef.current(event),
      onDiagnostics: (value) => {
        if (typeof window !== 'undefined') window.__native2dDiagnostics = () => value
      },
    }).then(
      (viewport) => {
        if (!active) {
          viewport.dispose()
          return
        }
        viewportRef.current = viewport
        setReady(true)
      },
      (reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      },
    )

    return () => {
      active = false
      viewportRef.current?.dispose()
      viewportRef.current = null
      if (typeof window !== 'undefined') delete window.__native2dDiagnostics
    }
  }, [attempt, scene])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !presentation) return
    viewport.setPresentation(presentation)
  }, [presentation])

  useEffect(() => viewportRef.current?.setSelection(selection), [selection])
  useEffect(() => viewportRef.current?.setFollow(followPersonId), [followPersonId])
  useEffect(() => viewportRef.current?.setMovePreview(movePreview), [movePreview])
  useEffect(() => {
    if (overviewRequest > 0) viewportRef.current?.showOverview()
  }, [overviewRequest])

  return (
    <div className="native2d-viewport-wrap">
      <div
        ref={hostRef}
        className="native2d-viewport-host"
        data-testid="native2d-viewport"
        aria-label="雾影庄 2D 场景视口"
      />
      {!ready && !error && <div className="native2d-viewport-message" role="status">正在准备场景…</div>}
      {error && (
        <div className="native2d-viewport-error" role="alert" data-testid="native2d-viewport-error">
          <span>场景视口无法启动：{error}</span>
          <button type="button" onClick={() => setAttempt((value) => value + 1)} data-testid="native2d-viewport-retry">
            重试视口
          </button>
        </div>
      )}
    </div>
  )
}
