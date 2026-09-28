import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, clearToken, mapApi, worldSceneApi, worldsApi } from '../api/client'
import type { PersonListItem, SceneDraftResponse, WorldSnapshot } from '../api/types'
import type { SceneDocument, SceneMode, SceneOperation, ScenePreviewResult } from '@possibility/scene-contract'
import { applySceneOperations, contemporaryTheme } from '@possibility/scene-contract'
import { WorldCanvasViewport } from '../components/scene/WorldCanvasViewport'
import { SceneCreationPrompt } from '../components/scene/SceneCreationPrompt'
import { SceneAiComposer } from '../components/scene/SceneAiComposer'
import { ScenePreviewBar } from '../components/scene/ScenePreviewBar'
import { SceneAssetDrawer } from '../components/scene/SceneAssetDrawer'
import { SceneObjectInspector } from '../components/scene/SceneObjectInspector'
import { SceneHistoryControls } from '../components/scene/SceneHistoryControls'
import { SceneLockControls } from '../components/scene/SceneLockControls'
import { buildSceneOverlay } from '../scene/life/overlay'

const blankScene: SceneDocument = { schemaVersion: 1, themeId: contemporaryTheme.id, size: { columns: 24, rows: 18 }, version: 0, terrain: [], paths: [], objects: [], lockedObjectIds: [], lockedAreas: [] }

/**
 * 壳层内创建（AC2/E3）：描述 → 真实 AI 预览 → 确认创建 → 原地开始生活。
 * 整个流程留在同一地图壳层，创建成功后 canvas 节点不被替换。
 */
