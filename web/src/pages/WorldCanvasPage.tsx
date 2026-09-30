import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, clearToken, lifeApi, mapApi, publicApi, subscribeWorldStream, worldSceneApi, worldsApi } from '../api/client'
import type { SceneDocument, SceneDocumentV2, SceneMode, SceneOperation, ScenePreviewResult } from '@possibility/scene-contract'
import type { SceneCamera } from '../scene/renderer/WorldCanvasRenderer'
import type { TimelineComparison, TimelineInfo, WorldSnapshot } from '../api/types'
import { applySceneOperations, contemporaryTheme } from '@possibility/scene-contract'
import { WorldCanvasViewport } from '../components/scene/WorldCanvasViewport'
import { WorldModeSwitcher } from '../components/scene/WorldModeSwitcher'
import { SceneAssetDrawer } from '../components/scene/SceneAssetDrawer'
import { SceneAiComposer } from '../components/scene/SceneAiComposer'
import { ScenePreviewBar } from '../components/scene/ScenePreviewBar'
import { SceneObjectInspector } from '../components/scene/SceneObjectInspector'
import { SceneHistoryControls } from '../components/scene/SceneHistoryControls'
import { SceneHistoryPanel, type SceneRevisionItem } from '../components/scene/SceneHistoryPanel'
import { SceneLockControls } from '../components/scene/SceneLockControls'
import { LegacySceneOnboarding } from '../components/scene/LegacySceneOnboarding'
import { SceneFallbackView } from '../components/scene/SceneFallbackView'
import { DesktopEditingNotice } from '../components/scene/DesktopEditingNotice'
import { buildSceneOverlay } from '../scene/life/overlay'
import { SceneTimelineGuard } from '../scene/life/timelineGuard'
import { RequestScopeController } from '../world/requestScope'
import VoxelViewport from '../voxel/VoxelViewport'
import type { OrbitPose } from '../voxel/engine'
import { isVoxelEnabled, parseVoxelDocument, parseVoxelSpaces } from '../voxel/flags'
import AlignedTimeline from '../components/world/AlignedTimeline'
import { buildAlignedAxis, filterAt, type AxisMarker } from '../world/alignedTimeline'
import WorldView from './WorldView'
import { GuestWorldMap } from '../components/map/GuestWorldMap'

