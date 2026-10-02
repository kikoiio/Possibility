import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { apiFetch, ApiError, clearToken, mapApi, worldSceneApi, worldsApi } from '../api/client'
import type { PersonListItem, VoxelSceneDraftResponse, WorldSnapshot } from '../api/types'
import { deserialize, serialize, type VoxelDocument } from '@possibility/voxel-contract'
import VoxelViewport from '../voxel/VoxelViewport'
import { planEditsViaApi } from '../voxel/plan-edits'
import { buildSceneOverlay } from '../scene/life/overlay'
import { createCreateDraftStore } from '../scene/create-draft-store'

const GEN_STAGES = ['正在构思世界骨架…', '正在铺设地形…', '正在建造建筑与道路…', '正在校验新世界…']
const createDraftStore = createCreateDraftStore<CreatePageContext, CreatePageSavedDraft>()

interface CreatePageContext {
  prompt: string
  selectedPersonIds: string[]
  error: { message: string; kind?: string; issues?: { code: string; message: string; summary?: string; suggestion?: string }[]; callsUsed?: number } | null
}

interface CreatePageSavedDraft {
  draft: VoxelSceneDraftResponse
  editedDocument: VoxelSceneDraftResponse['document'] | null
}

function requestedPersonIds(searchParams: URLSearchParams): string[] {
  return [...new Set([
    ...searchParams.getAll('person'),
    ...searchParams.getAll('personId'),
    ...searchParams.getAll('personIds').flatMap(value => value.split(',')),
  ].map(id => id.trim()).filter(Boolean))]
}

/**
 * 体素创建(S1):一句话 + 选居民 → AI 体素草稿(单空间信封)→ 视口内拖拽/AI 编辑
 * (编辑由 EditController 防抖自动同步到 latestDoc)→「让这里开始生活」随创建入库。
 * 整个流程留在同一壳层,创建成功后原地进入生活。
 */
