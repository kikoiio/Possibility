import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError, worldSceneApi } from '../api/client'
import type { SceneRepairContext, SceneRepairDraftResponse } from '../api/types'
import { deserialize, serialize, type SerializedVoxelDocument, type VoxelDocument } from '@possibility/voxel-contract'
import VoxelViewport from '../voxel/VoxelViewport'
import { planEditsViaApi } from '../voxel/plan-edits'

export default function WorldSceneRepair() {
  const { worldId = '' } = useParams()
  const navigate = useNavigate()
  const [context, setContext] = useState<SceneRepairContext | null>(null)
  const [prompt, setPrompt] = useState('')
  const [draft, setDraft] = useState<SceneRepairDraftResponse | null>(null)
  const [doc, setDoc] = useState<VoxelDocument | null>(null)
  const latestDoc = useRef<VoxelDocument | null>(null)
  const saveRequestId = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [saveBlocked, setSaveBlocked] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setContext(null)
    setDraft(null)
    setDoc(null)
    latestDoc.current = null
    saveRequestId.current = null
    setError('')
    setSaveBlocked(false)
    void worldSceneApi.repairContext(worldId).then(value => {
      if (!active) return
      setContext(value)
      setLoading(false)
    }).catch(async (cause) => {
      if (!active) return
      if (cause instanceof ApiError && cause.status === 409) {
        const scene = await worldSceneApi.get(worldId).catch(() => null)
        if (active && scene?.status === 'ready') {
          navigate(`/worlds/${encodeURIComponent(worldId)}`, { replace: true })
          return
        }
      }
      if (active) {
        setError(cause instanceof Error ? cause.message : '暂时无法读取原世界。')
        setLoading(false)
      }
    })
    return () => { active = false }
  }, [worldId, navigate])

  async function generate() {
    if (!prompt.trim() || busy) return
    setBusy(true); setError('')
    try {
      const result = await worldSceneApi.repairDraft(worldId, prompt.trim())
      if (result.worldId !== worldId) throw new Error('生成结果与当前原世界不匹配。')
      const parsed = deserialize(JSON.stringify(result.document))
      latestDoc.current = parsed
      saveRequestId.current = null
      setDraft(result)
      setDoc(parsed)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '场景生成失败；原世界没有变化，可以调整描述后重试。')
    } finally { setBusy(false) }
  }

  async function save() {
    if (!draft || !latestDoc.current || busy) return
    setBusy(true); setError('')
    const requestId = saveRequestId.current ?? crypto.randomUUID()
    saveRequestId.current = requestId
    try {
      const document = JSON.parse(serialize(latestDoc.current)) as SerializedVoxelDocument
      await worldSceneApi.commitRepairVoxel(worldId, requestId, document)
      navigate(`/worlds/${encodeURIComponent(worldId)}`, { replace: true })
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        const scene = await worldSceneApi.get(worldId).catch(() => null)
      if (scene?.status === 'ready') {
          setSaveBlocked(true)
          setError('原世界已由另一份保存补好。当前草稿仍保留在本页；可从右上角进入已保存的原世界。')
        } else {
          setError(cause instanceof Error ? cause.message : '保存冲突；当前草稿仍在本页。')
        }
      } else setError(cause instanceof Error ? cause.message : '保存失败；当前草稿仍在本页，可以重试保存或返回原世界。')
    } finally { setBusy(false) }
  }

  const worldName = context?.world.name ?? '原世界'
  return <main className="relative h-screen overflow-hidden bg-[#e7eee7]" data-testid="scene-repair-shell">
    {doc && <VoxelViewport document={doc} editable={!busy} planEdits={planEditsViaApi}
      onSave={next => { latestDoc.current = next; saveRequestId.current = null; setDoc(next) }} />}
    <div className="pointer-events-none absolute inset-0 z-10">
      <header className="pointer-events-auto absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-[#172820]/80 via-[#172820]/30 to-transparent px-5 pb-10 pt-4 text-white sm:px-7">
        <div>
          <p className="font-story text-xl font-semibold sm:text-2xl">Possibility</p>
          <p className="mt-0.5 text-[10px] tracking-[.18em] text-white/75">{worldName} · 补建原世界场景</p>
        </div>
        <Link to={`/worlds/${encodeURIComponent(worldId)}`} className="rounded-full border border-white/35 bg-[#263a31]/55 px-4 py-2 text-xs backdrop-blur-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:text-sm">返回原世界</Link>
      </header>

      {loading && <p role="status" aria-live="polite" className="pointer-events-auto absolute left-1/2 top-24 -translate-x-1/2 rounded-xl bg-white/95 px-5 py-3 text-sm text-[#405246] shadow-lg">正在读取原世界…</p>}
      {!loading && !context && <section className="pointer-events-auto absolute left-1/2 top-24 w-[min(34rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-2xl bg-white/95 p-5 text-sm text-[#526558] shadow-lg">
        <p role="alert">{error || '暂时无法读取原世界。'}</p>
        <Link to={`/worlds/${encodeURIComponent(worldId)}`} className="mt-3 inline-block underline underline-offset-2">返回原世界</Link>
      </section>}

      {context && <>
        {error && <p role="alert" className="pointer-events-auto absolute left-1/2 top-20 w-[min(36rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-xl bg-white px-4 py-3 text-sm text-red-700 shadow-lg">{error}</p>}
        {!draft && <section className="pointer-events-auto absolute inset-x-3 top-24 mx-auto flex max-h-[calc(100vh-7.5rem)] max-w-3xl flex-col gap-4 overflow-y-auto pb-3 sm:top-28 sm:max-h-[calc(100vh-8rem)]">
          <div className="rounded-3xl border border-white/80 bg-[#f8faf6]/95 p-5 shadow-xl backdrop-blur-md">
            <p className="text-xs font-semibold uppercase tracking-[.18em] text-[#799181]">为原世界补建场景</p>
            <h1 className="mt-2 font-story text-3xl text-[#283f35]">让「{context.world.name}」回到可进入的状态</h1>
            <p className="mt-3 text-sm leading-6 text-[#68776c]">描述想为这个世界补上的场景。保存后仍回到原世界，地点和居民关系保持不变。</p>
            <label htmlFor="repair-scene-prompt" className="mt-4 block text-xs font-medium text-[#536558]">场景描述</label>
            <textarea id="repair-scene-prompt" data-testid="repair-scene-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} rows={4} maxLength={1200}
              placeholder="描述现有地点之间的样子、建筑与道路……" className="mt-2 w-full resize-y rounded-2xl border border-[#d9dfd4] bg-white px-4 py-3 text-sm leading-6 text-[#33483d] outline-none focus:border-[#6d8f79] focus:ring-2 focus:ring-[#6d8f79]/20" />
          </div>
          <div className="rounded-3xl border border-white/80 bg-[#f8faf6]/95 p-5 shadow-xl backdrop-blur-md">
            <p className="text-sm font-semibold text-[#354a3e]">原世界内容会保留</p>
            <p className="mt-1 text-xs text-[#829083]">地点和居民来自原世界，不能在补建时替换。</p>
            <div className="mt-3 flex flex-wrap gap-2">{context.residents.map(resident => <span key={resident.id} className="rounded-full border border-[#d9dfd4] bg-white px-3 py-1.5 text-xs text-[#536558]">{resident.name}</span>)}</div>
            <ul className="mt-3 grid gap-1 text-xs text-[#68776c] sm:grid-cols-2">
              {context.world.locations.map(location => <li key={location.name}>· {location.name}：{location.description}</li>)}
            </ul>
            <button data-testid="generate-repair-scene" type="button" onClick={() => void generate()} disabled={busy || !prompt.trim()}
              className="mt-4 rounded-full bg-[#274739] px-5 py-2.5 text-sm font-semibold text-white shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#274739] disabled:cursor-not-allowed disabled:opacity-45">
              {busy ? '正在补建场景…' : '生成场景草稿'}
            </button>
          </div>
        </section>}
        {draft && <section className="pointer-events-auto absolute right-3 top-24 flex max-h-[calc(100vh-7.5rem)] w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-3 overflow-y-auto pb-3 sm:right-5">
          <div className="rounded-2xl border border-white/80 bg-[#f8faf6]/95 p-4 text-[#405246] shadow-xl backdrop-blur-md">
            <p className="text-[10px] uppercase tracking-[.16em] text-[#7a897d]">{context.world.name}</p>
            <h1 className="mt-0.5 font-story text-lg">场景草稿已生成</h1>
            <p className="mt-2 text-xs leading-relaxed text-[#68796d]">{draft.explanation}</p>
            {draft.warnings.length > 0 && <p className="mt-2 text-[10px] text-[#8a7a4a]">{draft.warnings.join('；')}</p>}
            <p className="mt-2 text-[10px] text-[#849184]">视口中的调整会保留在本页。确认后保存到这个原世界。</p>
          </div>
          <div className="flex items-center justify-end gap-2 rounded-2xl border border-white/80 bg-[#f8faf6]/95 p-3 shadow-xl">
            <button data-testid="save-repair-scene" type="button" onClick={() => void save()} disabled={busy || saveBlocked}
              className="rounded-full bg-[#274739] px-5 py-2.5 text-xs font-semibold text-white shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#274739] disabled:opacity-45">
              {busy ? '保存中…' : saveBlocked ? '原世界已有场景' : error ? '重试保存' : '保存并进入原世界'}
            </button>
          </div>
        </section>}
      </>}
    </div>
  </main>
}
