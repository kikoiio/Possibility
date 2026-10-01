import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, clearToken, mapApi, worldSceneApi, worldsApi } from '../api/client'
import type { PersonListItem, VoxelSceneDraftResponse, WorldSnapshot } from '../api/types'
import { deserialize, serialize, type VoxelDocument } from '@possibility/voxel-contract'
import VoxelViewport from '../voxel/VoxelViewport'
import { planEditsViaApi } from '../voxel/plan-edits'
import { SceneCreationPrompt } from '../components/scene/SceneCreationPrompt'
import { buildSceneOverlay } from '../scene/life/overlay'

const GEN_STAGES = ['正在构思世界骨架…', '正在铺设地形…', '正在建造建筑与道路…', '正在校验新世界…']

/**
 * 体素创建(S1):一句话 + 选居民 → AI 体素草稿(单空间信封)→ 视口内拖拽/AI 编辑
 * (编辑由 EditController 防抖自动同步到 latestDoc)→「让这里开始生活」随创建入库。
 * 整个流程留在同一壳层,创建成功后原地进入生活。
 */
export default function WorldCreate() {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState(''); const [persons, setPersons] = useState<PersonListItem[]>([]); const [selected, setSelected] = useState<string[]>([])
  const [draft, setDraft] = useState<VoxelSceneDraftResponse | null>(null)
  const [doc, setDoc] = useState<VoxelDocument | null>(null)
  const latestDoc = useRef<VoxelDocument | null>(null)
  const [edited, setEdited] = useState(false)
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const [stage, setStage] = useState(0)
  const [live, setLive] = useState<{ worldId: string; snapshot: WorldSnapshot } | null>(null)
  useEffect(() => { apiFetch<{ persons: PersonListItem[] }>('/api/persons').then(result => setPersons(result.persons)).catch(() => setError('暂时无法读取人物列表。')) }, [])
  // 生成可能耗时 30-90s(骨架 1 次 + 世界生成最多 3 次尝试):阶段文案让等待可预期
  useEffect(() => {
    if (!busy || draft) { setStage(0); return }
    const timer = setInterval(() => setStage(value => Math.min(value + 1, GEN_STAGES.length - 1)), 6000)
    return () => clearInterval(timer)
  }, [busy, draft])
  const selectedIds = useMemo(() => new Set(selected), [selected])
  const overlay = useMemo(() => live ? buildSceneOverlay(live.snapshot, live.snapshot.currentTimelineId) : null, [live])

  async function generate() {
    if (!prompt.trim() || !selected.length || busy) { setError(!selected.length ? '请先选择至少一位居民。' : '请描述你想创造的地方。'); return }
    setBusy(true); setError('')
    try {
      const result = await worldSceneApi.draftVoxel(prompt.trim(), selected)
      const document = deserialize(JSON.stringify(result.document))
      latestDoc.current = document
      setDraft(result); setDoc(document); setEdited(false)
    } catch (e) { setError(e instanceof Error ? e.message : '世界生成失败;描述和人物选择已保留。') }
    finally { setBusy(false) }
  }
  async function startLife() {
    if (!draft || busy || live) return
    setBusy(true); setError('')
    try {
      const finalDoc = latestDoc.current ?? doc!
      const result = await worldsApi.create({
        name: draft.world.name, description: draft.world.description, locations: draft.world.locations,
        personIds: selected, scene: JSON.parse(serialize(finalDoc)), sceneRequestId: crypto.randomUUID(),
      })
      // 原地进入生活:视口保持挂载,仅更新地址与覆盖层,刷新后落在新世界地图
      window.history.replaceState(null, '', `/worlds/${encodeURIComponent(result.id)}`)
      const bootstrap = await mapApi.bootstrap(result.id).catch(() => null)
      if (bootstrap) setLive({ worldId: result.id, snapshot: bootstrap.world })
      else {
        const snapshot = await worldsApi.snapshot(result.id).catch(() => null)
        if (snapshot) setLive({ worldId: result.id, snapshot })
        else navigate(`/worlds/${encodeURIComponent(result.id)}`)
      }
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败;世界仍保留在当前页面。') }
    finally { setBusy(false) }
  }

  const worldName = live?.snapshot.world.name ?? draft?.world.name ?? '新的世界'
  return <main className="relative h-screen overflow-hidden bg-[#e7eee7]" data-testid="scene-create-shell">
    {doc && <VoxelViewport document={doc} overlay={overlay} events={live ? (live.snapshot.voxelEvents ?? null) : undefined}
      editable={!live} planEdits={planEditsViaApi}
      onSave={(next) => { latestDoc.current = next; setEdited(true) }} />}
    <div className="pointer-events-none absolute inset-0 z-10">
      <header className="pointer-events-auto absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-[#172820]/80 via-[#172820]/30 to-transparent px-5 pb-10 pt-4 text-white sm:px-7">
        <div><p className="font-story text-xl font-semibold sm:text-2xl">Possibility</p><p className="mt-0.5 text-[10px] tracking-[.24em] text-white/75">{worldName} · {live ? '正在生活' : draft ? '这方天地正在成形' : '从一句话开始'}</p></div>
        <div className="flex items-center gap-2">
          {live && <button data-testid="enter-world-map" onClick={() => navigate(`/worlds/${encodeURIComponent(live.worldId)}`)} className="rounded-full border border-white/35 bg-[#263a31]/55 px-4 py-2 text-xs backdrop-blur-md sm:text-sm">进入世界地图</button>}
          <button onClick={() => navigate('/settings')} className="rounded-full border border-white/35 bg-[#263a31]/55 px-4 py-2 text-xs backdrop-blur-md sm:text-sm" data-testid="create-settings">设置</button>
          <button aria-label="退出登录" title="退出登录" onClick={() => { clearToken(); navigate('/login', { replace: true }) }} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs">退出</button>
        </div>
      </header>
      {error && <p role="alert" className="pointer-events-auto absolute left-1/2 top-20 -translate-x-1/2 rounded-xl bg-white px-4 py-2 text-sm text-red-700 shadow-lg">{error}
        {/* S4:Key/预算/额度类错误给设置入口,弱模型生成失败也可换模型再试 */}
        <button onClick={() => navigate('/settings')} className="ml-2 rounded-full border border-red-200 px-2 py-0.5 text-xs text-red-600 underline-offset-2 hover:underline" data-testid="error-goto-settings">前往设置</button>
      </p>}
      {!draft && <section className="pointer-events-auto absolute inset-x-3 top-24 mx-auto flex max-w-3xl flex-col gap-4 sm:top-28">
        <div className="rounded-3xl border border-white/80 bg-[#f8faf6]/95 p-5 shadow-xl backdrop-blur-md"><SceneCreationPrompt value={prompt} onChange={setPrompt} onCreate={generate} busy={busy} error="" /></div>
        {busy && <p className="rounded-2xl border border-white/80 bg-[#f8faf6]/95 px-5 py-3 text-center text-sm text-[#405246] shadow-xl backdrop-blur-md" data-testid="voxel-gen-stage">{GEN_STAGES[stage]}</p>}
        <div className="rounded-3xl border border-white/80 bg-[#f8faf6]/95 p-5 shadow-xl backdrop-blur-md"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-semibold text-[#354a3e]">谁会在这里生活?</p><p className="mt-1 text-xs text-[#829083]">选择 1–6 位人物,之后仍可调整世界。</p></div><span className="text-xs text-[#839083]">{selected.length}/6</span></div><div className="mt-3 flex flex-wrap gap-2">{persons.map(person => <button key={person.id} disabled={!selectedIds.has(person.id) && selected.length >= 6} onClick={() => setSelected(old => old.includes(person.id) ? old.filter(id => id !== person.id) : [...old, person.id])} aria-pressed={selectedIds.has(person.id)} className={`rounded-full border px-4 py-2 text-sm ${selectedIds.has(person.id) ? 'border-[#597b62] bg-[#e8efe5] text-[#385443]' : 'border-[#e0e4db] bg-white text-[#69766b]'} disabled:opacity-35`}>{person.name}</button>)}{!persons.length && <p className="text-sm text-[#7b867c]">你还没有人物;先到「人物」页创建一位,再回来为 TA 准备生活的地方。</p>}</div></div>
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
