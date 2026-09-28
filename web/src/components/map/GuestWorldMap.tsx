import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { mistManorTheme, type SceneDocumentV2, type SceneLifeOverlay } from '@possibility/scene-contract'
import type { WorldSnapshot } from '../../api/types'
import { clearToken, demoApi, lifeApi, mapApi, worldsApi } from '../../api/client'
import { WorldCanvasViewport } from '../scene/WorldCanvasViewport'
import { projectSpace, projectTheme } from '../../world/sceneProjection'
import ScenePanel from '../world/ScenePanel'
import { buildSceneOverlay } from '../../scene/life/overlay'

const projectedTheme = projectTheme(mistManorTheme)
const tourSteps = [
  ['discover-event', '发现事件：选择正在发生变化的地点。'],
  ['inspect-person', '认识居民：选择一位人物查看其活动。'],
  ['enter-location', '进入地点：到达地点后继续。'],
  ['interact', '真实交谈：完成一次已提交的交谈。'],
  ['change-condition', '改变条件：传递一条消息或确认一项行动。'],
  ['fork', '创建分支：从当前发展建立平行宇宙。'],
  ['compare', '查看对照：读取两条时间线的记录差异。'],
  ['return', '返回地图：结束导览，继续探索。'],
] as const
type TourStep = typeof tourSteps[number][0]
const tourOrder = tourSteps.map(([id]) => id) as TourStep[]
function tourStorageKey(worldId: string) { return `possibility:s03-tour:v1:${worldId}` }
function loadTourProgress(worldId: string): TourStep[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(tourStorageKey(worldId)) ?? '[]')
    return Array.isArray(value) ? value.filter((step): step is TourStep => tourOrder.includes(step)) : []
  } catch { return [] }
}

