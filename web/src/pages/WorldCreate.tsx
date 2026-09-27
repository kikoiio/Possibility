import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, worldSceneApi, worldsApi } from '../api/client'
import type { PersonListItem, SceneDraftResponse } from '../api/types'
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
import { WorldModeSwitcher } from '../components/scene/WorldModeSwitcher'

const blankScene: SceneDocument = { schemaVersion: 1, themeId: contemporaryTheme.id, size: { columns: 24, rows: 18 }, version: 0, terrain: [], paths: [], objects: [], lockedObjectIds: [], lockedAreas: [] }

export default function WorldCreate() {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState(''); const [persons, setPersons] = useState<PersonListItem[]>([]); const [selected, setSelected] = useState<string[]>([])
  const [draft, setDraft] = useState<SceneDraftResponse | null>(null); const [document, setDocument] = useState<SceneDocument>(blankScene)
  const [mode, setMode] = useState<SceneMode>('create'); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const [instruction, setInstruction] = useState(''); const [preview, setPreview] = useState<{ result: ScenePreviewResult; operations: SceneOperation[]; summary: string; warnings: string[] } | null>(null)
  const [selectedObject, setSelectedObject] = useState<string | null>(null); const [drawer, setDrawer] = useState(false); const [history, setHistory] = useState<SceneDocument[]>([]); const [future, setFuture] = useState<SceneDocument[]>([])
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null)
  useEffect(() => { apiFetch<{ persons: PersonListItem[] }>('/api/persons').then(result => setPersons(result.persons)).catch(() => setError('暂时无法读取人物列表。')) }, [])
  const selectedIds = useMemo(() => new Set(selected), [selected])
  const pushDoc = (next: SceneDocument) => { setHistory(previous => [...previous, document]); setFuture([]); setDocument(next) }

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
    if (!draft || busy) return
    setBusy(true); setError('')
    try {
      const result = await worldsApi.create({ name: draft.world.name, description: draft.world.description, locations: draft.world.locations, personIds: selected, scene: document, sceneRequestId: crypto.randomUUID() })
      navigate(`/worlds/${result.id}`)
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败；场景仍保留在当前页面。') }
    finally { setBusy(false) }
  }
  function undo() { const previous = history.at(-1); if (!previous) return; setFuture(next => [document, ...next]); setHistory(items => items.slice(0, -1)); setDocument(previous) }
  function redo() { const next = future[0]; if (!next) return; setHistory(items => [...items, document]); setFuture(items => items.slice(1)); setDocument(next) }

  if (!draft) return <main className="min-h-full bg-[#eef0e7] px-4 py-8 sm:px-8"><div className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-6xl flex-col justify-center gap-6">
    <SceneCreationPrompt value={prompt} onChange={setPrompt} onCreate={generate} busy={busy} error={error} />
    <section className="mx-auto w-full max-w-3xl rounded-3xl border border-[#e2e5dc] bg-white/85 p-5 shadow-sm"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-semibold text-[#354a3e]">谁会在这里生活？</p><p className="mt-1 text-xs text-[#829083]">选择 1–6 位人物，之后仍可调整场景。</p></div><span className="text-xs text-[#839083]">{selected.length}/6</span></div><div className="mt-3 flex flex-wrap gap-2">{persons.map(person => <button key={person.id} disabled={!selectedIds.has(person.id) && selected.length >= 6} onClick={() => setSelected(old => old.includes(person.id) ? old.filter(id => id !== person.id) : [...old, person.id])} aria-pressed={selectedIds.has(person.id)} className={`rounded-full border px-4 py-2 text-sm ${selectedIds.has(person.id) ? 'border-[#597b62] bg-[#e8efe5] text-[#385443]' : 'border-[#e0e4db] bg-white text-[#69766b]'} disabled:opacity-35`}>{person.name}</button>)}{!persons.length && <p className="text-sm text-[#7b867c]">你还没有人物；先创建一位人物，再回来为 TA 准备生活的地方。</p>}</div></section>
  </div></main>

  return <main className="flex min-h-[calc(100vh-7rem)] flex-col gap-3 bg-[#eef0e7] p-3 sm:p-5" data-testid="scene-create-workspace">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-[.16em] text-[#859184]">{draft.world.name}</p><h1 className="font-story text-xl text-[#2c4435]">继续调整这方天地</h1></div><div className="flex items-center gap-2"><SceneHistoryControls version={document.version} canUndo={history.length > 0} canRedo={future.length > 0} onUndo={undo} onRedo={redo} onHistory={() => setError('创建完成前的操作可逐步撤销与重做。')} /><WorldModeSwitcher mode={mode} onChange={setMode} /></div></header>
    {error && <p role="alert" className="rounded-xl bg-white px-4 py-2 text-sm text-red-700">{error}</p>}
    {preview && <ScenePreviewBar summary={preview.summary} warnings={preview.warnings} onCancel={() => setPreview(null)} onApply={() => { pushDoc(preview.result.document); setPreview(null) }} busy={busy} />}
    <div className="flex min-h-[480px] flex-1 gap-3"><div className="flex min-w-0 flex-1 flex-col gap-3"><WorldCanvasViewport scene={document} mode={mode} preview={preview?.result ?? null} selectedId={selectedObject} activeAssetId={activeAssetId} onSelect={setSelectedObject} onMove={applyOperation} onCanvasClick={position => activeAssetId && placeAt(activeAssetId, position)} onCanvasStroke={paintCells} /><div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]"><div className="space-y-2"><SceneObjectInspector scene={document} selectedId={selectedObject} catalog={contemporaryTheme} /><SceneAiComposer value={instruction} onChange={setInstruction} onPreview={requestPreview} busy={busy} error="" /></div><div className="flex flex-col items-end justify-between gap-3"><SceneLockControls locked={!!selectedObject && document.lockedObjectIds.includes(selectedObject)} onToggle={() => selectedObject && applyOperation({ type: 'lock_object', objectId: selectedObject, locked: !document.lockedObjectIds.includes(selectedObject) })} /><div className="flex gap-2"><button onClick={() => setDrawer(value => !value)} className="rounded-full border border-[#d7ded3] bg-white px-4 py-3 text-sm text-[#42594a]">素材</button><button data-testid="start-life" onClick={startLife} disabled={busy} className="rounded-full bg-[#274739] px-5 py-3 text-sm font-semibold text-white shadow disabled:opacity-45">{busy ? '保存中…' : '让这里开始生活'}</button></div>{activeAssetId && <p className="text-xs text-[#5e7464]">已选素材：{contemporaryTheme.assets.find(asset => asset.id === activeAssetId)?.name} · 点击画布放置<button className="ml-2 underline" onClick={() => setActiveAssetId(null)}>取消</button></p>}</div></div></div>{drawer && <SceneAssetDrawer catalog={contemporaryTheme} onPlace={armAsset} onClose={() => setDrawer(false)} />}</div>
  </main>
}
