import { useEffect, useMemo, useRef, useState } from 'react'
import ComparisonPane, { type PaneSessionLoader } from './ComparisonPane'
import PresentationHost from './PresentationHost'
import PresentationSwitcher from './PresentationSwitcher'
import { createCameraLinkCoordinator, type CameraLinkPane, type CameraLinkPaneId } from './CameraLinkCoordinator'
import { canLinkCameras, type CameraSnapshot, type PaneId, type PaneTarget, type PresentationStateStore } from './presentation-types'
import type { PresentationContext, PresentationLifecycleAdapters, MountedPresentationForKind } from './PresentationLifecycle'
import './comparison.css'

export interface ComparisonWorldOption {
  id: string
  name: string
  timelineIds?: string[]
}

export interface ComparisonHostProps {
  left: PaneTarget
  right: PaneTarget | null
  loadSession: PaneSessionLoader
  adapters: PresentationLifecycleAdapters
  store: PresentationStateStore
  worlds: ComparisonWorldOption[]
  onTargetChange: (pane: 'single' | 'left' | 'right', target: PaneTarget | null) => void
  onExit?: () => void
}

function Pane({
  paneId, target, loadSession, adapters, store, worlds, onTargetChange, onMounted, onCameraChange,
}: {
  paneId: PaneId
  target: PaneTarget
  loadSession: PaneSessionLoader
  adapters: PresentationLifecycleAdapters
  store: PresentationStateStore
  worlds: ComparisonWorldOption[]
  onTargetChange: ComparisonHostProps['onTargetChange']
  onMounted: (paneId: CameraLinkPaneId, entry: MountedPresentationForKind | null) => void
  onCameraChange: (paneId: PaneId, camera: CameraSnapshot) => void
}) {
  const cameraLinkPane = paneId === 'right' ? 'right' : 'left'
  return (
    <section className="comparison-pane" data-testid={`comparison-pane-${paneId}`} data-world-id={target.worldId} data-timeline-id={target.timelineId ?? ''}>
      <header className="comparison-pane-toolbar">
        <label>
          <span className="sr-only">{paneId}世界</span>
          <select aria-label={`${paneId}世界`} value={target.worldId} onChange={event => {
            const worldId = event.currentTarget.value
            onTargetChange(paneId === 'single' ? 'single' : paneId, { ...target, worldId, timelineId: undefined })
          }}>
            {worlds.map(world => <option key={world.id} value={world.id}>{world.name}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">{paneId}时间线</span>
          <select aria-label={`${paneId}时间线`} value={target.timelineId ?? ''} onChange={event => {
            const timelineId = event.currentTarget.value || undefined
            onTargetChange(paneId === 'single' ? 'single' : paneId, { ...target, timelineId })
          }}>
            <option value="">当前时间线</option>
            {(worlds.find(world => world.id === target.worldId)?.timelineIds ?? []).map(id => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <PresentationSwitcher
          paneId={paneId}
          value={target.presentation}
          onChange={presentation => onTargetChange(paneId === 'single' ? 'single' : paneId, { ...target, presentation })}
        />
        {paneId === 'right' && (
          <button type="button" className="comparison-pane-close" onClick={() => onTargetChange('right', null)}>关闭右侧</button>
        )}
      </header>
      <ComparisonPane paneId={paneId} target={target} loadSession={loadSession}>
        {(state, retry) => {
          if (state.kind === 'loading') return <div className="comparison-pane-message" role="status">正在读取 {target.worldId}…</div>
          if (state.kind === 'unsupported') return <div className="comparison-pane-message" role="status">{state.reason}</div>
          if (state.kind === 'error') return (
            <div className="comparison-pane-message" role="alert">
              <p>{state.message}</p>
              {state.retryable && <button type="button" onClick={retry}>重试此侧</button>}
            </div>
          )
          return <>
            <div className="comparison-pane-facts" data-testid={`pane-facts-${paneId}`}>
              <span>{state.context.identity}</span>
              <span>{state.context.timelineId}</span>
              <time dateTime={state.context.simNow}>{state.context.simNow}</time>
            </div>
            <PresentationHost
              context={state.context as PresentationContext}
              adapters={adapters}
              store={store}
              onCameraChange={camera => onCameraChange(paneId, camera)}
              onMounted={(entry: MountedPresentationForKind | null) => {
                if (paneId !== 'single') onMounted(cameraLinkPane, entry)
              }}
            />
          </>
        }}
      </ComparisonPane>
    </section>
  )
}

export default function ComparisonHost({ left, right, loadSession, adapters, store, worlds, onTargetChange, onExit }: ComparisonHostProps) {
  const coordinator = useMemo(() => createCameraLinkCoordinator(), [])
  const coordinatorEffectGeneration = useRef(0)
  const [cameraLinkEnabled, setCameraLinkEnabled] = useState(false)
  const [, setBindingRevision] = useState(0)
  const mountedPanes = useRef<Partial<Record<CameraLinkPaneId, CameraLinkPane>>>({})
  const cameraKeys = useRef<Partial<Record<CameraLinkPaneId, string>>>({})
  const compatible = right !== null && canLinkCameras(left, right)
  useEffect(() => {
    if (compatible) return
    setCameraLinkEnabled(false)
    coordinator.setEnabled(false)
  }, [coordinator, compatible])
  useEffect(() => {
    const generation = ++coordinatorEffectGeneration.current
    return () => {
      // React StrictMode replays effect cleanup/setup without replacing the memoized
      // coordinator. Defer disposal one microtask so the replay can claim the lifetime.
      queueMicrotask(() => {
        if (coordinatorEffectGeneration.current === generation) coordinator.dispose()
      })
    }
  }, [coordinator])
  const bindPane = (paneId: CameraLinkPaneId, entry: MountedPresentationForKind | null) => {
    if (entry) mountedPanes.current[paneId] = entry as CameraLinkPane
    else delete mountedPanes.current[paneId]
    delete cameraKeys.current[paneId]
    coordinator.bind(paneId, entry as CameraLinkPane | null)
    setBindingRevision(value => value + 1)
  }
  const reportCamera = (paneId: PaneId, camera: CameraSnapshot) => {
    if (paneId !== 'single') cameraKeys.current[paneId] = JSON.stringify(camera)
    coordinator.notifyCameraChange(paneId, camera)
  }
  useEffect(() => {
    if (!cameraLinkEnabled || !compatible) return
    let frame = 0
    const sample = () => {
      for (const paneId of ['left', 'right'] as const) {
        const pane = mountedPanes.current[paneId]
        if (!pane) continue
        try {
          const camera = pane.mounted.captureCamera()
          if (!camera) continue
          const key = JSON.stringify(camera)
          if (cameraKeys.current[paneId] === undefined) {
            cameraKeys.current[paneId] = key
            continue
          }
          if (cameraKeys.current[paneId] === key) continue
          cameraKeys.current[paneId] = key
          coordinator.notifyCameraChange(paneId, camera as CameraSnapshot)
        } catch { /* A broken pane cannot block camera updates in its sibling. */ }
      }
      frame = requestAnimationFrame(sample)
    }
    frame = requestAnimationFrame(sample)
    return () => cancelAnimationFrame(frame)
  }, [coordinator, cameraLinkEnabled, compatible])

  return (
    <div className={`comparison-workspace ${right ? 'comparison-workspace-split' : 'comparison-workspace-single'}`} data-testid="comparison-workspace">
      <Pane paneId={right ? 'left' : 'single'} target={left} loadSession={loadSession} adapters={adapters} store={store} worlds={worlds} onTargetChange={onTargetChange} onMounted={bindPane} onCameraChange={reportCamera} />
      {right ? <Pane paneId="right" target={right} loadSession={loadSession} adapters={adapters} store={store} worlds={worlds} onTargetChange={onTargetChange} onMounted={bindPane} onCameraChange={reportCamera} /> : (
        <button className="comparison-open-split" type="button" onClick={() => onTargetChange('right', { ...left, presentation: left.presentation })}>添加比较视口</button>
      )}
      {right && (
        <label
          className="comparison-camera-link"
          data-testid="comparison-camera-link"
          data-camera-link-enabled={cameraLinkEnabled}
          data-camera-left-mounted={Boolean(mountedPanes.current.left)}
          data-camera-right-mounted={Boolean(mountedPanes.current.right)}
          data-camera-link-active={coordinator.isLinkActive()}
        >
          <input type="checkbox" checked={cameraLinkEnabled && compatible} disabled={!compatible} onChange={event => {
            const enabled = event.currentTarget.checked
            setCameraLinkEnabled(enabled)
            coordinator.setEnabled(enabled && compatible)
          }} />
          联动相机
        </label>
      )}
      {!right && onExit && <button className="comparison-exit" type="button" onClick={onExit}>返回世界画布</button>}
    </div>
  )
}