export default function WorldCreate() {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState(''); const [persons, setPersons] = useState<PersonListItem[]>([]); const [selected, setSelected] = useState<string[]>([])
  const [draft, setDraft] = useState<SceneDraftResponse | null>(null); const [document, setDocument] = useState<SceneDocument>(blankScene)
  const [mode] = useState<SceneMode>('create'); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const [instruction, setInstruction] = useState(''); const [preview, setPreview] = useState<{ result: ScenePreviewResult; operations: SceneOperation[]; summary: string; warnings: string[] } | null>(null)
  const [selectedObject, setSelectedObject] = useState<string | null>(null); const [drawer, setDrawer] = useState(false); const [history, setHistory] = useState<SceneDocument[]>([]); const [future, setFuture] = useState<SceneDocument[]>([])
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null)
  const [live, setLive] = useState<{ worldId: string; snapshot: WorldSnapshot } | null>(null)
  useEffect(() => { apiFetch<{ persons: PersonListItem[] }>('/api/persons').then(result => setPersons(result.persons)).catch(() => setError('暂时无法读取人物列表。')) }, [])
  const selectedIds = useMemo(() => new Set(selected), [selected])
  const pushDoc = (next: SceneDocument) => { setHistory(previous => [...previous, document]); setFuture([]); setDocument(next) }
  const overlay = useMemo(() => live ? buildSceneOverlay(live.snapshot, live.snapshot.currentTimelineId) : null, [live])

  async function generate() {
    if (!prompt.trim() || !selected.length || busy) { setError(!selected.length ? '请先选择至少一位居民。' : '请描述你想创造的地方。'); return }
    setBusy(true); setError('')
    try { const result = await worldSceneApi.draft(prompt.trim(), selected); setDraft(result); setDocument(result.scene); setPreview(null) }
    catch (e) { setError(e instanceof Error ? e.message : '场景生成失败；描述和人物选择已保留。') }
    finally { setBusy(false) }
  }
  async function requestPreview() {
    if (!draft || !instruction.trim() || busy) return
    setBusy(true); setError('')
    try {
      const response = await worldSceneApi.draftPreview(document, instruction, selected)
      setPreview({ result: { document: response.documentPreview, changes: { added: [], moved: [], updated: [], removed: [] } }, operations: response.preview.operations, summary: response.preview.summary, warnings: response.preview.warnings })
    } catch (e) { setError(e instanceof Error ? e.message : '修改预览失败') }
    finally { setBusy(false) }
  }
  function applyOperation(operation: SceneOperation) {
    try { const result = applySceneOperations(document, [operation], contemporaryTheme); pushDoc(result.document); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : '这个位置无法放置。') }
  }
  function armAsset(assetId: string) { setActiveAssetId(assetId); setError('请在画布上点击落点；道路和水面可以拖动画笔。') }
  function placeAt(assetId: string, position: { x: number; y: number }) {
    const asset = contemporaryTheme.assets.find(item => item.id === assetId); if (!asset) return
    if (asset.category === 'person') {
      const current = document.objects.find(object => object.id === selectedObject && object.binding?.kind === 'person')
      if (current) { applyOperation({ type: 'replace_asset', objectId: current.id, assetId }); return }
      const bound = new Set(document.objects.flatMap(object => object.binding?.kind === 'person' ? [object.binding.personId] : []))
      const residentId = selected.find(id => !bound.has(id))
      if (!residentId) { setError('已选居民都在场景中；先选中一位居民，再为 TA 更换外观。'); return }
      const person = persons.find(item => item.id === residentId)
      applyOperation({ type: 'add_object', object: { id: crypto.randomUUID(), assetId, position, binding: { kind: 'person', personId: residentId }, label: person?.name ?? null, purpose: null } }); return
    }
    if (asset.category === 'terrain') applyOperation({ type: 'paint_cells', category: 'terrain', assetId, cells: [position] })
    else if (asset.category === 'road' || asset.category === 'water') applyOperation({ type: 'paint_cells', category: asset.category, assetId, cells: [position] })
    else applyOperation({ type: 'add_object', object: { id: crypto.randomUUID(), assetId, position, binding: null, label: null, purpose: null } })
  }
  function paintCells(cells: { x: number; y: number }[]) {
    const asset = contemporaryTheme.assets.find(item => item.id === activeAssetId)
    if (!asset || !['terrain', 'road', 'water'].includes(asset.category)) return
    applyOperation({ type: 'paint_cells', category: asset.category as 'terrain' | 'road' | 'water', assetId: asset.id, cells })
  }
  async function startLife() {
    if (!draft || busy || live) return
    setBusy(true); setError('')
    try {
      const result = await worldsApi.create({ name: draft.world.name, description: draft.world.description, locations: draft.world.locations, personIds: selected, scene: document, sceneRequestId: crypto.randomUUID() })
      // 原地进入生活：canvas 保持挂载，仅更新地址与叠加层，刷新后落在新世界地图
      window.history.replaceState(null, '', `/worlds/${encodeURIComponent(result.id)}`)
      const bootstrap = await mapApi.bootstrap(result.id).catch(() => null)
      if (bootstrap) setLive({ worldId: result.id, snapshot: bootstrap.world })
      else {
        const snapshot = await worldsApi.snapshot(result.id).catch(() => null)
        if (snapshot) setLive({ worldId: result.id, snapshot })
        else navigate(`/worlds/${encodeURIComponent(result.id)}`)
      }
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败；场景仍保留在当前页面。') }
    finally { setBusy(false) }
  }
  function undo() { const previous = history.at(-1); if (!previous) return; setFuture(next => [document, ...next]); setHistory(items => items.slice(0, -1)); setDocument(previous) }
  function redo() { const next = future[0]; if (!next) return; setHistory(items => [...items, document]); setFuture(items => items.slice(1)); setDocument(next) }

  const worldName = live?.snapshot.world.name ?? draft?.world.name ?? '新的世界'
  return <main className="relative h-screen overflow-hidden bg-[#e7eee7]" data-testid="scene-create-shell">
    <WorldCanvasViewport scene={document} mode={live ? 'life' : mode} overlay={overlay} preview={!live ? preview?.result ?? null : null} selectedId={selectedObject} activeAssetId={live ? null : activeAssetId} onSelect={setSelectedObject} onMove={live ? undefined : applyOperation} onCanvasClick={position => !live && activeAssetId && placeAt(activeAssetId, position)} onCanvasStroke={live ? undefined : paintCells} edgeToEdge />
    <div className="pointer-events-none absolute inset-0 z-10">
      <header className="pointer-events-auto absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-[#172820]/80 via-[#172820]/30 to-transparent px-5 pb-10 pt-4 text-white sm:px-7">
        <div><p className="font-story text-xl font-semibold sm:text-2xl">Possibility</p><p className="mt-0.5 text-[10px] tracking-[.24em] text-white/75">{worldName} · {live ? '正在生活' : draft ? '这方天地正在成形' : '从一句话开始'}</p></div>
        <div className="flex items-center gap-2">
          {draft && !live && <SceneHistoryControls version={document.version} canUndo={history.length > 0} canRedo={future.length > 0} onUndo={undo} onRedo={redo} onHistory={() => setError('创建完成前的操作可逐步撤销与重做。')} />}
          {live && <button data-testid="enter-world-map" onClick={() => navigate(`/worlds/${encodeURIComponent(live.worldId)}`)} className="rounded-full border border-white/35 bg-[#263a31]/55 px-4 py-2 text-xs backdrop-blur-md sm:text-sm">进入世界地图</button>}
          <button aria-label="退出登录" title="退出登录" onClick={() => { clearToken(); navigate('/login', { replace: true }) }} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs">退出</button>
        </div>
      </header>
      {error && <p role="alert" className="pointer-events-auto absolute left-1/2 top-20 -translate-x-1/2 rounded-xl bg-white px-4 py-2 text-sm text-red-700 shadow-lg">{error}</p>}
      {preview && !live && <div className="pointer-events-auto absolute inset-x-3 top-24 sm:inset-x-5"><ScenePreviewBar summary={preview.summary} warnings={preview.warnings} onCancel={() => setPreview(null)} onApply={() => { pushDoc(preview.result.document); setPreview(null) }} busy={busy} /></div>}
      {!draft && <section className="pointer-events-auto absolute inset-x-3 top-24 mx-auto flex max-w-3xl flex-col gap-4 sm:top-28">
        <div className="rounded-3xl border border-white/80 bg-[#f8faf6]/95 p-5 shadow-xl backdrop-blur-md"><SceneCreationPrompt value={prompt} onChange={setPrompt} onCreate={generate} busy={busy} error="" /></div>
        <div className="rounded-3xl border border-white/80 bg-[#f8faf6]/95 p-5 shadow-xl backdrop-blur-md"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-semibold text-[#354a3e]">谁会在这里生活？</p><p className="mt-1 text-xs text-[#829083]">选择 1–6 位人物，之后仍可调整场景。</p></div><span className="text-xs text-[#839083]">{selected.length}/6</span></div><div className="mt-3 flex flex-wrap gap-2">{persons.map(person => <button key={person.id} disabled={!selectedIds.has(person.id) && selected.length >= 6} onClick={() => setSelected(old => old.includes(person.id) ? old.filter(id => id !== person.id) : [...old, person.id])} aria-pressed={selectedIds.has(person.id)} className={`rounded-full border px-4 py-2 text-sm ${selectedIds.has(person.id) ? 'border-[#597b62] bg-[#e8efe5] text-[#385443]' : 'border-[#e0e4db] bg-white text-[#69766b]'} disabled:opacity-35`}>{person.name}</button>)}{!persons.length && <p className="text-sm text-[#7b867c]">你还没有人物；先到「人物」页创建一位，再回来为 TA 准备生活的地方。</p>}</div></div></section>}
      {draft && !live && <section className="pointer-events-auto absolute right-3 top-24 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-3 sm:right-5" data-testid="scene-create-workspace">
        <div className="rounded-2xl border border-white/80 bg-[#f8faf6]/95 p-4 text-[#405246] shadow-xl backdrop-blur-md">
          <p className="text-[10px] uppercase tracking-[.16em] text-[#7a897d]">{draft.world.name}</p>
          <h1 className="mt-0.5 font-story text-lg">继续调整这方天地</h1>
          <p className="mt-2 text-xs leading-relaxed text-[#68796d]">{draft.explanation}</p>
          {draft.warnings.length > 0 && <p className="mt-2 text-[10px] text-[#8a7a4a]">{draft.warnings.join('；')}</p>}
        </div>
        <div className="rounded-2xl border border-white/80 bg-[#f8faf6]/95 p-3 shadow-xl backdrop-blur-md"><SceneObjectInspector scene={document} selectedId={selectedObject} catalog={contemporaryTheme} /></div>
        <div className="rounded-2xl border border-white/80 bg-[#f8faf6]/95 p-3 shadow-xl backdrop-blur-md"><SceneAiComposer value={instruction} onChange={setInstruction} onPreview={requestPreview} busy={busy} error="" /></div>
        <div className="flex items-center justify-between gap-2 rounded-2xl border border-white/80 bg-[#f8faf6]/95 p-3 shadow-xl backdrop-blur-md">
          <div className="flex items-center gap-2"><SceneLockControls locked={!!selectedObject && document.lockedObjectIds.includes(selectedObject)} onToggle={() => selectedObject && applyOperation({ type: 'lock_object', objectId: selectedObject, locked: !document.lockedObjectIds.includes(selectedObject) })} /><button onClick={() => setDrawer(value => !value)} className="rounded-full border border-[#d7ded3] bg-white px-4 py-2 text-xs text-[#42594a]">素材</button>{activeAssetId && <button onClick={() => setActiveAssetId(null)} className="text-[10px] text-[#617766] underline">取消放置</button>}</div>
          <button data-testid="start-life" onClick={startLife} disabled={busy} className="rounded-full bg-[#274739] px-5 py-2.5 text-xs font-semibold text-white shadow disabled:opacity-45">{busy ? '保存中…' : '让这里开始生活'}</button>
        </div>
        {drawer && <div className="max-h-[40vh] overflow-hidden rounded-2xl shadow-xl"><SceneAssetDrawer catalog={contemporaryTheme} onPlace={armAsset} onClose={() => setDrawer(false)} /></div>}
      </section>}
      {live && <section className="pointer-events-auto absolute bottom-4 left-3 max-w-[min(26rem,calc(100vw-1.5rem))] rounded-2xl border border-white/80 bg-[#f8faf6]/95 p-4 text-[#405246] shadow-xl backdrop-blur-md sm:left-5" data-testid="create-live-banner">
        <p className="text-[10px] uppercase tracking-[.16em] text-[#7a897d]">这里已经开始生活</p>
        <p className="mt-1 text-xs leading-relaxed text-[#68796d]">居民会按照自己的处境继续生活。你可以直接进入世界地图观察、交谈、改变条件或创建平行宇宙。</p>
        <p className="mt-2 text-[10px] text-[#849184]">{new Date(live.snapshot.simNow).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', weekday: 'short' })} · {live.snapshot.locationBoard.reduce((total, row) => total + row.persons.length, 0)} 位居民</p>
      </section>}
    </div>
  </main>
}