export function GuestWorldMap({ scene, snapshot, overlay, initialSpaceId, initialMode = 'life', guest = true }: { scene: SceneDocumentV2; snapshot: WorldSnapshot; overlay: SceneLifeOverlay | null; initialSpaceId?: string; initialMode?: 'create' | 'life' | 'possibility'; guest?: boolean }) {
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  const [liveSnapshot, setLiveSnapshot] = useState(snapshot)
  const [worldChoices, setWorldChoices] = useState<{ id: string; name: string }[]>([])
  const [sceneLocation, setSceneLocation] = useState<string | null>(null)
  useEffect(() => setLiveSnapshot(snapshot), [snapshot])
  const [spaceId, setSpaceIdState] = useState(scene.spaces.some(space => space.id === initialSpaceId) ? initialSpaceId! : scene.defaultSpaceId)
  const [selected, setSelected] = useState<string | null>(null)
  const [tourDone, setTourDone] = useState<TourStep[]>(() => loadTourProgress(snapshot.world.id))
  const [tourOpen, setTourOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'observe' | 'life' | 'possibility'>(initialMode === 'create' ? 'life' : initialMode)
  const [forkId, setForkId] = useState<string | null>(liveSnapshot.timelines.find(item => item.parentTimelineId)?.id ?? null)
  const [compare, setCompare] = useState<{ facts: number; states: number; events: number } | null>(null)
  const [actionError, setActionError] = useState('')
  const [timelineBusy, setTimelineBusy] = useState(false)
  async function switchTimeline(nextId: string) {
    if (nextId === liveSnapshot.currentTimelineId || timelineBusy) return
    setTimelineBusy(true); setActionError('')
    try {
      const data = await mapApi.bootstrap(liveSnapshot.world.id, nextId)
      setLiveSnapshot(data.world)
      setForkId(data.world.timelines.find(item => item.parentTimelineId)?.id ?? null)
      setCompare(null)
      void mapApi.saveResume(liveSnapshot.world.id, { timelineId: nextId, spaceId, mode: mode === 'observe' ? 'life' : mode })
    } catch { setActionError('时间线切换失败；当前宇宙仍可继续浏览。') }
    finally { setTimelineBusy(false) }
  }
  function openTextView() { search.set('view', 'text'); setSearch(search) }
  useEffect(() => {
    if (guest) return
    let active = true
    void worldsApi.list().then(result => {
      if (active) setWorldChoices(result.worlds.map(world => ({ id: world.id, name: world.name })))
    }).catch(() => {})
    return () => { active = false }
  }, [guest])
  const projected = useMemo(() => projectSpace(scene, spaceId), [scene, spaceId])
  const selectedObject = selected ? projected.objects.find(object => object.id === selected) : null
  const locationName = selectedObject?.binding?.kind === 'location' ? selectedObject.binding.locationName : null
  const personId = selectedObject?.binding?.kind === 'person' ? selectedObject.binding.personId : null
  const person = personId ? liveSnapshot.locationBoard.flatMap(row => row.persons.map(item => ({ ...item, location: row.location }))).find(item => item.id === personId) : null
  const location = locationName ? liveSnapshot.world.locations.find(item => item.name === locationName) : null
  const people = locationName ? liveSnapshot.locationBoard.find(row => row.location === locationName)?.persons ?? [] : []
  const currentOverlay = useMemo(() => buildSceneOverlay(liveSnapshot, liveSnapshot.currentTimelineId) ?? overlay, [liveSnapshot, overlay])
  const inside = spaceId === 'main-house-interior'
  const nextTourStep = tourOrder.find(step => !tourDone.includes(step))
  const tourIndex = nextTourStep ? tourOrder.indexOf(nextTourStep) : tourOrder.length
  function markTour(milestone: TourStep) {
    setTourDone(previous => {
      const next = tourOrder.filter(step => previous.includes(step) || step === milestone)
      try { localStorage.setItem(tourStorageKey(liveSnapshot.world.id), JSON.stringify(next)) } catch { /* Tour progress is optional. */ }
      return next
    })
  }
  function selectObject(objectId: string | null) {
    setSelected(objectId)
    const object = projected.objects.find(item => item.id === objectId)
    if (object?.binding?.kind === 'person') markTour('inspect-person')
    if (object?.binding?.kind === 'location') {
      const locationName = object.binding.locationName
      const hasEvent = liveSnapshot.events.some(event => event.location === locationName)
      if (hasEvent) markTour('discover-event')
    }
  }
  const handleSceneMilestone = useCallback((milestone: 'enter-location' | 'interact' | 'change-condition') => {
    markTour(milestone)
  }, [liveSnapshot.world.id])
  function setSpaceId(next: string) {
    setSpaceIdState(next)
    void mapApi.saveResume(liveSnapshot.world.id, { timelineId: liveSnapshot.currentTimelineId, spaceId: next, mode: mode === 'observe' ? 'life' : mode })
  }
  function setMapMode(next: 'observe' | 'life' | 'possibility') {
    setMode(next)
    void mapApi.saveResume(liveSnapshot.world.id, { timelineId: liveSnapshot.currentTimelineId, spaceId, mode: next === 'observe' ? 'life' : next })
  }
  async function reset() {
    if (!guest) return
    setBusy(true)
    try { await demoApi.reset(); try { localStorage.removeItem(tourStorageKey(liveSnapshot.world.id)) } catch { /* Ignore unavailable storage. */ }; window.location.reload() } finally { setBusy(false) }
  }
  async function createPossibility() {
    setBusy(true); setActionError('')
    try {
      const input = { whatIf: '三田村千鹤今天提前发现那封匿名信', changedVariable: '匿名信被发现的时间' }
      const fork = guest
        ? await demoApi.fork(liveSnapshot.world.id, liveSnapshot.currentTimelineId, input)
        : await worldsApi.fork(liveSnapshot.world.id, liveSnapshot.currentTimelineId, crypto.randomUUID(), input)
      setForkId(fork.id)
      markTour('fork')
      const result = guest
        ? await demoApi.compare(liveSnapshot.world.id, liveSnapshot.currentTimelineId, fork.id)
        : await lifeApi.compare(liveSnapshot.world.id, liveSnapshot.currentTimelineId, fork.id) as { differences: { facts: unknown[]; states: unknown[]; events: { leftOnly: unknown[]; rightOnly: unknown[] } } }
      setCompare({ facts: result.differences.facts.length, states: result.differences.states.length, events: result.differences.events.leftOnly.length + result.differences.events.rightOnly.length })
      markTour('compare')
    } catch (error) { setActionError(error instanceof Error ? error.message : '平行宇宙创建失败') }
    finally { setBusy(false) }
  }
  return <main className="relative h-full min-h-screen overflow-hidden bg-[#dfe8df]" data-testid="guest-world-map">
    <WorldCanvasViewport scene={projected} theme={projectedTheme} mode="life" overlay={currentOverlay} selectedId={selected} onSelect={selectObject} edgeToEdge />
    <div className="pointer-events-none absolute inset-0 z-10">
      <header className="pointer-events-auto absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-[#172820]/80 via-[#172820]/30 to-transparent px-5 pb-10 pt-4 text-white sm:px-7">
        <div><p className="font-story text-xl font-semibold sm:text-2xl">Possibility</p><p className="mt-0.5 text-[10px] tracking-[.24em] text-white/75">{liveSnapshot.world.name} · {inside ? '主楼室内' : '山间外景'} · 正在生活</p></div>
        {guest ? <div className="flex items-center gap-2"><button onClick={() => void reset()} disabled={busy} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">{busy ? '重置中…' : '重新开始'}</button><a href="/login?claimDemo=1" className="rounded-full border border-white/35 bg-[#263a31]/55 px-4 py-2 text-xs backdrop-blur-md sm:text-sm">登录并保存</a><details className="group relative"><summary aria-label="设置" title="设置" className="cursor-pointer list-none rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">设置</summary><div className="absolute right-0 top-full mt-2 w-44 rounded-xl border border-white/60 bg-[#f8faf6] p-1.5 text-xs text-[#405246] shadow-lg"><button onClick={openTextView} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-[#e7eee7]">文字世界视图</button><button onClick={() => setTourOpen(true)} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-[#e7eee7]">重新开启导览</button></div></details></div> : <div className="flex items-center gap-2"><select aria-label="切换世界" value={liveSnapshot.world.id} onChange={event => event.target.value === '__new__' ? navigate('/worlds/new') : navigate(`/worlds/${encodeURIComponent(event.target.value)}`)} className="max-w-40 rounded-full border border-white/45 bg-[#263a31]/70 px-3 py-2 text-xs text-white"><option value={liveSnapshot.world.id}>{liveSnapshot.world.name}</option>{worldChoices.filter(world => world.id !== liveSnapshot.world.id).map(world => <option key={world.id} value={world.id} className="text-[#263a31]">{world.name}</option>)}<option value="__new__" className="text-[#263a31]">创建世界</option></select><details className="group relative"><summary aria-label="设置" title="设置" className="cursor-pointer list-none rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">设置</summary><div className="absolute right-0 top-full mt-2 w-44 rounded-xl border border-white/60 bg-[#f8faf6] p-1.5 text-xs text-[#405246] shadow-lg"><button onClick={openTextView} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-[#e7eee7]">文字世界视图</button><button onClick={() => { clearToken(); navigate('/login', { replace: true }) }} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-[#e7eee7]">退出登录</button></div></details></div>}
      </header>
      <div className="pointer-events-auto absolute left-3 top-24 flex gap-2 sm:left-5">
        <button onClick={() => { setSpaceId(inside ? 'exterior' : 'main-house-interior'); setSelected(null) }} className="rounded-full border border-white/70 bg-[#f8faf6]/92 px-4 py-2 text-xs font-medium text-[#385142] shadow-md backdrop-blur-md">{inside ? '← 返回庭院' : '进入主楼 →'}</button>
        <span className="rounded-full border border-white/70 bg-[#f8faf6]/85 px-3 py-2 text-[10px] text-[#5a6e61] shadow-sm">{new Date(liveSnapshot.simNow).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
        {liveSnapshot.timelines.length > 1 && <label className="flex items-center gap-1 rounded-full border border-white/70 bg-[#f8faf6]/85 px-3 py-1 text-[10px] text-[#5a6e61] shadow-sm">宇宙<select aria-label="切换时间线" data-testid="timeline-switcher" disabled={timelineBusy} value={liveSnapshot.currentTimelineId} onChange={event => void switchTimeline(event.target.value)} className="bg-transparent text-[#385142] outline-none">{liveSnapshot.timelines.map(timeline => <option key={timeline.id} value={timeline.id}>{timeline.parentTimelineId ? `分支 ${timeline.id.slice(0, 6)}` : '原来的发展'}{timeline.id === forkId ? ' · 新' : ''}</option>)}</select>{timelineBusy && <span>切换中…</span>}</label>}
      </div>
      <nav aria-label="体验位置" className="pointer-events-auto absolute left-1/2 top-4 flex -translate-x-1/2 rounded-full border border-white/40 bg-[#253b31]/60 p-1 text-[11px] text-white shadow-md backdrop-blur-md">
        {([['observe', '观察'], ['life', '在场'], ['possibility', '可能']] as const).map(([value, label]) => <button key={value} aria-pressed={mode === value} onClick={() => setMapMode(value)} className={`rounded-full px-3 py-1.5 ${mode === value ? 'bg-white text-[#30483a]' : 'text-white/80'}`}>{label}</button>)}
      </nav>
      {(selectedObject || locationName) && <section className="pointer-events-auto absolute right-3 top-24 w-[min(21rem,calc(100vw-1.5rem))] rounded-2xl border border-white/80 bg-[#f8faf6]/95 p-4 text-[#405246] shadow-xl backdrop-blur-md sm:right-5">
        <div className="flex items-start justify-between gap-2"><div><p className="text-[10px] uppercase tracking-[.16em] text-[#7a897d]">{person ? '居民' : '地点'}</p><h1 className="mt-0.5 font-story text-lg">{person?.name ?? locationName ?? selectedObject?.label}</h1></div><button aria-label="关闭信息" onClick={() => setSelected(null)} className="rounded-full px-2 text-lg text-[#718075]">×</button></div>
        {person && <><p className="mt-2 text-xs text-[#68796d]">现在在{person.location} · {person.activity}</p><div className="mt-4 flex gap-2"><button onClick={() => setSceneLocation(person.location)} className="rounded-full bg-[#315641] px-3 py-2 text-xs text-white">以访客身份进入</button><button onClick={() => setSelected(null)} className="rounded-full border border-[#ccd7cf] px-3 py-2 text-xs">继续观察</button></div></>}
        {locationName && <><p className="mt-2 text-xs leading-relaxed text-[#68796d]">{location?.description ?? '雾影庄中的一处空间。'}</p><p className="mt-3 border-t border-[#dce3de] pt-3 text-xs">此刻在这里：{people.length ? people.map(item => `${item.name}（${item.activity}）`).join('、') : '暂时没有居民'}</p><button onClick={() => setSceneLocation(locationName)} className="mt-4 rounded-full bg-[#315641] px-4 py-2 text-xs text-white">进入此地点</button>{selectedObject?.id === 'main-manor' && !inside && <button onClick={() => { setSpaceId('main-house-interior'); setSelected(null) }} className="ml-2 rounded-full border border-[#ccd7cf] px-4 py-2 text-xs">查看室内</button>}</>}
      </section>}
      {mode === 'possibility' && <section className="pointer-events-auto absolute right-3 top-24 w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl border border-white/80 bg-[#f8faf6]/95 p-4 text-[#405246] shadow-xl backdrop-blur-md sm:right-5">
        <p className="text-[10px] uppercase tracking-[.16em] text-[#7a897d]">改变一个条件</p><h2 className="mt-1 font-story text-lg">如果匿名信更早被发现</h2><p className="mt-2 text-xs leading-relaxed text-[#68796d]">共同过去保持不变，从当前世界时刻创建另一条真实时间线。对照只说明两个宇宙记录到的差异。</p>
        {!forkId && <button disabled={busy} onClick={() => void createPossibility()} className="mt-4 w-full rounded-full bg-[#315641] px-4 py-2.5 text-xs text-white disabled:opacity-60">{busy ? '正在建立平行宇宙…' : '创建并对照'}</button>}
        {forkId && <div className="mt-4 rounded-xl bg-[#eaf0eb] p-3 text-xs"><p className="font-medium">已创建平行宇宙</p><p className="mt-1 font-mono text-[10px] text-[#6e7c73]">{forkId.slice(0, 18)}…</p><p className="mt-2">{compare ? `${compare.facts} 项事实差异 · ${compare.states} 组状态差异 · ${compare.events} 条事件差异` : '共同起点已冻结，可以继续体验后再比较。'}</p></div>}
        {forkId && <button onClick={() => { setMode('life'); markTour('return') }} className="mt-3 w-full rounded border border-[#ccd7cf] px-3 py-2 text-xs">返回地图</button>}
        {actionError && <p role="status" className="mt-3 text-xs text-red-700">{actionError}</p>}
      </section>}
      {tourOpen ? <aside className="pointer-events-auto absolute bottom-4 left-3 max-w-[min(38rem,calc(100vw-1.5rem))] rounded-xl border border-white/80 bg-[#f8faf6]/95 px-4 py-3 text-xs text-[#50665a] shadow-lg backdrop-blur-md sm:left-5" aria-live="polite">
        <div className="flex items-center gap-3"><span className="font-medium">{nextTourStep ? `体验指引 ${tourIndex + 1}/8` : '导览已完成'}</span><span className="text-[#708177]">{nextTourStep ? tourSteps[tourIndex]?.[1] : '已完成全部步骤。'}</span><button aria-label="关闭导览" title="关闭导览" onClick={() => setTourOpen(false)} className="ml-auto rounded px-2 py-1 text-base">×</button><button onClick={() => { setTourDone(tourOrder); try { localStorage.setItem(tourStorageKey(liveSnapshot.world.id), JSON.stringify(tourOrder)) } catch { /* Tour progress is optional. */ }; setTourOpen(false) }} className="whitespace-nowrap rounded border border-[#d4ded7] px-3 py-1.5">跳过</button></div>
      </aside> : <button onClick={() => setTourOpen(true)} className="pointer-events-auto absolute bottom-4 left-3 rounded border border-white/80 bg-[#f8faf6]/95 px-3 py-2 text-xs text-[#50665a] shadow-lg sm:left-5">重新开启导览</button>}
      <div className="absolute bottom-4 right-3 hidden rounded-full border border-white/80 bg-[#f8faf6]/90 px-3 py-2 text-[10px] text-[#66776b] shadow-sm sm:block">访客独立副本 · {liveSnapshot.locationBoard.reduce((total, row) => total + row.persons.length, 0)} 位居民</div>
    </div>
    {sceneLocation && <ScenePanel worldId={liveSnapshot.world.id} timelineId={liveSnapshot.currentTimelineId} locations={liveSnapshot.world.locations} initialLocation={sceneLocation} onMilestone={handleSceneMilestone} onClose={() => {
      setSceneLocation(null)
      void mapApi.bootstrap(liveSnapshot.world.id, liveSnapshot.currentTimelineId).then(data => setLiveSnapshot(data.world)).catch(() => {})
    }} />}
  </main>
}