export default function WorldCreate() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const urlPersonIds = useMemo(() => requestedPersonIds(searchParams), [searchParams])
  const [prompt, setPrompt] = useState(''); const [persons, setPersons] = useState<PersonListItem[]>([]); const [selected, setSelected] = useState<string[]>([])
  const [draft, setDraft] = useState<VoxelSceneDraftResponse | null>(null)
  const [doc, setDoc] = useState<VoxelDocument | null>(null)
  const latestDoc = useRef<VoxelDocument | null>(null)
  const [edited, setEdited] = useState(false)
  const [editRevision, setEditRevision] = useState(0)
  const [busy, setBusy] = useState(false); const [error, setError] = useState<CreatePageContext['error']>(null)
  const [restored, setRestored] = useState(false)
  const restoreApplied = useRef(false)
  const [stage, setStage] = useState(0)
  const [live, setLive] = useState<{ worldId: string; snapshot: WorldSnapshot } | null>(null)
  const [archiveWarning, setArchiveWarning] = useState('')
  const [archiveWarningWorldId, setArchiveWarningWorldId] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void Promise.all([
      apiFetch<{ persons: PersonListItem[] }>('/api/persons'),
      Promise.resolve(createDraftStore.loadContext()),
      createDraftStore.loadDraft(),
    ]).then(([result, savedContext, savedDraft]) => {
      if (!active) return
      setPersons(result.persons)
      if (!restoreApplied.current) {
        const validIds = new Set(result.persons.map(person => person.id))
        const restoredIds = urlPersonIds.length ? urlPersonIds : savedContext?.selectedPersonIds ?? []
        setSelected([...new Set(restoredIds)].filter(id => validIds.has(id)).slice(0, 6))
        if (savedContext) {
          setPrompt(savedContext.prompt ?? '')
          setError(savedContext.error ?? null)
        }
        if (savedDraft) {
          const document = savedDraft.editedDocument ?? savedDraft.draft.document
          try {
            const parsed = deserialize(JSON.stringify(document))
            latestDoc.current = parsed
            setDraft(savedDraft.draft)
            setDoc(parsed)
            setEdited(!!savedDraft.editedDocument)
          } catch {
            void createDraftStore.clearDraft()
          }
        }
        restoreApplied.current = true
        setRestored(true)
      }
    }).catch(() => {
      if (active) {
        setError({ message: '暂时无法读取人物列表。' })
        setRestored(true)
      }
    })
    return () => { active = false }
  }, [urlPersonIds])
  useEffect(() => {
    if (!restored || live) return
    const timer = window.setTimeout(() => {
      void Promise.all([
        createDraftStore.saveContext({ prompt, selectedPersonIds: selected, error }),
        draft ? createDraftStore.saveDraft({
          draft,
          editedDocument: edited && latestDoc.current ? JSON.parse(serialize(latestDoc.current)) : null,
        }) : createDraftStore.clearDraft(),
      ])
    }, 400)
    return () => window.clearTimeout(timer)
  }, [prompt, selected, error, draft, doc, restored, live, editRevision])
  // 生成可能耗时 30-90s(骨架 1 次 + 世界生成最多 3 次尝试):阶段文案让等待可预期
  useEffect(() => {
    if (!busy || draft) { setStage(0); return }
    const timer = setInterval(() => setStage(value => Math.min(value + 1, GEN_STAGES.length - 1)), 6000)
    return () => clearInterval(timer)
  }, [busy, draft])
  const selectedIds = useMemo(() => new Set(selected), [selected])
  const overlay = useMemo(() => live ? buildSceneOverlay(live.snapshot, live.snapshot.currentTimelineId) : null, [live])

  async function generate() {
    if (!prompt.trim() || !selected.length || busy) { setError({ message: !selected.length ? '请先选择至少一位居民。' : '请描述你想创造的地方。' }); return }
    setBusy(true); setError(null)
    try {
      const result = await worldSceneApi.draftVoxel(prompt.trim(), selected)
      const document = deserialize(JSON.stringify(result.document))
      latestDoc.current = document
      setDraft(result); setDoc(document); setEdited(false)
    } catch (e) {
      setError(e instanceof ApiError
        ? { message: e.message, kind: e.kind, issues: e.issues, callsUsed: e.callsUsed }
        : { message: e instanceof Error ? e.message : '世界生成失败;描述和人物选择已保留。' })
    }
    finally { setBusy(false) }
  }
  async function startLife() {
    if (!draft || busy || live) return
    setBusy(true); setError(null); setArchiveWarning(''); setArchiveWarningWorldId(null)
    try {
      const finalDoc = latestDoc.current ?? doc!
      const result = await worldsApi.create({
        name: draft.world.name, description: draft.world.description, locations: draft.world.locations,
        personIds: selected, scene: JSON.parse(serialize(finalDoc)), sceneRequestId: crypto.randomUUID(),
      })
      const fromWorld = searchParams.get('fromWorld')
      if (fromWorld) {
        try {
          await apiFetch<{ ok: true; status: string }>(`/api/worlds/${encodeURIComponent(fromWorld)}/archive`, {
            method: 'POST',
            body: JSON.stringify({ pauseReason: '已在新世界中安家' }),
          })
        } catch {
          setArchiveWarning('新世界已创建，但原世界未能归档。你仍可进入新世界，稍后可在世界列表中处理原世界。')
          setArchiveWarningWorldId(result.id)
        }
      }
      await Promise.all([createDraftStore.clearContext(), createDraftStore.clearDraft()])
      // 原地进入生活:视口保持挂载,仅更新地址与覆盖层,刷新后落在新世界地图
      window.history.replaceState(null, '', `/worlds/${encodeURIComponent(result.id)}`)
      const bootstrap = await mapApi.bootstrap(result.id).catch(() => null)
      if (bootstrap) setLive({ worldId: result.id, snapshot: bootstrap.world })
      else {
        const snapshot = await worldsApi.snapshot(result.id).catch(() => null)
        if (snapshot) setLive({ worldId: result.id, snapshot })
        else {
          if (fromWorld) {
            setArchiveWarning('新世界已创建，但原世界未能归档。你仍可进入新世界，稍后可在世界列表中处理原世界。')
            setArchiveWarningWorldId(result.id)
          }
          navigate(`/worlds/${encodeURIComponent(result.id)}`)
        }
      }
    } catch (e) { setError({ message: e instanceof Error ? e.message : '保存失败;世界仍保留在当前页面。' }) }
    finally { setBusy(false) }
  }

  const worldName = live?.snapshot.world.name ?? draft?.world.name ?? '新的世界'
  return <main className="relative h-screen overflow-hidden bg-[#e7eee7]" data-testid="scene-create-shell">
    {doc && <VoxelViewport document={doc} overlay={overlay} events={live ? (live.snapshot.voxelEvents ?? null) : undefined}
      editable={!live} planEdits={planEditsViaApi}
      onSave={(next) => { latestDoc.current = next; setEdited(true); setEditRevision(value => value + 1) }} />}
    <div className="pointer-events-none absolute inset-0 z-10">
      <header className="pointer-events-auto absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-[#172820]/80 via-[#172820]/30 to-transparent px-5 pb-10 pt-4 text-white sm:px-7">
        <div><p className="font-story text-xl font-semibold sm:text-2xl">Possibility</p><p className="mt-0.5 text-[10px] tracking-[.24em] text-white/75">{worldName} · {live ? '正在生活' : draft ? '这方天地正在成形' : '从一句话开始'}</p></div>
        <div className="flex items-center gap-2">
          {live && <button data-testid="enter-world-map" onClick={() => navigate(`/worlds/${encodeURIComponent(live.worldId)}`)} className="rounded-full border border-white/35 bg-[#263a31]/55 px-4 py-2 text-xs backdrop-blur-md sm:text-sm">进入世界地图</button>}
          <button onClick={() => navigate('/settings')} className="rounded-full border border-white/35 bg-[#263a31]/55 px-4 py-2 text-xs backdrop-blur-md sm:text-sm" data-testid="create-settings">设置</button>
          <button aria-label="退出登录" title="退出登录" onClick={() => { clearToken(); navigate('/login', { replace: true }) }} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs">退出</button>
        </div>
      </header>
      {error && <div role="alert" className="pointer-events-auto absolute left-1/2 top-20 w-[min(36rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-xl bg-white px-4 py-3 text-sm text-red-700 shadow-lg" data-testid="create-error">
        <p>{error.message}</p>
        {error.kind === 'content' && <>
          {error.issues?.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">{error.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.summary ?? issue.message}{issue.suggestion ? ` ${issue.suggestion}` : ''}</li>)}</ul> : <p className="mt-2 text-xs">可以简化描述，减少复杂结构，并重新生成。</p>}
          {error.callsUsed !== undefined && <p className="mt-2 text-xs text-[#68796d]">本次已使用 {error.callsUsed} 次模型调用。</p>}
        </>}
        {(error.kind === 'config' || error.kind === 'budget') && <button onClick={() => navigate('/settings')} className="mt-2 rounded-full border border-red-200 px-2 py-0.5 text-xs text-red-600 underline-offset-2 hover:underline" data-testid="error-goto-settings">前往设置</button>}
      </div>}
      {archiveWarning && <div role="status" className="pointer-events-auto absolute left-1/2 top-20 w-[min(36rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-xl bg-white px-4 py-3 text-sm text-amber-800 shadow-lg" data-testid="archive-warning">
        <p>{archiveWarning}</p>
        {archiveWarningWorldId && <button type="button" onClick={() => navigate(`/worlds/${encodeURIComponent(archiveWarningWorldId)}`)} className="mt-2 font-medium underline underline-offset-2">进入新世界</button>}
      </div>}
      {!draft && <section className="pointer-events-auto absolute inset-x-3 top-24 mx-auto flex max-w-3xl flex-col gap-4 sm:top-28">
        <div className="rounded-3xl border border-white/80 bg-[#f8faf6]/95 p-5 shadow-xl backdrop-blur-md">
          <p className="text-xs font-semibold uppercase tracking-[.18em] text-[#799181]">先从一个地方开始</p>
          <h1 className="mt-2 font-story text-3xl text-[#283f35]">你想让这里是什么样？</h1>
          <p className="mt-3 text-sm leading-6 text-[#68776c]">描述地点、建筑、自然环境和彼此的距离。AI 会从固定素材中搭出可以继续编辑的场景。</p>
          <textarea data-testid="scene-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} rows={4} maxLength={1200} placeholder="一条沿着小河延伸的街道，街角有家咖啡馆，附近有几间住宅和一片可以散步的小公园……" className="mt-5 w-full resize-y rounded-2xl border border-[#d9dfd4] bg-white px-4 py-3 text-sm leading-6 text-[#33483d] outline-none transition focus:border-[#6d8f79] focus:ring-2 focus:ring-[#6d8f79]/20" />
          <p className="mt-2 text-xs text-[#89938a]">示例：海边旧车站旁的小街，路边有咖啡馆、花园和安静的住宅。</p>
        </div>
        {busy && <p className="rounded-2xl border border-white/80 bg-[#f8faf6]/95 px-5 py-3 text-center text-sm text-[#405246] shadow-xl backdrop-blur-md" data-testid="voxel-gen-stage">{GEN_STAGES[stage]}</p>}
        <div className="rounded-3xl border border-white/80 bg-[#f8faf6]/95 p-5 shadow-xl backdrop-blur-md"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-semibold text-[#354a3e]">谁会在这里生活?</p><p className="mt-1 text-xs text-[#829083]">选择 1–6 位人物,之后仍可调整世界。</p></div><span className="text-xs text-[#839083]">{selected.length}/6</span></div><div className="mt-3 flex flex-wrap gap-2">{persons.map(person => <button key={person.id} disabled={!selectedIds.has(person.id) && selected.length >= 6} onClick={() => { setSelected(old => old.includes(person.id) ? old.filter(id => id !== person.id) : [...old, person.id]); setError(null) }} aria-pressed={selectedIds.has(person.id)} className={`rounded-full border px-4 py-2 text-sm ${selectedIds.has(person.id) ? 'border-[#597b62] bg-[#e8efe5] text-[#385443]' : 'border-[#e0e4db] bg-white text-[#69766b]'} disabled:opacity-35`}>{person.name}</button>)}</div>
          {!persons.length && <div className="mt-3 text-sm text-[#7b867c]"><p>还没有可选择的人物。</p><Link to={`/people/new?returnTo=/worlds/new${searchParams.get('fromWorld') ? `&fromWorld=${encodeURIComponent(searchParams.get('fromWorld')!)}` : ''}`} onClick={() => createDraftStore.saveContext({ prompt, selectedPersonIds: selected, error })} className="mt-1 inline-block font-medium text-[#385443] underline underline-offset-2">创建一位人物</Link></div>}
          <button data-testid="generate-scene" onClick={generate} disabled={busy || !prompt.trim() || !selected.length} className="mt-4 rounded-full bg-[#274739] px-5 py-2.5 text-sm font-semibold text-white shadow disabled:cursor-not-allowed disabled:opacity-45">{busy ? '正在搭建场景…' : '开始创造'}</button>
        </div>
      </section>}
      {draft && !live && <section className="pointer-events-auto absolute right-3 top-24 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-3 sm:right-5" data-testid="voxel-create-workspace">
        <div className="rounded-2xl border border-white/80 bg-[#f8faf6]/95 p-4 text-[#405246] shadow-xl backdrop-blur-md">
          <p className="text-[10px] uppercase tracking-[.16em] text-[#7a897d]">{draft.world.name}</p>
          <h1 className="mt-0.5 font-story text-lg">继续调整这方天地</h1>
          <p className="mt-2 text-xs leading-relaxed text-[#68796d]">{draft.explanation}</p>
          <p className="mt-2 text-[10px] leading-relaxed text-[#849184]">右下角可以挖方块、摆建筑、让 AI 按你的想法改造;修改会自动记下。{edited ? '已记下你的调整。' : ''}</p>
          {draft.warnings.length > 0 && <p className="mt-2 text-[10px] text-[#8a7a4a]">{draft.warnings.join(';')}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 rounded-2xl border border-white/80 bg-[#f8faf6]/95 p-3 shadow-xl backdrop-blur-md">
          <button data-testid="start-life" onClick={startLife} disabled={busy} className="rounded-full bg-[#274739] px-5 py-2.5 text-xs font-semibold text-white shadow disabled:opacity-45">{busy ? '保存中…' : '让这里开始生活'}</button>
        </div>
      </section>}
      {live && <section className="pointer-events-auto absolute bottom-4 left-3 max-w-[min(26rem,calc(100vw-1.5rem))] rounded-2xl border border-white/80 bg-[#f8faf6]/95 p-4 text-[#405246] shadow-xl backdrop-blur-md sm:left-5" data-testid="create-live-banner">
        <p className="text-[10px] uppercase tracking-[.16em] text-[#7a897d]">这里已经开始生活</p>
        <p className="mt-1 text-xs leading-relaxed text-[#68796d]">居民会按照自己的处境继续生活。你可以直接进入世界地图观察、交谈、改变条件或创建平行宇宙。</p>
        <p className="mt-2 text-[10px] text-[#849184]">{new Date(live.snapshot.simNow).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', weekday: 'short' })} · {live.snapshot.locationBoard.reduce((total, row) => total + row.persons.length, 0)} 位居民</p>
      </section>}
    </div>
  </main>
}