type RevisionPreview = { result: ScenePreviewResult; operations: SceneOperation[]; summary: string; warnings: string[] }
export default function WorldCanvasPage({ worldId, readonly = false, guest = false }: { worldId: string; readonly?: boolean; guest?: boolean }) {
  const [search, setSearch] = useSearchParams(); const timelineId = search.get('timeline'); const navigate = useNavigate()
  const [worldChoices, setWorldChoices] = useState<{ id: string; name: string }[]>([])
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null); const [scene, setScene] = useState<SceneDocument | null>(null)
  const [multiScene, setMultiScene] = useState<SceneDocumentV2 | null>(null)
  const [resumeSpaceId, setResumeSpaceId] = useState('exterior')
  const [resumeMode, setResumeMode] = useState<'create' | 'life' | 'possibility'>('life')
  const [otherSnapshot, setOtherSnapshot] = useState<WorldSnapshot | null>(null)
  const [comparisonCamera, setComparisonCamera] = useState<SceneCamera | null>(null)
  const [compareSummary, setCompareSummary] = useState<{ facts: number; states: number; events: number } | null>(null)
  // S1 分屏:右线显式选择(URL ?right= 驱动)、完整对照数据、拖档对齐时刻、相机联动
  const [rightTimelineId, setRightTimelineId] = useState<string | null>(() => search.get('right'))
  const [comparison, setComparison] = useState<TimelineComparison | null>(null)
  const [scrubAt, setScrubAt] = useState<string | null>(null)
  const [cameraLinked, setCameraLinked] = useState(true)
  const [sharedPose, setSharedPose] = useState<OrbitPose | null>(null)
  const [splitWalk, setSplitWalk] = useState<{ left: boolean; right: boolean }>({ left: false, right: false })
  const [smallSide, setSmallSide] = useState<'left' | 'right'>('left')
  const [selectedSplitEvent, setSelectedSplitEvent] = useState<string | null>(null)
  const splitEventEls = useRef(new Map<string, HTMLElement>())
  const rightScope = useRef<RequestScopeController | null>(null)
  const [mode, setMode] = useState<SceneMode>(() => search.get('mode') === 'possibility' ? 'possibility' : 'life'); const [selected, setSelected] = useState<string | null>(null); const [drawer, setDrawer] = useState(false)
  const [preview, setPreview] = useState<RevisionPreview | null>(null); const [instruction, setInstruction] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const [history, setHistory] = useState<SceneDocument[]>([]); const [future, setFuture] = useState<SceneDocument[]>([]); const [editingNotice, setEditingNotice] = useState(false)
  const [revisionList, setRevisionList] = useState<SceneRevisionItem[] | null>(null)
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null)
  const [legacyPreview, setLegacyPreview] = useState<{ document: SceneDocument; explanation: string; warnings: string[] } | null>(null)
  const [mapFallback, setMapFallback] = useState(false)
  const requestScope = useRef<RequestScopeController | null>(null)
  if (!requestScope.current) requestScope.current = new RequestScopeController({ worldId, timelineId: timelineId ?? '', spaceId: 'exterior' })
  const snapshotVersion = useRef(0); snapshotVersion.current = snapshot?.stateVersion ?? 0
  const isSmall = useMemo(() => typeof window !== 'undefined' && matchMedia('(max-width: 767px)').matches, [])
  const read = useCallback(async () => {
    setError(''); setMapFallback(false)
    const scopes = requestScope.current!
    scopes.update({ worldId, timelineId: timelineId ?? '', spaceId: 'exterior' })
    const request = scopes.create()
    try {
      if (readonly && !guest) {
        const [world, current] = await Promise.all([publicApi.snapshot(worldId, timelineId ?? undefined, request.controller.signal), publicApi.scene(worldId, request.controller.signal)])
        if (!scopes.accepts(request.scope)) return
        setSnapshot(world)
        if (current.status === 'ready' && 'size' in current.document) { setScene(current.document); setMultiScene(null) }
        else { setScene(null); setMapFallback(true); setError('演示地图场景暂不可用；演示世界仍可通过文字视图查看。') }
      } else {
        const bootstrap = await mapApi.bootstrap(worldId, timelineId ?? undefined, request.controller.signal)
        if (!scopes.accepts(request.scope)) return
        setSnapshot(bootstrap.world)
        setResumeSpaceId(bootstrap.resume.spaceId)
        setResumeMode(bootstrap.resume.mode)
        if (bootstrap.scene.status === 'ready' || bootstrap.scene.status === 'legacy') {
          if ('size' in bootstrap.scene.document) { setScene(bootstrap.scene.document); setMultiScene(null) }
          else { setScene(null); setMultiScene(bootstrap.scene.document as SceneDocumentV2) }
        } else if (bootstrap.scene.status === 'unavailable') {
          setScene(null); setMapFallback(true); setError('地图场景读取失败；可以重试或打开文字世界视图。')
        } else setScene(null)
      }
    } catch (e) { if (scopes.accepts(request.scope)) setError(e instanceof Error ? e.message : '画布加载失败') }
    finally { request.controller.abort() }
  }, [worldId, timelineId, readonly, guest])
  useEffect(() => { void read() }, [read])

  useEffect(() => {
    if (readonly || guest) return
    let active = true
    void worldsApi.list().then(result => {
      if (active) setWorldChoices(result.worlds.map(world => ({ id: world.id, name: world.name })))
    }).catch(() => {})
    return () => { active = false }
  }, [readonly, guest])

  useEffect(() => {
    if (!snapshot || (readonly && !guest)) return
    let active = true
    void mapApi.saveResume(worldId, { timelineId: snapshot.currentTimelineId, spaceId: 'exterior', mode })
      .catch(() => { if (active) setError('地图恢复位置暂未保存；当前世界仍可继续使用。') })
    return () => { active = false }
  }, [worldId, snapshot?.currentTimelineId, mode, readonly, guest])

  useEffect(() => {
    if (!snapshot || guest) return
    const activeTimeline = timelineId ?? snapshot.currentTimelineId
    const guard = new SceneTimelineGuard(); guard.setTimeline(activeTimeline)
    let active = true
    const unsubscribe = subscribeWorldStream(worldId, activeTimeline, event => {
      if (!active || !guard.accepts(event.timelineId) || event.stateVersion <= snapshotVersion.current) return
      void worldsApi.snapshot(worldId, activeTimeline).then(next => {
        if (active && guard.accepts(next.currentTimelineId)) setSnapshot(current => current?.currentTimelineId === activeTimeline && current.stateVersion < next.stateVersion ? next : current)
      }).catch(() => { if (active) setError('生活状态暂时无法更新；场景仍可继续浏览。') })
    }, { isPublic: readonly, onError: () => { if (active) setError('生活连接中断；基础场景仍可继续浏览。') } })
    return () => { active = false; unsubscribe() }
  }, [snapshot?.currentTimelineId, worldId, timelineId, readonly, guest])

  useEffect(() => {
    if (mode !== 'possibility' || !snapshot) {
      setOtherSnapshot(null); setComparison(null); setCompareSummary(null)
      setScrubAt(null); setSplitWalk({ left: false, right: false })
      return
    }
    const currentId = snapshot.currentTimelineId
    const target = snapshot.timelines.find(item => item.id === rightTimelineId && item.id !== currentId)
      ?? snapshot.timelines.find(item => item.id !== currentId)
    if (!target) { setOtherSnapshot(null); setComparison(null); setCompareSummary(null); return }
    if (target.id !== rightTimelineId) setRightTimelineId(target.id) // 缺省回退:第一条其他线
    // 右侧独立 RequestScopeController:切线/失败不影响左侧通道(F2 隔离)
    const scopes = rightScope.current ?? (rightScope.current = new RequestScopeController({ worldId, timelineId: target.id, spaceId: 'exterior' }))
    scopes.update({ worldId, timelineId: target.id, spaceId: 'exterior' })
    const request = scopes.create()
    let active = true
    void Promise.all([
      worldsApi.snapshot(worldId, target.id),
      lifeApi.compare(worldId, currentId, target.id),
    ]).then(([other, result]) => {
      if (!active || !scopes.accepts(request.scope) || other.currentTimelineId !== target.id) return
      setOtherSnapshot(other)
      setComparison(result)
      setCompareSummary({
        facts: result.differences.facts.length,
        states: result.differences.states.length,
        events: result.differences.events.leftOnly.length + result.differences.events.rightOnly.length,
      })
    }).catch(e => { if (active && scopes.accepts(request.scope)) setError(e instanceof Error ? e.message : '时间线对照暂时不可用') })
    return () => { active = false }
  }, [mode, snapshot, worldId, rightTimelineId])

  // 右侧独立 SSE 订阅:右侧事件只驱动右侧 snapshot 刷新(F2 隔离)
  useEffect(() => {
    if (mode !== 'possibility' || !otherSnapshot || guest) return
    const rightId = otherSnapshot.currentTimelineId
    let active = true
    let version = otherSnapshot.stateVersion
    const unsubscribe = subscribeWorldStream(worldId, rightId, event => {
      if (!active || event.timelineId !== rightId || event.stateVersion <= version) return
      void worldsApi.snapshot(worldId, rightId).then(next => {
        if (!active || next.currentTimelineId !== rightId) return
        version = Math.max(version, next.stateVersion)
        setOtherSnapshot(current => current?.currentTimelineId === rightId && current.stateVersion < next.stateVersion ? next : current)
      }).catch(() => {})
    }, { isPublic: readonly, onError: () => {} })
    return () => { active = false; unsubscribe() }
  }, [mode, otherSnapshot?.currentTimelineId, worldId, readonly, guest])

  // URL 驱动:mode/right 状态同步回地址栏(入口深链 ?mode=possibility&right=<id>)
  useEffect(() => {
    const params = new URLSearchParams(search)
    let changed = false
    if (mode === 'possibility') {
      if (params.get('mode') !== 'possibility') { params.set('mode', 'possibility'); changed = true }
      if (rightTimelineId && params.get('right') !== rightTimelineId) { params.set('right', rightTimelineId); changed = true }
    } else {
      if (params.has('mode')) { params.delete('mode'); changed = true }
      if (params.has('right')) { params.delete('right'); changed = true }
    }
    if (changed) setSearch(params, { replace: true })
  }, [mode, rightTimelineId, search, setSearch])

  const overlay = useMemo(() => snapshot ? buildSceneOverlay(snapshot, snapshot.currentTimelineId) : null, [snapshot])
  const otherOverlay = useMemo(() => otherSnapshot ? buildSceneOverlay(otherSnapshot, otherSnapshot.currentTimelineId) : null, [otherSnapshot])
  // 体素特性开关（T30）：服务端返回体素文档时挂载新视口；2D 场景行为不变
  const voxelDoc = useMemo(() => (isVoxelEnabled() ? parseVoxelDocument(scene) : null), [scene])
  // 多空间体素包（T32）：走 GuestWorldMap 的体素模式（外景 ↔ 主楼）
  // 体素形状的文档没有 2D 回退可渲染，故不受 ?voxel 开关限制；开关只决定 2D 场景是否改用体素视口
  const voxelSpaces = useMemo(() => parseVoxelSpaces(multiScene ?? scene), [multiScene, scene])
  // S1 分屏:轴模型(纯函数) + 拖档截断;拖档只过滤事件流,视口始终渲染当前状态
  const axis = useMemo(() => comparison ? buildAlignedAxis(comparison) : null, [comparison])
  const scrubbed = useMemo(() => axis && scrubAt ? filterAt(axis, scrubAt) : null, [axis, scrubAt])
  const linkActive = cameraLinked && !splitWalk.left && !splitWalk.right
  const fmtSim = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const splitEvents = (side: 'left' | 'right', snap: WorldSnapshot | null) => {
    if (!snap) return []
    let list = snap.events
    if (scrubbed) {
      const ids = new Set([...scrubbed.shared, ...(side === 'left' ? scrubbed.left : scrubbed.right)].map(m => m.eventId))
      list = list.filter(event => ids.has(event.id))
    }
    return list.slice(-5)
  }
  const handleSelectMarker = useCallback((marker: AxisMarker) => {
    const side = marker.side === 'right' ? 'right' : 'left'
    const key = `${side}:${marker.eventId}`
    setSelectedSplitEvent(key)
    const reduced = typeof window !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
    splitEventEls.current.get(key)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })
  }, [])
  const swapSplit = () => {
    if (!otherSnapshot) return
    setRightTimelineId(snapshot!.currentTimelineId)
    const params = new URLSearchParams(search)
    params.set('timeline', otherSnapshot.currentTimelineId)
    setSearch(params)
  }
  const closeSplit = (side: 'left' | 'right') => {
    const params = new URLSearchParams(search)
    if (side === 'left' && otherSnapshot) params.set('timeline', otherSnapshot.currentTimelineId)
    params.delete('mode'); params.delete('right')
    setSearch(params)
    setMode('life')
  }
  async function requestLegacyPreview() {
    setBusy(true); setError('')
    try { setLegacyPreview(await worldSceneApi.legacyPreview(worldId)) }
    catch (e) { setError(e instanceof Error ? e.message : '布局生成失败；原世界仍然可用。') }
    finally { setBusy(false) }
  }
  async function confirmLegacy() {
    if (!legacyPreview) return
    setBusy(true); setError('')
    try { const result = await worldSceneApi.legacyConfirm(worldId, legacyPreview.document); setScene(result.document); setLegacyPreview(null) }
    catch (e) { setError(e instanceof Error ? e.message : '布局保存失败') }
    finally { setBusy(false) }
  }
  async function submitOperation(operation: SceneOperation) {
    if (!scene) return
    if (isSmall) { setEditingNotice(true); return }
    try {
      const result = applySceneOperations(scene, [operation], contemporaryTheme)
      setHistory(items => [...items, scene]); setFuture([]); setScene(result.document)
      setBusy(true); setError('')
      const saved = await worldSceneApi.commit(worldId, scene.version, crypto.randomUUID(), [operation])
      setScene(saved.document)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setError('场景有新版本，请重新加载后再继续。'); void read() }
      else setError(e instanceof Error ? e.message : '调整未保存')
      void read()
    } finally { setBusy(false) }
  }
  async function requestEditPreview() {
    if (!scene || !instruction.trim() || busy) return
    setBusy(true); setError('')
    try {
      const response = await worldSceneApi.editPreview(worldId, instruction, scene.version)
      setPreview({ result: { document: response.preview.result, changes: response.preview.changes }, operations: response.preview.operations, summary: response.preview.summary, warnings: response.preview.warnings })
    } catch (e) { setError(e instanceof Error ? e.message : '预览失败；当前场景没有改变。') }
    finally { setBusy(false) }
  }
  async function applyPreview() {
    if (!scene || !preview) return
    setBusy(true); setError('')
    try { const saved = await worldSceneApi.commit(worldId, scene.version, crypto.randomUUID(), preview.operations, 'ai-edit'); setHistory(items => [...items, scene]); setFuture([]); setScene(saved.document); setPreview(null); setInstruction('') }
    catch (e) { setError(e instanceof Error ? e.message : '预览保存失败'); if (e instanceof ApiError && e.status === 409) void read() }
    finally { setBusy(false) }
  }
  function undo() { const previous = history.at(-1); if (!previous || !scene) return; setFuture(items => [scene, ...items]); setHistory(items => items.slice(0, -1)); void restore(previous) }
  function redo() { const next = future[0]; if (!next || !scene) return; setHistory(items => [...items, scene]); setFuture(items => items.slice(1)); void restore(next) }
  async function restore(target: SceneDocument) {
    if (!scene) return
    const saved = await worldSceneApi.restore(worldId, scene.version, target.version || 1)
    setScene(saved.document)
  }
  async function loadRevisionList() {
    try { setRevisionList((await worldSceneApi.history(worldId)).revisions) }
    catch (e) { setError(e instanceof Error ? e.message : '场景历史读取失败') }
  }
  async function restoreVersion(version: number) {
    if (!scene) return
    setBusy(true)
    try { const result = await worldSceneApi.restore(worldId, scene.version, version); setHistory(items => [...items, scene]); setFuture([]); setScene(result.document); setRevisionList(null) }
    catch (e) { setError(e instanceof Error ? e.message : '场景恢复失败'); if (e instanceof ApiError && e.status === 409) void read() }
    finally { setBusy(false) }
  }
  function armAsset(assetId: string) { setActiveAssetId(assetId); setError('请在画布上点击落点；道路和水面可以拖动画笔。') }
  function placeAt(assetId: string, position: { x: number; y: number }) {
    const asset = contemporaryTheme.assets.find(item => item.id === assetId); if (!asset || !scene) return
    if (asset.category === 'person') {
      const target = scene.objects.find(object => object.id === selected && object.binding?.kind === 'person') ?? scene.objects.find(object => object.binding?.kind === 'person')
      if (!target) { setError('当前场景没有可更换外观的居民。'); return }
      void submitOperation({ type: 'replace_asset', objectId: target.id, assetId }); return
    }
    if (asset.category === 'building') {
      const target = scene.objects.find(object => object.id === selected && object.binding?.kind === 'location')
      if (target) { void submitOperation({ type: 'replace_asset', objectId: target.id, assetId }); return }
    }
    if (asset.category === 'terrain') return void submitOperation({ type: 'paint_cells', category: 'terrain', assetId, cells: [position] })
    if (asset.category === 'road' || asset.category === 'water') return void submitOperation({ type: 'paint_cells', category: asset.category, assetId, cells: [position] })
    submitOperation({ type: 'add_object', object: { id: crypto.randomUUID(), assetId, position, binding: null, label: null, purpose: null } })
  }
  function paintCells(cells: { x: number; y: number }[]) {
    const asset = contemporaryTheme.assets.find(item => item.id === activeAssetId)
    if (!asset || !scene || !['terrain', 'road', 'water'].includes(asset.category)) return
    void submitOperation({ type: 'paint_cells', category: asset.category as 'terrain' | 'road' | 'water', assetId: asset.id, cells })
  }
  function toggleLock() { if (selected && scene) void submitOperation({ type: 'lock_object', objectId: selected, locked: !scene.lockedObjectIds.includes(selected) }) }

  // S1 分屏渲染(体素):左右各绑一线,标题/时钟/事件流各归各线,相机联动可开关
  const sideInfo = (snap: WorldSnapshot | null): TimelineInfo | null =>
    snap ? snap.timelines.find(t => t.id === snap.currentTimelineId) ?? null : null
  const renderSplitSideHeader = (side: 'left' | 'right', snap: WorldSnapshot | null) => {
    const info = sideInfo(snap)
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <p className="font-medium text-[#405447]" data-testid={`split-title-${side}`}>
          {side === 'left' ? '原来的发展' : '另一种发展'} · {info ? (info.parentTimelineId ? '分叉' : '主线') : '…'}
          {info?.forkScenario?.whatIf ? <span className="ml-1 font-normal text-[#687a6b]">如果{info.forkScenario.whatIf}</span> : null}
        </p>
        <div className="flex items-center gap-2">
          {scrubAt && snap && scrubAt < snap.simNow && (
            <span data-testid={`split-current-badge-${side}`} className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800">视口为当前状态</span>
          )}
          <span data-testid={`split-clock-${side}`} className="text-[#849184]">{snap ? fmtSim(snap.simNow) : '读取中…'}</span>
          <button type="button" data-testid={`split-close-${side}`} onClick={() => closeSplit(side)} className="rounded-full border border-[#d7ded3] bg-white px-2 py-0.5 text-[10px] text-[#536558]">关闭分屏</button>
        </div>
      </div>
    )
  }
  const renderSplitEvents = (side: 'left' | 'right', snap: WorldSnapshot | null) => {
    const items = splitEvents(side, snap)
    return (
      <ul data-testid={`split-events-${side}`} className="max-h-28 space-y-1 overflow-y-auto rounded-xl bg-white/70 px-3 py-2 text-[11px] text-[#526558]">
        {items.length === 0 && <li className="text-[#849184]">这段时间没有已记录的事件。</li>}
        {items.map(event => {
          const key = `${side}:${event.id}`
          return (
            <li key={event.id}
              ref={(el) => { if (el) splitEventEls.current.set(key, el); else splitEventEls.current.delete(key) }}
              data-testid="split-event" data-event-id={event.id}
              className={`rounded px-1 py-0.5 ${selectedSplitEvent === key ? 'bg-amber-100' : ''}`}>
              <span className="font-medium">{event.title}</span>
              <span className="ml-1 text-[#849184]">{event.simTime.slice(0, 16).replace('T', ' ')}</span>
            </li>
          )
        })}
      </ul>
    )
  }
  const renderSplitView = () => {
    const rightChoices = snapshot!.timelines.filter(t => t.id !== snapshot!.currentTimelineId)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="split-view">
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
          <section className="flex min-h-[430px] flex-col gap-2" data-testid="split-left">
            {renderSplitSideHeader('left', snapshot)}
            <div className="min-h-0 flex-1">
              <VoxelViewport document={voxelDoc!} overlay={overlay} instanceId="left" probePrimary
                cameraPose={linkActive ? sharedPose : undefined}
                onCameraChange={setSharedPose}
                onCameraModeChange={(m) => setSplitWalk(s => ({ ...s, left: m === 'walk' }))} />
            </div>
            {renderSplitEvents('left', snapshot)}
          </section>
          <section className="flex min-h-[430px] flex-col gap-2" data-testid="split-right">
            {renderSplitSideHeader('right', otherSnapshot)}
            <div className="flex items-center gap-2 text-xs">
              <select aria-label="右侧时间线" data-testid="split-right-selector" value={otherSnapshot?.currentTimelineId ?? rightTimelineId ?? ''}
                onChange={(e) => setRightTimelineId(e.target.value)}
                className="max-w-64 rounded-full border border-[#d7ded3] bg-white/90 px-3 py-1.5 text-xs text-[#536558]">
                {rightChoices.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.parentTimelineId ? '分叉' : '主线'} · {t.simNow.slice(0, 16).replace('T', ' ')}{t.forkScenario?.whatIf ? ` · 如果${t.forkScenario.whatIf}` : ''}
                  </option>
                ))}
              </select>
              <button type="button" data-testid="split-swap" onClick={swapSplit} disabled={!otherSnapshot} className="rounded-full border border-[#d7ded3] bg-white px-3 py-1.5 text-[10px] text-[#536558] disabled:opacity-50">⇄ 互换左右</button>
            </div>
            <div className="min-h-0 flex-1">
              {otherSnapshot
                ? <VoxelViewport document={voxelDoc!} overlay={otherOverlay} instanceId="right"
                    cameraPose={linkActive ? sharedPose : undefined}
                    onCameraChange={setSharedPose}
                    onCameraModeChange={(m) => setSplitWalk(s => ({ ...s, right: m === 'walk' }))} />
                : <div className="grid h-full min-h-[430px] place-items-center rounded-2xl bg-white/60 text-sm text-[#718075]">正在读取另一种发展…</div>}
            </div>
            {renderSplitEvents('right', otherSnapshot)}
          </section>
        </div>
        {axis && <AlignedTimeline axis={axis} at={scrubAt} onScrub={setScrubAt} onSelect={handleSelectMarker} />}
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-white/70 px-3 py-2 text-xs text-[#526558]">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" data-testid="split-camera-link" checked={cameraLinked} onChange={(e) => setCameraLinked(e.target.checked)} />
            相机联动
          </label>
          {(splitWalk.left || splitWalk.right) && <span data-testid="split-walk-notice" className="text-amber-700">第一视角下相机联动已暂停（两线的「我」不在同一位置）</span>}
          <span className="text-[#849184]">联动开启时，一侧的旋转/缩放/平移同步到另一侧</span>
        </div>
        {comparison && comparison.limitations.length > 0 && (
          <ul data-testid="split-limitations" className="space-y-0.5 text-[10px] text-[#849184]">
            {comparison.limitations.map((x, i) => <li key={i}>· {x}</li>)}
          </ul>
        )}
      </div>
    )
  }
  // S1 窄屏降级:单视口 + 左右切换,入口提示保留(N4)
  const renderSmallSplit = () => {
    const snap = smallSide === 'left' ? snapshot : otherSnapshot
    const info = sideInfo(snap)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="split-small">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <p className="font-medium text-[#405447]" data-testid="split-small-title">
            {smallSide === 'left' ? '原来的发展' : '另一种发展'} · {info ? (info.parentTimelineId ? '分叉' : '主线') : '…'}
            <span className="ml-1 font-normal text-[#849184]">{snap ? fmtSim(snap.simNow) : '读取中…'}</span>
          </p>
          <div className="flex items-center gap-2">
            <button type="button" data-testid="split-small-toggle" onClick={() => setSmallSide(s => (s === 'left' ? 'right' : 'left'))} disabled={!otherSnapshot}
              className="rounded-full border border-[#d7ded3] bg-white px-3 py-1.5 text-[10px] text-[#536558] disabled:opacity-50">
              看{smallSide === 'left' ? '另一种' : '原来的'}发展
            </button>
            <button type="button" data-testid="split-close-small" onClick={() => closeSplit(smallSide)} className="rounded-full border border-[#d7ded3] bg-white px-3 py-1.5 text-[10px] text-[#536558]">关闭分屏</button>
          </div>
        </div>
        {snap
          ? <VoxelViewport document={voxelDoc!} overlay={smallSide === 'left' ? overlay : otherOverlay}
              instanceId={smallSide === 'left' ? 'left' : 'right'} probePrimary={smallSide === 'left'} />
          : <div className="grid min-h-[430px] place-items-center rounded-2xl bg-white/60 text-sm text-[#718075]">正在读取另一种发展…</div>}
        <p className="text-[10px] text-[#849184]">窄屏仅显示单视口；大屏可同时分屏查看两条时间线。</p>
      </div>
    )
  }

  if (search.get('view') === 'text') return <div className="h-full"><button onClick={() => { search.delete('view'); setSearch(search, { replace: true }) }} className="m-3 rounded-full border bg-white px-4 py-2 text-sm">返回世界画布</button><WorldView worldId={worldId} readonly={readonly && !guest} /></div>
  if (mapFallback && snapshot) return <div className="flex min-h-full items-center bg-[#eef0e7] p-4"><SceneFallbackView message={error || '地图资源暂时不可用。'} onRetry={() => void read()} onReturn={() => { search.set('view', 'text'); setSearch(search) }} /></div>
  if (error && !snapshot) return <div className="flex min-h-full items-center bg-[#eef0e7] p-4"><SceneFallbackView message={error} onRetry={() => void read()} onReturn={() => { search.set('view', 'text'); setSearch(search) }} /></div>
  if (!snapshot) return <div className="grid min-h-full place-items-center text-sm text-[#718075]">正在准备这方天地…</div>
  if (voxelSpaces) return <GuestWorldMap voxelSpaces={voxelSpaces} snapshot={snapshot} overlay={overlay} initialSpaceId={resumeSpaceId} initialMode={resumeMode} guest={guest} />
  if (multiScene) return <GuestWorldMap scene={multiScene} snapshot={snapshot} overlay={overlay} initialSpaceId={resumeSpaceId} initialMode={resumeMode} guest={guest} />
  if (!scene && !legacyPreview) return <div className="grid min-h-[calc(100vh-7rem)] bg-[#eef0e7] p-4"><div className="m-auto w-full max-w-xl"><LegacySceneOnboarding busy={busy} error={error} onPreview={requestLegacyPreview} onReturn={() => { search.set('view', 'text'); setSearch(search) }} /></div></div>
  const shown = legacyPreview?.document ?? scene!
  const currentPreview = legacyPreview ? { document: legacyPreview.document, changes: { added: legacyPreview.document.objects.map(o => o.id), moved: [], updated: [], removed: [] } } : preview?.result ?? null
  const selectedObject = selected ? shown.objects.find(object => object.id === selected) ?? null : null
  const selectedLocationName = selectedObject?.binding?.kind === 'location' ? selectedObject.binding.locationName : null
  const selectedPersonId = selectedObject?.binding?.kind === 'person' ? selectedObject.binding.personId : null
  const selectedLocation = selectedLocationName ? snapshot.world.locations.find(location => location.name === selectedLocationName) : null
  const selectedLocationResidents = selectedLocationName ? snapshot.locationBoard.find(row => row.location === selectedLocationName)?.persons ?? [] : []
  const selectedResident = selectedPersonId ? snapshot.locationBoard.flatMap(row => row.persons).find(person => person.id === selectedPersonId) : null
  const selectedPersonLocation = selectedPersonId ? snapshot.locationBoard.find(row => row.persons.some(person => person.id === selectedPersonId))?.location : null
  const selectedEvents = selectedLocationName ? snapshot.events.filter(event => event.location === selectedLocationName).slice(-3).reverse() : []
  if (readonly) return <main className="relative h-full min-h-screen overflow-hidden bg-[#e7eee7]" data-testid="world-canvas-page">
    {voxelDoc
      ? <VoxelViewport document={voxelDoc} overlay={overlay} />
      : <WorldCanvasViewport scene={shown} mode="life" overlay={overlay} selectedId={selected} onSelect={setSelected} edgeToEdge />}
    <div className="pointer-events-none absolute inset-0 z-10">
      <header className="pointer-events-auto absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-[#23382f]/65 to-transparent px-5 pb-8 pt-4 text-white sm:px-7">
        <div><p className="font-story text-xl font-semibold tracking-tight sm:text-2xl">Possibility</p><p className="text-[10px] tracking-[.24em] text-white/70">雾影庄 · 正在生活</p></div>
        <a href="/login" className="rounded-full border border-white/35 bg-[#263a31]/45 px-4 py-2 text-xs backdrop-blur-md transition hover:bg-[#263a31]/70 sm:text-sm">登录，创建你的世界</a>
      </header>
      <aside aria-label="地图索引" className="pointer-events-auto absolute bottom-16 left-3 top-24 flex w-44 flex-col overflow-hidden rounded-2xl border border-white bg-[#f8faf6] shadow-lg sm:left-5 sm:w-52">
        <div className="border-b border-[#dfe6dc] px-3 py-3"><p className="text-xs font-semibold text-[#405447]">地点</p><p className="mt-0.5 text-[10px] text-[#77867a]">选择后查看在场居民与事件</p></div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">{shown.objects.filter(object => object.binding?.kind === 'location').map(object => <button key={object.id} aria-pressed={selected === object.id} onClick={() => setSelected(object.id)} className={`block w-full rounded-xl px-3 py-2 text-left text-xs transition-colors ${selected === object.id ? 'bg-[#335744] text-white shadow-sm' : 'text-[#465b4d] hover:bg-white'}`}>{object.label ?? (object.binding?.kind === 'location' ? object.binding.locationName : '')}</button>)}</div>
        <div className="border-t border-[#dfe6dc] p-2"><p className="px-2 pb-1 text-[10px] font-semibold text-[#77867a]">居民</p><div className="flex flex-wrap gap-1">{shown.objects.filter(object => object.binding?.kind === 'person').map(object => <button key={object.id} aria-pressed={selected === object.id} onClick={() => setSelected(object.id)} className={`rounded-full px-2.5 py-1.5 text-[10px] transition-colors ${selected === object.id ? 'bg-[#335744] text-white' : 'bg-white/80 text-[#52665a] hover:bg-white'}`}>{object.label ?? '居民'}</button>)}</div></div>
      </aside>
      {(selectedObject || selectedLocationName) && <section aria-label="选中对象信息" className="pointer-events-auto absolute right-3 top-24 w-[min(20rem,calc(100vw-13.5rem))] rounded-2xl border border-white bg-[#f8faf6] p-4 text-[#405246] shadow-lg sm:right-5 sm:w-80">
        {selectedLocationName && <><div className="flex items-start justify-between gap-2"><div><p className="text-[10px] uppercase tracking-[.16em] text-[#7a897d]">地点</p><h1 className="mt-0.5 font-story text-lg">{selectedLocationName}</h1></div><button aria-label="关闭信息" onClick={() => setSelected(null)} className="rounded-full px-2 text-lg text-[#718075]">×</button></div><p className="mt-2 text-xs leading-relaxed text-[#69786c]">{selectedLocation?.description ?? '庄园中的一处地点。'}</p><p className="mt-3 border-t border-[#dfe6dc] pt-3 text-xs leading-relaxed text-[#526558]">此刻在这里：{selectedLocationResidents.length ? selectedLocationResidents.map(person => `${person.name}（${person.activity}）`).join('、') : '暂时没有居民'}</p>{selectedEvents.length > 0 && <ul className="mt-3 space-y-2 border-t border-[#dfe6dc] pt-3 text-xs">{selectedEvents.map(event => <li key={event.id}><span className="font-medium">{event.title}</span><span className="text-[#728076]"> · {event.description}</span></li>)}</ul>}</>}
        {selectedObject?.binding?.kind === 'person' && <><div className="flex items-start justify-between gap-2"><div><p className="text-[10px] uppercase tracking-[.16em] text-[#7a897d]">居民</p><h1 className="mt-0.5 font-story text-lg">{selectedObject.label ?? selectedResident?.name ?? '庄园居民'}</h1></div><button aria-label="关闭信息" onClick={() => setSelected(null)} className="rounded-full px-2 text-lg text-[#718075]">×</button></div><p className="mt-2 text-xs leading-relaxed text-[#69786c]">{selectedPersonLocation ? `现在在${selectedPersonLocation}` : '位置暂未记录'}{selectedResident ? ` · ${selectedResident.activity}` : ''}</p><p className="mt-3 border-t border-[#dfe6dc] pt-3 text-[10px] text-[#78867b]">人物状态来自当前世界快照</p></>}
      </section>}
      <div className="absolute bottom-4 left-3 rounded-full border border-white bg-[#f8faf6] px-3 py-2 text-[10px] text-[#4f6457] shadow-sm sm:left-5">拖动浏览 · 滚轮缩放 · 点击建筑或人物</div>
      <div className="absolute bottom-4 right-3 rounded-full border border-white bg-[#f8faf6] px-3 py-2 text-[10px] text-[#66776b] shadow-sm sm:right-5">{guest ? '访客副本 · 可安全体验' : '只读世界'} · {snapshot.locationBoard.reduce((total, row) => total + row.persons.length, 0)} 位居民</div>
    </div>
  </main>
  return <main className="flex min-h-screen flex-col gap-3 bg-[#eef0e7] p-3 sm:p-5" data-testid="world-canvas-page">
    {editingNotice && <DesktopEditingNotice onClose={() => setEditingNotice(false)} />}
    {revisionList && <SceneHistoryPanel revisions={revisionList} currentVersion={scene?.version ?? 0} busy={busy} onRestore={version => void restoreVersion(version)} onClose={() => setRevisionList(null)} />}
    {!readonly && <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-[.16em] text-[#849183]">{snapshot.world.name}</p><h1 className="font-story text-xl text-[#2d4435]">{mode === 'possibility' ? '另一种可能' : mode === 'create' ? '调整这方天地' : '这里正在生活'}</h1></div><div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="map-world-switcher">切换世界</label><select id="map-world-switcher" aria-label="切换世界" value={worldId} onChange={event => event.target.value === '__new__' ? navigate('/worlds/new') : navigate(`/worlds/${encodeURIComponent(event.target.value)}`)} className="max-w-44 rounded-full border border-[#d7ded3] bg-white/90 px-3 py-2 text-xs text-[#536558]">
        {worldChoices.map(world => <option key={world.id} value={world.id}>{world.name}</option>)}<option value="__new__">＋ 创建世界</option>
      </select>
      <button onClick={() => { search.set('view', 'text'); setSearch(search) }} className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]">世界动态与互动</button><WorldModeSwitcher mode={mode} editable={!!scene} onChange={next => { if (next === 'create' && isSmall) { setEditingNotice(true); return } setMode(next); setPreview(null) }} />{scene && <SceneHistoryControls version={scene.version} canUndo={history.length > 0} canRedo={future.length > 0} onUndo={undo} onRedo={redo} onHistory={() => void loadRevisionList()} />}
      <button aria-label="退出登录" title="退出登录" onClick={() => { clearToken(); navigate('/login', { replace: true }) }} className="rounded-full border border-[#d7ded3] bg-white/85 px-3 py-2 text-xs text-[#536558]">退出</button>
    </div></header>}
    {error && <p role="status" className="rounded-xl bg-white px-4 py-2 text-sm text-red-700">{error}</p>}
    {preview && <ScenePreviewBar summary={preview.summary} warnings={preview.warnings} onApply={applyPreview} onCancel={() => setPreview(null)} busy={busy} />}
    {legacyPreview && <ScenePreviewBar summary={legacyPreview.explanation} warnings={legacyPreview.warnings} onApply={confirmLegacy} onCancel={() => setLegacyPreview(null)} busy={busy} />}
    <div className="flex min-h-[500px] flex-1 gap-3"><div className="flex min-w-0 flex-1 flex-col gap-3">
      {mode === 'possibility' && voxelDoc && !isSmall ? renderSplitView() : mode === 'possibility' && voxelDoc ? renderSmallSplit() : mode === 'possibility' ? <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2"><section className="flex min-h-[430px] flex-col gap-2"><p className="text-xs font-medium text-[#687a6b]">原来的发展 · {snapshot.currentTimelineId.slice(0, 8)}</p><WorldCanvasViewport scene={shown} mode="life" overlay={overlay} selectedId={selected} camera={comparisonCamera} onCameraChange={setComparisonCamera} onSelect={setSelected} /></section><section className="flex min-h-[430px] flex-col gap-2"><p className="text-xs font-medium text-[#687a6b]">{otherSnapshot ? `另一种发展 · ${otherSnapshot.currentTimelineId.slice(0, 8)}` : '正在读取另一种发展…'}</p><WorldCanvasViewport scene={shown} mode="life" overlay={otherOverlay} selectedId={selected} camera={comparisonCamera} onCameraChange={setComparisonCamera} onSelect={setSelected} /></section>{compareSummary && <p className="text-xs text-[#687a6b] lg:col-span-2">已有记录：{compareSummary.facts} 项事实差异、{compareSummary.states} 组人物状态差异、{compareSummary.events} 条分支独有事件。场景布局相同；画面只显示各自时间线已记录的生活状态。</p>}</div> : voxelDoc ? <VoxelViewport document={voxelDoc} overlay={overlay} /> : <WorldCanvasViewport scene={shown} mode={mode} overlay={overlay} preview={currentPreview} selectedId={selected} activeAssetId={activeAssetId} onSelect={setSelected} onMove={submitOperation} onCanvasClick={position => activeAssetId && placeAt(activeAssetId, position)} onCanvasStroke={paintCells} />}
      {!readonly && mode === 'life' && <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-white/85 px-4 py-3 text-sm text-[#526558]"><span>{overlay?.timeOfDay === 'night' ? '夜色渐深，街灯亮起。' : overlay?.weather ? `此刻天气：${overlay.weather}` : '居民正按照自己的处境继续生活。'}</span><span className="text-xs text-[#849184]">{new Date(snapshot.simNow).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', weekday: 'short' })}</span></div>}
      {mode === 'create' && !isSmall && <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]"><div className="space-y-2"><SceneObjectInspector scene={shown} selectedId={selected} catalog={contemporaryTheme} /><SceneAiComposer value={instruction} onChange={setInstruction} onPreview={requestEditPreview} busy={busy} error="" /></div><div className="flex items-center gap-2"><SceneLockControls locked={!!selected && shown.lockedObjectIds.includes(selected)} onToggle={toggleLock} /><button onClick={() => setDrawer(value => !value)} className="rounded-full border border-[#d7ded3] bg-white px-4 py-3 text-sm text-[#42594a]">素材</button>{activeAssetId && <button onClick={() => setActiveAssetId(null)} className="text-xs text-[#617766]">取消放置</button>}</div></div>}
      {mode === 'possibility' && <button onClick={() => { search.set('view', 'text'); setSearch(search) }} className="self-start rounded-full border border-[#d6ddd3] bg-white px-4 py-2 text-sm text-[#47604f]">打开发展对照与分叉条件</button>}
    </div>{drawer && scene && mode === 'create' && <SceneAssetDrawer catalog={contemporaryTheme} onPlace={armAsset} onClose={() => setDrawer(false)} />}</div>
    {legacyPreview && <p className="text-center text-xs text-[#738074]">预览未保存；取消即可回到原来的世界页。</p>}
  </main>
}
