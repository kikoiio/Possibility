import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ApiError, lifeApi, subscribeWorldStream, worldSceneApi, worldsApi } from '../api/client'
import type { SceneDocument, SceneMode, SceneOperation, ScenePreviewResult } from '@possibility/scene-contract'
import type { SceneCamera } from '../scene/renderer/WorldCanvasRenderer'
import type { WorldSnapshot } from '../api/types'
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
import WorldView from './WorldView'

type RevisionPreview = { result: ScenePreviewResult; operations: SceneOperation[]; summary: string; warnings: string[] }
export default function WorldCanvasPage({ worldId }: { worldId: string }) {
  const [search, setSearch] = useSearchParams(); const timelineId = search.get('timeline')
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null); const [scene, setScene] = useState<SceneDocument | null>(null)
  const [otherSnapshot, setOtherSnapshot] = useState<WorldSnapshot | null>(null)
  const [comparisonCamera, setComparisonCamera] = useState<SceneCamera | null>(null)
  const [compareSummary, setCompareSummary] = useState<{ facts: number; states: number; events: number } | null>(null)
  const [mode, setMode] = useState<SceneMode>('life'); const [selected, setSelected] = useState<string | null>(null); const [drawer, setDrawer] = useState(false)
  const [preview, setPreview] = useState<RevisionPreview | null>(null); const [instruction, setInstruction] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const [history, setHistory] = useState<SceneDocument[]>([]); const [future, setFuture] = useState<SceneDocument[]>([]); const [editingNotice, setEditingNotice] = useState(false)
  const [revisionList, setRevisionList] = useState<SceneRevisionItem[] | null>(null)
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null)
  const [legacyPreview, setLegacyPreview] = useState<{ document: SceneDocument; explanation: string; warnings: string[] } | null>(null)
  const snapshotVersion = useRef(0); snapshotVersion.current = snapshot?.stateVersion ?? 0
  const isSmall = useMemo(() => typeof window !== 'undefined' && matchMedia('(max-width: 767px)').matches, [])
  const read = useCallback(async () => {
    setError('')
    try {
      const [world, current] = await Promise.all([worldsApi.snapshot(worldId, timelineId ?? undefined), worldSceneApi.get(worldId)])
      setSnapshot(world); setScene(current.status === 'ready' ? current.document : null)
    } catch (e) { setError(e instanceof Error ? e.message : '画布加载失败') }
  }, [worldId, timelineId])
  useEffect(() => { void read() }, [read])

  useEffect(() => {
    if (!snapshot) return
    const activeTimeline = timelineId ?? snapshot.currentTimelineId
    const guard = new SceneTimelineGuard(); guard.setTimeline(activeTimeline)
    let active = true
    const unsubscribe = subscribeWorldStream(worldId, activeTimeline, event => {
      if (!active || !guard.accepts(event.timelineId) || event.stateVersion <= snapshotVersion.current) return
      void worldsApi.snapshot(worldId, activeTimeline).then(next => {
        if (active && guard.accepts(next.currentTimelineId)) setSnapshot(current => current?.currentTimelineId === activeTimeline && current.stateVersion < next.stateVersion ? next : current)
      }).catch(() => { if (active) setError('生活状态暂时无法更新；场景仍可继续浏览。') })
    }, { onError: () => { if (active) setError('生活连接中断；基础场景仍可继续浏览。') } })
    return () => { active = false; unsubscribe() }
  }, [snapshot?.currentTimelineId, worldId, timelineId])

  useEffect(() => {
    if (mode !== 'possibility' || !snapshot) { setOtherSnapshot(null); setCompareSummary(null); return }
    const currentId = snapshot.currentTimelineId
    const target = snapshot.timelines.find(item => item.id !== currentId)
    if (!target) { setOtherSnapshot(null); setCompareSummary(null); return }
    let active = true
    void Promise.all([
      worldsApi.snapshot(worldId, target.id),
      lifeApi.compare(worldId, currentId, target.id),
    ]).then(([other, raw]) => {
      if (!active || other.currentTimelineId !== target.id) return
      setOtherSnapshot(other)
      const comparison = raw as { differences?: { facts?: unknown[]; states?: unknown[]; events?: { shared?: unknown[]; leftOnly?: unknown[]; rightOnly?: unknown[] } } }
      setCompareSummary({
        facts: comparison.differences?.facts?.length ?? 0,
        states: comparison.differences?.states?.length ?? 0,
        events: (comparison.differences?.events?.leftOnly?.length ?? 0) + (comparison.differences?.events?.rightOnly?.length ?? 0),
      })
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : '时间线对照暂时不可用') })
    return () => { active = false }
  }, [mode, snapshot, worldId])

  const overlay = useMemo(() => snapshot ? buildSceneOverlay(snapshot, snapshot.currentTimelineId) : null, [snapshot])
  const otherOverlay = useMemo(() => otherSnapshot ? buildSceneOverlay(otherSnapshot, otherSnapshot.currentTimelineId) : null, [otherSnapshot])
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

  if (search.get('view') === 'text') return <div className="h-full"><button onClick={() => { search.delete('view'); setSearch(search, { replace: true }) }} className="m-3 rounded-full border bg-white px-4 py-2 text-sm">返回世界画布</button><WorldView worldId={worldId} /></div>
  if (error && !snapshot) return <div className="flex min-h-full items-center bg-[#eef0e7] p-4"><SceneFallbackView message={error} onRetry={() => void read()} onReturn={() => { search.set('view', 'text'); setSearch(search) }} /></div>
  if (!snapshot) return <div className="grid min-h-full place-items-center text-sm text-[#718075]">正在准备这方天地…</div>
  if (!scene && !legacyPreview) return <div className="grid min-h-[calc(100vh-7rem)] bg-[#eef0e7] p-4"><div className="m-auto w-full max-w-xl"><LegacySceneOnboarding busy={busy} error={error} onPreview={requestLegacyPreview} onReturn={() => { search.set('view', 'text'); setSearch(search) }} /></div></div>
  const shown = legacyPreview?.document ?? scene!
  const currentPreview = legacyPreview ? { document: legacyPreview.document, changes: { added: legacyPreview.document.objects.map(o => o.id), moved: [], updated: [], removed: [] } } : preview?.result ?? null
  return <main className="flex min-h-[calc(100vh-7rem)] flex-col gap-3 bg-[#eef0e7] p-3 sm:p-5" data-testid="world-canvas-page">
    {editingNotice && <DesktopEditingNotice onClose={() => setEditingNotice(false)} />}
    {revisionList && <SceneHistoryPanel revisions={revisionList} currentVersion={scene?.version ?? 0} busy={busy} onRestore={version => void restoreVersion(version)} onClose={() => setRevisionList(null)} />}
    <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-[.16em] text-[#849183]">{snapshot.world.name}</p><h1 className="font-story text-xl text-[#2d4435]">{mode === 'possibility' ? '另一种可能' : mode === 'create' ? '调整这方天地' : '这里正在生活'}</h1></div><div className="flex items-center gap-2"><button onClick={() => { search.set('view', 'text'); setSearch(search) }} className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]">世界动态与互动</button><WorldModeSwitcher mode={mode} editable={!!scene} onChange={next => { if (next === 'create' && isSmall) { setEditingNotice(true); return } setMode(next); setPreview(null) }} />{scene && <SceneHistoryControls version={scene.version} canUndo={history.length > 0} canRedo={future.length > 0} onUndo={undo} onRedo={redo} onHistory={() => void loadRevisionList()} />}</div></header>
    {error && <p role="status" className="rounded-xl bg-white px-4 py-2 text-sm text-red-700">{error}</p>}
    {preview && <ScenePreviewBar summary={preview.summary} warnings={preview.warnings} onApply={applyPreview} onCancel={() => setPreview(null)} busy={busy} />}
    {legacyPreview && <ScenePreviewBar summary={legacyPreview.explanation} warnings={legacyPreview.warnings} onApply={confirmLegacy} onCancel={() => setLegacyPreview(null)} busy={busy} />}
    <div className="flex min-h-[500px] flex-1 gap-3"><div className="flex min-w-0 flex-1 flex-col gap-3">
      {mode === 'possibility' ? <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2"><section className="flex min-h-[430px] flex-col gap-2"><p className="text-xs font-medium text-[#687a6b]">原来的发展 · {snapshot.currentTimelineId.slice(0, 8)}</p><WorldCanvasViewport scene={shown} mode="life" overlay={overlay} selectedId={selected} camera={comparisonCamera} onCameraChange={setComparisonCamera} onSelect={setSelected} /></section><section className="flex min-h-[430px] flex-col gap-2"><p className="text-xs font-medium text-[#687a6b]">{otherSnapshot ? `另一种发展 · ${otherSnapshot.currentTimelineId.slice(0, 8)}` : '正在读取另一种发展…'}</p><WorldCanvasViewport scene={shown} mode="life" overlay={otherOverlay} selectedId={selected} camera={comparisonCamera} onCameraChange={setComparisonCamera} onSelect={setSelected} /></section>{compareSummary && <p className="text-xs text-[#687a6b] lg:col-span-2">已有记录：{compareSummary.facts} 项事实差异、{compareSummary.states} 组人物状态差异、{compareSummary.events} 条分支独有事件。场景布局相同；画面只显示各自时间线已记录的生活状态。</p>}</div> : <WorldCanvasViewport scene={shown} mode={mode} overlay={overlay} preview={currentPreview} selectedId={selected} activeAssetId={activeAssetId} onSelect={setSelected} onMove={submitOperation} onCanvasClick={position => activeAssetId && placeAt(activeAssetId, position)} onCanvasStroke={paintCells} />}
      {mode === 'life' && <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-white/85 px-4 py-3 text-sm text-[#526558]"><span>{overlay?.timeOfDay === 'night' ? '夜色渐深，街灯亮起。' : overlay?.weather ? `此刻天气：${overlay.weather}` : '居民正按照自己的处境继续生活。'}</span><span className="text-xs text-[#849184]">{new Date(snapshot.simNow).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', weekday: 'short' })}</span></div>}
      {mode === 'create' && !isSmall && <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]"><div className="space-y-2"><SceneObjectInspector scene={shown} selectedId={selected} catalog={contemporaryTheme} /><SceneAiComposer value={instruction} onChange={setInstruction} onPreview={requestEditPreview} busy={busy} error="" /></div><div className="flex items-center gap-2"><SceneLockControls locked={!!selected && shown.lockedObjectIds.includes(selected)} onToggle={toggleLock} /><button onClick={() => setDrawer(value => !value)} className="rounded-full border border-[#d7ded3] bg-white px-4 py-3 text-sm text-[#42594a]">素材</button>{activeAssetId && <button onClick={() => setActiveAssetId(null)} className="text-xs text-[#617766]">取消放置</button>}</div></div>}
      {mode === 'possibility' && <button onClick={() => { search.set('view', 'text'); setSearch(search) }} className="self-start rounded-full border border-[#d6ddd3] bg-white px-4 py-2 text-sm text-[#47604f]">打开发展对照与分叉条件</button>}
    </div>{drawer && scene && mode === 'create' && <SceneAssetDrawer catalog={contemporaryTheme} onPlace={armAsset} onClose={() => setDrawer(false)} />}</div>
    {legacyPreview && <p className="text-center text-xs text-[#738074]">预览未保存；取消即可回到原来的世界页。</p>}
  </main>
}
