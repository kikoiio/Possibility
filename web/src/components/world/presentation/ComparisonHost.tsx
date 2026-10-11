import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ComparisonPane, { type PaneSessionLoader } from './ComparisonPane'
import PresentationHost from './PresentationHost'
import PresentationSwitcher from './PresentationSwitcher'
import { createCameraLinkCoordinator, type CameraLinkPane, type CameraLinkPaneId } from './CameraLinkCoordinator'
import { canLinkCameras, type CameraLinkScope, type CameraSnapshot, type PaneId, type PaneLoadState, type PaneTarget, type PresentationStateStore, type SpaceDescriptor, type WorldPresentationContext } from './presentation-types'
import type { PresentationContext, PresentationLifecycleAdapters, MountedPresentationForKind } from './PresentationLifecycle'
import './comparison.css'

export interface ComparisonTimelineOption {
  id: string
  label: string
}

export interface ComparisonWorldOption {
  id: string
  name: string
  timelineIds?: string[]
  timelineLabels?: readonly ComparisonTimelineOption[]
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

const IDENTITY_LABELS: Readonly<Record<WorldPresentationContext['identity'], string>> = {
  owner: '所有者',
  guest: '访客',
  readonly: '只读',
}

function spaceLabel(context: WorldPresentationContext): string {
  return context.availableSpaces.find(space => space.id === context.spaceId)?.label ?? '当前空间'
}

function timelineLabel(context: WorldPresentationContext, worlds: ComparisonWorldOption[]): string {
  const world = worlds.find(option => option.id === context.worldId)
  return world?.timelineLabels?.find(option => option.id === context.timelineId)?.label ?? context.timelineId
}

function Pane({
  paneId, target, loadSession, adapters, store, worlds, onTargetChange, onMounted, onCameraChange, onReadyContext,
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
  onReadyContext: (paneId: PaneId, context: WorldPresentationContext | null) => void
}) {
  const cameraLinkPane = paneId === 'right' ? 'right' : 'left'
  const world = worlds.find(option => option.id === target.worldId)
  const timelineOptions: readonly ComparisonTimelineOption[] = world?.timelineLabels
    ?? (world?.timelineIds ?? []).map(id => ({ id, label: id }))
  return (
    <section className="comparison-pane" data-testid={`comparison-pane-${paneId}`} data-world-id={target.worldId} data-timeline-id={target.timelineId ?? ''} data-space-id={target.spaceId ?? ''}>
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
            {timelineOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
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
        {(state, retry) => <PaneBody
          paneId={paneId} target={target} state={state} retry={retry}
          worlds={worlds} adapters={adapters} store={store}
          onTargetChange={onTargetChange}
          onMounted={onMounted} onCameraChange={onCameraChange}
          onReadyContext={onReadyContext}
          cameraLinkPane={cameraLinkPane}
        />}
      </ComparisonPane>
    </section>
  )
}

function PaneBody({
  paneId, target, state, retry, worlds, adapters, store, onTargetChange, onMounted, onCameraChange, onReadyContext, cameraLinkPane,
}: {
  paneId: PaneId
  target: PaneTarget
  state: PaneLoadState
  retry: () => void
  worlds: ComparisonWorldOption[]
  adapters: PresentationLifecycleAdapters
  store: PresentationStateStore
  onTargetChange: ComparisonHostProps['onTargetChange']
  onMounted: (paneId: CameraLinkPaneId, entry: MountedPresentationForKind | null) => void
  onCameraChange: (paneId: PaneId, camera: CameraSnapshot) => void
  onReadyContext: (paneId: PaneId, context: WorldPresentationContext | null) => void
  cameraLinkPane: CameraLinkPaneId
}) {
  useEffect(() => {
    onReadyContext(paneId, state.kind === 'ready' ? state.data.context : null)
  }, [paneId, state, onReadyContext])
  if (state.kind === 'loading') {
    return <div className="comparison-pane-message" role="status">正在读取这个世界…</div>
  }
  if (state.kind === 'unsupported') {
    const alternatives: readonly SpaceDescriptor[] = state.alternatives ?? []
    return (
      <div className="comparison-pane-message" role="status" data-unsupported-code={state.code}>
        <p>{state.reason}</p>
        {alternatives.length > 0 && (
          <div className="comparison-pane-alternatives">
            {alternatives.map(space => (
              <button key={space.id} type="button" onClick={() => onTargetChange(paneId === 'single' ? 'single' : paneId, { ...target, spaceId: space.id })}>
                改看{space.label}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="comparison-pane-message" role="alert">
        <p>{state.message}</p>
        {state.retryable && <button type="button" onClick={retry}>重试此侧</button>}
      </div>
    )
  }
  const data = state.data
  const context = data.context
  return <>
    <div className="comparison-pane-facts" data-testid={`pane-facts-${paneId}`}>
      <span>{IDENTITY_LABELS[context.identity]}</span>
      <span>{timelineLabel(context, worlds)}</span>
      <span>{spaceLabel(context)}</span>
      <time dateTime={context.simNow}>{context.simNow}</time>
    </div>
    {context.availableSpaces.length > 1 && (
      <label className="comparison-pane-space">
        <span className="sr-only">{paneId}空间</span>
        <select
          aria-label={`${paneId}空间`}
          value={context.spaceId}
          onChange={event => onTargetChange(paneId === 'single' ? 'single' : paneId, { ...target, spaceId: event.currentTarget.value })}
        >
          {context.availableSpaces.map(space => (
            <option key={space.id} value={space.id} disabled={!space.supportedPresentations.includes(context.presentation)}>
              {space.label}{space.supportedPresentations.includes(context.presentation) ? '' : '（当前表现不支持）'}
            </option>
          ))}
        </select>
      </label>
    )}
    <PresentationHost
      data={data as PresentationContext}
      adapters={adapters}
      store={store}
      onCameraChange={camera => onCameraChange(paneId, camera)}
      onMounted={(entry: MountedPresentationForKind | null) => {
        if (paneId !== 'single') onMounted(cameraLinkPane, entry)
      }}
    />
  </>
}

export default function ComparisonHost({ left, right, loadSession, adapters, store, worlds, onTargetChange, onExit }: ComparisonHostProps) {
  const coordinator = useMemo(() => createCameraLinkCoordinator(), [])
  const coordinatorEffectGeneration = useRef(0)
  const [cameraLinkEnabled, setCameraLinkEnabled] = useState(false)
  const [, setBindingRevision] = useState(0)
  const mountedPanes = useRef<Partial<Record<CameraLinkPaneId, CameraLinkPane>>>({})
  const cameraKeys = useRef<Partial<Record<CameraLinkPaneId, string>>>({})
  const [readyContexts, setReadyContexts] = useState<Partial<Record<PaneId, WorldPresentationContext>>>({})
  const onReadyContext = useCallback((paneId: PaneId, context: WorldPresentationContext | null) => {
    setReadyContexts(previous => {
      if ((previous[paneId] ?? null) === context) return previous
      const next = { ...previous }
      if (context) next[paneId] = context
      else delete next[paneId]
      return next
    })
  }, [])
  const linkScopeOf = (paneId: 'left' | 'right'): CameraLinkScope => {
    const context = readyContexts[paneId]
    const target = paneId === 'right' ? right : left
    if (!target) return { worldId: '', presentation: 'voxel3d' }
    return context
      ? { worldId: context.worldId, presentation: context.presentation, spaceId: context.spaceId }
      : { worldId: target.worldId, presentation: target.presentation, spaceId: target.spaceId }
  }
  const compatible = right !== null && canLinkCameras(linkScopeOf('left'), linkScopeOf('right'))
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
      <Pane paneId={right ? 'left' : 'single'} target={left} loadSession={loadSession} adapters={adapters} store={store} worlds={worlds} onTargetChange={onTargetChange} onMounted={bindPane} onCameraChange={reportCamera} onReadyContext={onReadyContext} />
      {right ? <Pane paneId="right" target={right} loadSession={loadSession} adapters={adapters} store={store} worlds={worlds} onTargetChange={onTargetChange} onMounted={bindPane} onCameraChange={reportCamera} onReadyContext={onReadyContext} /> : (
        <button className="comparison-open-split" type="button" onClick={() => onTargetChange('right', { ...left, presentation: left.presentation })}>添加比较视口</button>
      )}
      {right && (
        <label
          className="comparison-camera-link"
          data-testid="comparison-camera-link"
          data-camera-link-enabled={cameraLinkEnabled}
          data-camera-link-compatible={compatible}
          data-camera-left-mounted={Boolean(mountedPanes.current.left)}
          data-camera-right-mounted={Boolean(mountedPanes.current.right)}
          data-camera-link-active={coordinator.isLinkActive()}
          title={compatible ? undefined : '两侧的世界、空间或表现不同，无法联动相机。'}
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
