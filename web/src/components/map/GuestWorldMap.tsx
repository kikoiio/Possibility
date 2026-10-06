import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { type SceneLifeOverlay } from '@possibility/scene-contract'
import { deserialize, serialize, type SceneCandidate, type SceneEditPreflightResult, type SerializedVoxelDocument, type SerializedVoxelSpaces } from '@possibility/voxel-contract'
import type { ForkResult, ForkScenario, PersonListItem, WorldSnapshot } from '../../api/types'
import { ApiError, apiFetch, clearToken, demoApi, guestMapApi, lifeApi, mapApi, worldSceneApi, worldsApi } from '../../api/client'
import ScenePanel from '../world/ScenePanel'
import ScenarioCard from '../ScenarioCard'
import ComparePanel from '../world/ComparePanel'
import WorldTimeZoneSetting from '../world/WorldTimeZoneSetting'
import { forkFieldsError, timelineDisplayName, timelineOptionLabel } from '../../world/timeline-display'
import { buildSceneOverlay } from '../../scene/life/overlay'
import VoxelViewport from '../../voxel/VoxelViewport'
import type { VoxelEngine } from '../../voxel/engine'
import type { EditPlan } from '../../voxel/plan-edits'
import type { PreflightBlocked } from '../../voxel/bridge/edit-controller'
import MapSelectionCard from './MapSelectionCard'
import Drawer from '../ui/Drawer'
import { formatWorldTime } from '../../lib/world-time'
import { buildWorldDisambiguationItems, worldPersonLabel, worldStatusLabel } from '../../lib/world-disambiguation'
import { applyTourMilestone, loadTourProgress, tourOrder, tourSteps, tourStorageKey, type TourStep } from './tour'

export interface GuestWorldMapProps {
  voxelSpaces: SerializedVoxelSpaces
  snapshot: WorldSnapshot
  overlay: SceneLifeOverlay | null
  initialSpaceId?: string
  initialMode?: 'create' | 'life' | 'possibility'
  guest?: boolean
  claimPending?: boolean
  editable?: boolean
  planEdits?: (engine: VoxelEngine, intent: string) => Promise<EditPlan>
  preflightEdits?: (candidate: SceneCandidate) => Promise<SceneEditPreflightResult>
  /** A1(W18):多空间与单空间共用同一兼容入口;当前空间只作为编辑目标,预检/诊断覆盖整个包 */
  onCompatibilityRequired?: () => void
  /** A1(W18):多空间场景历史入口(与单空间共用 WorldCanvasPage 的历史面板) */
  onOpenHistory?: () => void
  /** A1(W18):当前场景兼容诊断入口 */
  onOpenCompatibility?: () => void
  onInject?: () => void
  onPresence?: () => void
  onLife?: () => void
  onPauseResume?: () => void
  onArchive?: () => void
  onLlmConfig?: () => void
  onCompare?: () => void
  running?: boolean
  canInteract?: boolean
}

/** 多空间体素地图(S2 起唯一形态):外景 ↔ 室内,访客沙盒与拥有者共用 */
export function GuestWorldMap({
  voxelSpaces,
  snapshot,
  overlay,
  initialSpaceId,
  initialMode = 'life',
  guest = true,
  claimPending = false,
  editable = false,
  planEdits,
  preflightEdits,
  onCompatibilityRequired,
  onOpenHistory,
  onOpenCompatibility,
  onInject,
  onPresence,
  onLife,
  onPauseResume,
  onArchive,
  onLlmConfig,
  onCompare,
  running,
  canInteract,
}: GuestWorldMapProps) {
  const navigate = useNavigate()
  const [liveSnapshot, setLiveSnapshot] = useState(snapshot)
  const [worldChoices, setWorldChoices] = useState<ReturnType<typeof buildWorldDisambiguationItems>>([])
  const [sceneLocation, setSceneLocation] = useState<string | null>(null)
  useEffect(() => setLiveSnapshot(snapshot), [snapshot])
  const [spaceId, setSpaceIdState] = useState(() =>
    voxelSpaces.spaces.some(space => space.id === initialSpaceId) ? initialSpaceId! : voxelSpaces.defaultSpaceId)
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tourDone, setTourDone] = useState<TourStep[]>(() => loadTourProgress(snapshot.world.id))
  const [tourOpen, setTourOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'observe' | 'life' | 'possibility'>(initialMode === 'create' ? 'life' : initialMode)
  const [forkId, setForkId] = useState<string | null>(liveSnapshot.timelines.find(item => item.parentTimelineId)?.id ?? null)
  const [compareOpen, setCompareOpen] = useState(false)
  const [forkResult, setForkResult] = useState<ForkResult | null>(null)
  const [forkRefreshError, setForkRefreshError] = useState('')
  const [forkConfirmOpen, setForkConfirmOpen] = useState(false)
  const [forkDraft, setForkDraft] = useState<ForkScenario>({ name: '匿名信提前被发现', whatIf: '三田村千鹤今天提前发现那封匿名信', changedVariable: '匿名信被发现的时间', startTime: liveSnapshot.simNow, participants: [], invariants: ['共同过去保持不变', '比较结果只表示记录到的差异'] })
  const forkPending = useRef(false)
  const forkRequestId = useRef<string | null>(null)
  const [switchTarget, setSwitchTarget] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [timelineBusy, setTimelineBusy] = useState(false)
  const timelinePending = useRef(false)
  const [editDoc, setEditDoc] = useState<import('@possibility/voxel-contract').VoxelDocument | null>(null)
  const [editVersion, setEditVersion] = useState<number | null>(null)
  const saveBusyRef = useRef(false)
  const onCompatibilityRequiredRef = useRef(onCompatibilityRequired)
  onCompatibilityRequiredRef.current = onCompatibilityRequired
  const [saveError, setSaveError] = useState('')
  const [regenerating, setRegenerating] = useState(false)
  async function regenerateDemo() {
    if (!editable || !liveSnapshot.world.isDemo || regenerating || !window.confirm('重新生成所有演示空间？当前场景将保留在历史版本中。')) return
    setRegenerating(true); setSaveError('')
    try {
      const current = await worldSceneApi.get(liveSnapshot.world.id)
      const version = current.status === 'ready' ? current.version : 0
      await worldSceneApi.regenerateDemo(liveSnapshot.world.id, version)
      window.location.reload()
    } catch (error) { setSaveError(error instanceof Error ? error.message : '重新生成失败') }
    finally { setRegenerating(false) }
  }
  const saveSpace = useCallback(async (next: import('@possibility/voxel-contract').VoxelDocument) => {
    if (!editable || saveBusyRef.current) return
    saveBusyRef.current = true
    setSaveError('')
    try {
      const current = await worldSceneApi.get(liveSnapshot.world.id)
      const version = editVersion ?? (current.status === 'ready' ? current.version : 0)
      const bundle = current.status === 'ready' && 'spaces' in current.document ? current.document : voxelSpaces
      const nextBundle = { ...bundle, spaces: bundle.spaces.map(space => space.id === spaceId ? { ...space, document: JSON.parse(serialize(next)) as SerializedVoxelDocument } : space) }
      const saved = await worldSceneApi.commitVoxel(liveSnapshot.world.id, version, crypto.randomUUID(), nextBundle, spaceId)
      setEditVersion(saved.version)
      setEditDoc(null)
    } catch (error) {
      // A1(W18):整包兼容阻断 → 打开与单空间相同的修复旅程;当前场景保持不变
      if (error instanceof ApiError && error.status === 422 && error.errorCode === 'compatibility-required') onCompatibilityRequiredRef.current?.()
      setSaveError(error instanceof Error ? error.message : '空间保存失败')
    }
    finally { saveBusyRef.current = false }
  }, [editable, liveSnapshot.world.id, editVersion, voxelSpaces, spaceId])
  async function switchTimeline(nextId: string) {
    if (nextId === liveSnapshot.currentTimelineId || timelinePending.current) return
    timelinePending.current = true
    setSwitchTarget(nextId); setTimelineBusy(true); setActionError('')
    try {
      const data = guest ? await guestMapApi.bootstrap(liveSnapshot.world.id, nextId) : await mapApi.bootstrap(liveSnapshot.world.id, nextId)
      setLiveSnapshot(data.world)
      setForkId(forkResult && data.world.timelines.some(item => item.id === forkResult.id)
        ? forkResult.id : data.world.timelines.find(item => item.id === nextId && item.parentTimelineId)?.id ?? data.world.timelines.find(item => item.parentTimelineId)?.id ?? null)
      setCompareOpen(false)
      void (guest ? guestMapApi.saveResume(liveSnapshot.world.id, { timelineId: nextId, spaceId, mode: mode === 'observe' ? 'life' : mode }) : mapApi.saveResume(liveSnapshot.world.id, { timelineId: nextId, spaceId, mode: mode === 'observe' ? 'life' : mode }))
    } catch { setActionError('时间线切换失败；当前宇宙和原选择已保留，可重试切换。') }
    finally { timelinePending.current = false; setTimelineBusy(false) }
  }
  useEffect(() => {
    if (guest) return
    let active = true
    void Promise.all([worldsApi.list(), apiFetch<{ persons: PersonListItem[] }>('/api/persons')]).then(([worldResult, personResult]) => {
      if (active) setWorldChoices(buildWorldDisambiguationItems(worldResult.worlds, personResult.persons))
    }).catch(() => {
      void worldsApi.list().then(result => { if (active) setWorldChoices(buildWorldDisambiguationItems(result.worlds, [])) }).catch(() => {})
    })
    return () => { active = false }
  }, [guest])
  // 体素模式:当前空间文档(空间切换 → 换文档重挂载视口)
  const voxelDoc = useMemo(() => {
    const space = voxelSpaces.spaces.find(item => item.id === spaceId) ?? voxelSpaces.spaces[0]
    try {
      return deserialize(JSON.stringify(space.document))
    } catch {
      return null
    }
  }, [voxelSpaces, spaceId])
  const voxelObject = selected ? voxelDoc?.objects.find(object => object.id === selected) ?? null : null
  const locationName = voxelObject?.binding?.kind === 'location'
    ? voxelObject.binding.locationName
    : voxelDoc?.locations.find(item => item.objectId === selected)?.name ?? null
  const personId = voxelObject?.binding?.kind === 'person' ? voxelObject.binding.personId : selectedPersonId
  const person = personId ? liveSnapshot.locationBoard.flatMap(row => row.persons.map(item => ({ ...item, location: row.location }))).find(item => item.id === personId) ?? null : null
  const location = locationName ? liveSnapshot.world.locations.find(item => item.name === locationName) : null
  const people = locationName ? liveSnapshot.locationBoard.find(row => row.location === locationName)?.persons ?? [] : []
  const currentOverlay = useMemo(() => buildSceneOverlay(liveSnapshot, liveSnapshot.currentTimelineId) ?? overlay, [liveSnapshot, overlay])
  const spaceName = voxelSpaces.spaces.find(item => item.id === spaceId)?.name ?? ''
  const nextTourStep = tourOrder.find(step => !tourDone.includes(step))
  const tourIndex = nextTourStep ? tourOrder.indexOf(nextTourStep) : tourOrder.length
  const [tourNotice, setTourNotice] = useState('')
  // 跳步反馈短暂展示(S3/F3)
  useEffect(() => {
    if (!tourNotice) return
    const timer = setTimeout(() => setTourNotice(''), 5000)
    return () => clearTimeout(timer)
  }, [tourNotice])
  function markTour(milestone: TourStep) {
    setTourDone(previous => {
      const { next, autoCompleted } = applyTourMilestone(previous, milestone)
      if (autoCompleted.length > 0) {
        const first = tourOrder.indexOf(autoCompleted[0]) + 1
        const last = tourOrder.indexOf(autoCompleted[autoCompleted.length - 1]) + 1
        setTourNotice(first === last ? `第 ${first} 步此前已完成` : `第 ${first}–${last} 步此前已完成`)
      }
      try { localStorage.setItem(tourStorageKey(liveSnapshot.world.id), JSON.stringify(next)) } catch { /* Tour progress is optional. */ }
      return next
    })
  }
  /** 重新开启导览(S3/F3):清空已完成进度(含持久化)并回到第 1 步 */
  function restartTour() {
    setTourDone([])
    setTourNotice('')
    try { localStorage.removeItem(tourStorageKey(liveSnapshot.world.id)) } catch { /* Ignore unavailable storage. */ }
    setTourOpen(true)
  }
  function selectObject(objectId: string | null) {
    setSelected(objectId)
    setSelectedPersonId(null)
    const object = objectId ? voxelDoc?.objects.find(item => item.id === objectId) : null
    if (object?.binding?.kind === 'person') markTour('inspect-person')
    const boundLocation = object?.binding?.kind === 'location'
      ? object.binding.locationName
      : (objectId ? voxelDoc?.locations.find(item => item.objectId === objectId)?.name : undefined)
    if (boundLocation && liveSnapshot.events.some(event => event.location === boundLocation)) markTour('discover-event')
  }
  /** 体素模式：直接点中行走的居民（无需物体绑定） */
  function selectResident(personId: string) {
    setSelected(null)
    setSelectedPersonId(personId)
    markTour('inspect-person')
  }
  const handleSceneMilestone = useCallback((milestone: 'enter-location' | 'interact' | 'change-condition') => {
    markTour(milestone)
  }, [liveSnapshot.world.id])
  function setSpaceId(next: string) {
    setSpaceIdState(next)
    void (guest ? guestMapApi.saveResume(liveSnapshot.world.id, { timelineId: liveSnapshot.currentTimelineId, spaceId: next, mode: mode === 'observe' ? 'life' : mode }) : mapApi.saveResume(liveSnapshot.world.id, { timelineId: liveSnapshot.currentTimelineId, spaceId: next, mode: mode === 'observe' ? 'life' : mode }))
  }
  function setMapMode(next: 'observe' | 'life' | 'possibility') {
    setMode(next)
    void (guest ? guestMapApi.saveResume(liveSnapshot.world.id, { timelineId: liveSnapshot.currentTimelineId, spaceId, mode: next === 'observe' ? 'life' : next }) : mapApi.saveResume(liveSnapshot.world.id, { timelineId: liveSnapshot.currentTimelineId, spaceId, mode: next === 'observe' ? 'life' : next }))
  }
  async function reset() {
    if (!guest || claimPending) return
    setBusy(true)
    try { await demoApi.reset(); try { localStorage.removeItem(tourStorageKey(liveSnapshot.world.id)) } catch { /* Ignore unavailable storage. */ }; window.location.reload() } finally { setBusy(false) }
  }
  async function refreshFork(result: ForkResult) {
    try {
      const data = guest ? await guestMapApi.bootstrap(liveSnapshot.world.id, liveSnapshot.currentTimelineId) : await mapApi.bootstrap(liveSnapshot.world.id, liveSnapshot.currentTimelineId)
      setLiveSnapshot(data.world)
      if (!data.world.timelines.some(t => t.id === result.sourceTimelineId) || !data.world.timelines.some(t => t.id === result.id)) throw new Error('新分支尚未出现在时间线列表中。')
      setForkRefreshError('')
    } catch {
      setForkRefreshError('分支已创建，时间线列表暂未更新。请重试刷新后再比较。')
    }
  }
  async function createPossibility() {
    if (forkPending.current) return
    const invalid = forkFieldsError(forkDraft)
    if (invalid) { setActionError(invalid); return }
    forkPending.current = true
    setBusy(true); setActionError('')
    try {
      const requestId = forkRequestId.current ?? crypto.randomUUID()
      forkRequestId.current = requestId
      const input = { ...forkDraft, name: forkDraft.name!.trim(), whatIf: forkDraft.whatIf.trim(), changedVariable: forkDraft.changedVariable.trim() }
      const fork = guest
        ? await demoApi.fork(liveSnapshot.world.id, liveSnapshot.currentTimelineId, input, requestId)
        : await worldsApi.fork(liveSnapshot.world.id, liveSnapshot.currentTimelineId, requestId, input)
      forkRequestId.current = null
      setForkId(fork.id); setForkResult(fork); setForkConfirmOpen(false)
      markTour('fork')
      await refreshFork(fork)
    } catch (error) { setActionError(error instanceof Error ? error.message : '平行宇宙创建失败，输入已保留，请重试。') }
    finally { forkPending.current = false; setBusy(false) }
  }
  const loadComparison = useCallback((left: string, right: string) => guest
    ? demoApi.compare(liveSnapshot.world.id, left, right)
    : lifeApi.compare(liveSnapshot.world.id, left, right), [guest, liveSnapshot.world.id])
  // A1(W31):手动编辑被既存问题阻断时打开与单空间相同的修复旅程
  const handleEditBlocked = useCallback((blocked: PreflightBlocked) => {
    if (blocked.kind !== 'invalid' || !blocked.report) return
    const issues = Array.isArray(blocked.report.issues) ? blocked.report.issues : []
    if (issues.some(issue => issue.origin === 'existing')) onCompatibilityRequired?.()
  }, [onCompatibilityRequired])
  const existingFork = liveSnapshot.timelines.find(t => t.id === forkId)
  const compareSourceId = forkResult?.sourceTimelineId ?? existingFork?.parentTimelineId
  const guestPersonNames = useMemo(
    () => Object.fromEntries(liveSnapshot.locationBoard.flatMap(row => row.persons.map(person => [person.id, person.name]))),
    [liveSnapshot.locationBoard]
  )

  return <main className="relative h-screen overflow-hidden bg-[#dfe8df]" data-testid="guest-world-map">
    {guest && claimPending && <div role="status" className="absolute left-1/2 top-16 z-30 -translate-x-1/2 rounded-full border border-white/70 bg-[#f8faf6]/95 px-4 py-2 text-xs text-[#405246] shadow-md">访客副本待保存 · <a href="/login?claimDemo=1" className="underline">继续认领</a></div>}
    {voxelDoc
      ? <VoxelViewport
          document={editDoc ?? voxelDoc}
          spaceId={spaceId}
          overlay={currentOverlay}
          editable={editable}
          planEdits={planEdits}
          preflightEdits={editable ? preflightEdits : undefined}
          onEditBlocked={handleEditBlocked}
          timeZone={liveSnapshot.world.timeZone}
          onSave={saveSpace}
          events={liveSnapshot.voxelEvents ?? null}
          personNames={guestPersonNames}
          onEnterSpace={(next) => { if (voxelSpaces.spaces.some(space => space.id === next)) { setSpaceId(next); setSelected(null); setSelectedPersonId(null) } }}
          onSelectLocation={(_name, objectId) => selectObject(objectId)}
          onSelectPerson={selectResident}
        />
      : <div className="grid h-full place-items-center text-sm text-[#718075]">空间场景暂时不可用。</div>}
    <div className="pointer-events-none absolute inset-0 z-10">
      <header className="pointer-events-auto absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-[#172820]/80 via-[#172820]/30 to-transparent px-5 pb-10 pt-4 text-white sm:px-7">
        <div><p className="font-story text-xl font-semibold sm:text-2xl">Possibility</p><p className="mt-0.5 text-[10px] tracking-[.24em] text-white/75">{liveSnapshot.world.name} · {spaceName} · 正在生活</p></div>
        {guest ? <div className="flex items-center gap-2">{!claimPending && <button onClick={() => void reset()} disabled={busy} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">{busy ? '重置中…' : '重新开始'}</button>}<a href="/login?claimDemo=1" className="rounded-full border border-white/35 bg-[#263a31]/55 px-4 py-2 text-xs backdrop-blur-md sm:text-sm">{claimPending ? '重试保存' : '登录并保存'}</a><button type="button" aria-label="设置" title="设置" onClick={() => setSettingsOpen(true)} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">设置</button></div> : <div className="flex items-center gap-2">
          {canInteract && onInject && <button onClick={onInject} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">干预</button>}
          {canInteract && onPresence && <button onClick={onPresence} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">在场</button>}
          {onLife && <button onClick={onLife} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">你不在时</button>}
          {liveSnapshot.timelines.length > 1 && onCompare && <button onClick={onCompare} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">对照宇宙</button>}
          {onLlmConfig && <button onClick={onLlmConfig} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">LLM</button>}
          {onPauseResume && <button onClick={onPauseResume} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">{running ? '暂停' : '继续'}</button>}
          {editable && liveSnapshot.world.isDemo && <button data-testid="demo-regenerate" onClick={() => void regenerateDemo()} disabled={regenerating} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">{regenerating ? '重新生成中…' : '重新生成'}</button>}
          {onOpenHistory && <button data-testid="scene-history-entry" onClick={onOpenHistory} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">历史</button>}
          {onOpenCompatibility && <button data-testid="scene-check-entry" onClick={onOpenCompatibility} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">场景检查</button>}
          <select aria-label="切换世界" value={liveSnapshot.world.id} onChange={event => {
            const selectedWorld = worldChoices.find(world => world.id === event.target.value)
            if (event.target.value === '__new__') navigate('/worlds/new')
            else if (selectedWorld?.hasScene) navigate(`/worlds/${encodeURIComponent(event.target.value)}`)
          }} className="max-w-40 rounded-full border border-white/45 bg-[#263a31]/70 px-3 py-2 text-xs text-white">
            <option value={liveSnapshot.world.id}>{liveSnapshot.world.name} · 当前 · {worldStatusLabel({ ...liveSnapshot.world, hasScene: true })}</option>
            {worldChoices.filter(world => world.id !== liveSnapshot.world.id).map(world => <option key={world.id} value={world.id} disabled={!world.hasScene} title={!world.hasScene ? '该世界待创建场景，当前无法进入。' : undefined} className="text-[#263a31]">{world.name} · {worldPersonLabel(world.personNames)} · {worldStatusLabel(world)}</option>)}
            <option value="__new__" className="text-[#263a31]">创建世界</option>
          </select>
          <button type="button" aria-label="设置" title="设置" onClick={() => setSettingsOpen(true)} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs backdrop-blur-md">设置</button>
          {onArchive && <button onClick={onArchive} className="rounded-full border border-white/35 bg-[#263a31]/55 px-3 py-2 text-xs text-white/70 backdrop-blur-md">归档</button>}
        </div>}
      </header>
      <div className="pointer-events-auto absolute left-3 top-32 flex max-w-[calc(100vw-1.5rem)] flex-wrap gap-2 sm:left-5 sm:top-24">
        {voxelSpaces.spaces.filter(space => space.id !== spaceId).map(space => (
          <button key={space.id} data-testid={`voxel-space-${space.id}`} onClick={() => { setSpaceId(space.id); setSelected(null); setSelectedPersonId(null) }} className="rounded-full border border-white/70 bg-[#f8faf6]/92 px-4 py-2 text-xs font-medium text-[#385142] shadow-md backdrop-blur-md">{space.name} →</button>
        ))}
        <span className="rounded-full border border-white/70 bg-[#f8faf6]/85 px-3 py-2 text-[10px] text-[#5a6e61] shadow-sm">{formatWorldTime(liveSnapshot.simNow, liveSnapshot.world.timeZone)}</span>
        {liveSnapshot.timelines.length > 1 && <label className="flex min-w-0 max-w-full items-center gap-1 rounded-full border border-white/70 bg-[#f8faf6]/85 px-3 py-1 text-[10px] text-[#5a6e61] shadow-sm">宇宙<select aria-label="切换时间线" data-testid="timeline-switcher" disabled={timelineBusy} value={switchTarget ?? liveSnapshot.currentTimelineId} onChange={event => void switchTimeline(event.target.value)} className="min-w-0 max-w-[45vw] bg-transparent text-[#385142] outline-none">{liveSnapshot.timelines.map(timeline => <option key={timeline.id} value={timeline.id}>{timelineOptionLabel(timeline)}{timeline.id === forkId ? ' · 新' : ''}</option>)}</select>{timelineBusy && <span>切换中…</span>}</label>}
        {switchTarget && actionError && <p role="status" className="w-full rounded-lg bg-white/95 p-2 text-xs text-red-700">{actionError}<button onClick={() => void switchTimeline(switchTarget)} className="ml-1 underline">重试切换</button></p>}
        {liveSnapshot.timelines.length > 1 && <p className="w-full rounded-lg bg-white/85 p-2 text-[10px] text-[#5a6e61]">当前为{timelineDisplayName(liveSnapshot.timelines.find(t => t.id === liveSnapshot.currentTimelineId) ?? { parentTimelineId: null })}；时间和居民数量属于各自时间线，切换后可能变化，未必处于同一时刻。场景几何和历史属于整个世界；切换时间线或恢复场景历史不会回滚各自时间线的生活记录。</p>}
      </div>
      <nav aria-label="体验位置" className="pointer-events-auto absolute left-1/2 top-20 flex -translate-x-1/2 rounded-full border border-white/40 bg-[#253b31]/60 p-1 text-[11px] text-white shadow-md backdrop-blur-md sm:top-4">
        {([['observe', '观察'], ['life', '在场'], ['possibility', '可能']] as const).map(([value, label]) => <button key={value} aria-pressed={mode === value} onClick={() => setMapMode(value)} className={`rounded-full px-3 py-1.5 ${mode === value ? 'bg-white text-[#30483a]' : 'text-white/80'}`}>{label}</button>)}
      </nav>
      {(voxelObject || locationName || person) && <MapSelectionCard
        person={person}
        locationName={locationName}
        locationDescription={location?.description ?? null}
        peopleHere={people}
        fallbackLabel={voxelObject?.label ?? null}
        onClose={() => { setSelected(null); setSelectedPersonId(null) }}
        onEnter={name => setSceneLocation(name)}
      />}
      {mode === 'possibility' && <section className="pointer-events-auto absolute right-3 top-24 z-30 w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl border border-white/80 bg-[#f8faf6]/95 p-4 text-[#405246] shadow-xl backdrop-blur-md sm:right-5">
        <p className="text-[10px] uppercase tracking-[.16em] text-[#7a897d]">改变一个条件</p><h2 className="mt-1 font-story text-lg">如果匿名信更早被发现</h2><p className="mt-2 text-xs leading-relaxed text-[#68796d]">共同过去保持不变，从当前世界时刻创建另一条真实时间线。对照只说明两个宇宙记录到的差异。</p>
        {!forkId && !forkConfirmOpen && <button disabled={busy} onClick={() => { setActionError(''); setForkDraft(current => ({ ...current, startTime: liveSnapshot.simNow })); setForkConfirmOpen(true) }} className="mt-4 w-full rounded-full bg-[#315641] px-4 py-2.5 text-xs text-white disabled:opacity-60">创建并对照</button>}
        {!forkId && forkConfirmOpen && <div className="mt-3 max-h-[60vh] overflow-y-auto" role="dialog" aria-label="确认平行宇宙"><ScenarioCard scenario={forkDraft} timeZone={liveSnapshot.world.timeZone} onChange={setForkDraft} /><div className="mt-3 flex gap-2"><button disabled={busy} onClick={() => { setForkConfirmOpen(false); setActionError('') }} className="flex-1 rounded-lg border px-3 py-2 text-xs">取消</button><button data-testid="guest-fork-confirm" disabled={busy} onClick={() => void createPossibility()} className="flex-1 rounded-lg bg-[#315641] px-3 py-2 text-xs text-white disabled:opacity-60">{busy ? '正在建立平行宇宙…' : '确认创建'}</button></div></div>}
        {forkId && <div data-testid="guest-fork-summary" className="mt-4 rounded-xl bg-[#eaf0eb] p-3 text-xs"><p className="font-medium">已创建平行宇宙 · {forkResult?.name || (existingFork ? timelineDisplayName(existingFork) : '平行宇宙')}</p><p className="mt-1">假设：{forkResult?.whatIf || existingFork?.forkScenario?.whatIf || '未记录'}</p><p className="mt-2">共同起点已冻结，比较仅展示各自时间线的记录差异。</p>{forkRefreshError && <p role="status" className="mt-2 text-red-700">{forkRefreshError}<button onClick={() => forkResult && void refreshFork(forkResult)} className="ml-1 underline">重试刷新时间线</button></p>}<button disabled={!!forkRefreshError || !compareSourceId} onClick={() => { setCompareOpen(true); markTour('compare') }} className="mt-3 rounded-lg bg-[#315641] px-3 py-2 text-xs text-white disabled:opacity-60">直接比较来源与新分支</button></div>}
        {forkId && <button onClick={() => { setMode('life'); markTour('return') }} className="mt-3 w-full rounded border border-[#ccd7cf] px-3 py-2 text-xs">返回地图</button>}
        {actionError && <p role="status" className="mt-3 text-xs text-red-700">{actionError}</p>}
      </section>}
      {tourOpen ? <aside className="pointer-events-auto absolute bottom-4 left-3 max-w-[min(38rem,calc(100vw-1.5rem))] rounded-xl border border-white/80 bg-[#f8faf6]/95 px-4 py-3 text-xs text-[#50665a] shadow-lg backdrop-blur-md sm:left-5" aria-live="polite">
        <div className="flex items-center gap-3"><span className="font-medium">{nextTourStep ? `体验指引 ${tourIndex + 1}/8` : '导览已完成'}</span><span className="text-[#708177]">{nextTourStep ? tourSteps[tourIndex]?.[1] : '已完成全部步骤。'}</span><button aria-label="关闭导览" title="关闭导览" onClick={() => setTourOpen(false)} className="ml-auto rounded px-2 py-1 text-base">×</button><button onClick={() => { setTourDone(tourOrder); try { localStorage.setItem(tourStorageKey(liveSnapshot.world.id), JSON.stringify(tourOrder)) } catch { /* Tour progress is optional. */ }; setTourOpen(false) }} className="whitespace-nowrap rounded border border-[#d4ded7] px-3 py-1.5">跳过</button></div>
        {tourNotice && <p role="status" className="mt-1.5 text-[11px] text-[#7a897d]">{tourNotice}</p>}
      </aside> : <button onClick={() => nextTourStep ? setTourOpen(true) : restartTour()} className="pointer-events-auto absolute bottom-4 left-3 rounded border border-white/80 bg-[#f8faf6]/95 px-3 py-2 text-xs text-[#50665a] shadow-lg sm:left-5">{nextTourStep ? '继续导览' : '重新开启导览'}</button>}
      <div className="absolute bottom-14 right-3 hidden rounded-full border border-white/80 bg-[#f8faf6]/90 px-3 py-2 text-[10px] text-[#66776b] shadow-sm sm:block">访客独立副本 · {liveSnapshot.locationBoard.reduce((total, row) => total + row.persons.length, 0)} 位居民</div>
    </div>
    {saveError && <p role="status" className="pointer-events-auto absolute bottom-16 left-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 shadow sm:left-5">{saveError}</p>}
    {compareOpen && forkId && compareSourceId && <ComparePanel worldId={liveSnapshot.world.id} currentTimelineId={liveSnapshot.currentTimelineId} timelines={liveSnapshot.timelines} personNames={guestPersonNames} initialLeftTimelineId={compareSourceId} initialRightTimelineId={forkId} loadComparison={loadComparison} onClose={() => setCompareOpen(false)} />}
    {sceneLocation && <ScenePanel timeZone={liveSnapshot.world.timeZone} worldStatus={liveSnapshot.world.status} readOnly={liveSnapshot.evidence?.level !== 'complete'} worldId={liveSnapshot.world.id} timelineId={liveSnapshot.currentTimelineId} locations={liveSnapshot.world.locations} initialLocation={sceneLocation} onMilestone={handleSceneMilestone} onClose={() => {
      setSceneLocation(null)
      void (guest ? guestMapApi.bootstrap(liveSnapshot.world.id, liveSnapshot.currentTimelineId) : mapApi.bootstrap(liveSnapshot.world.id, liveSnapshot.currentTimelineId)).then(data => setLiveSnapshot(data.world)).catch(() => {})
    }} />}
    <Drawer open={settingsOpen} onClose={() => setSettingsOpen(false)} title="设置与世界管理" description={`${liveSnapshot.world.name} · ${guest ? '访客视图' : '所有者管理'}`}>
      <div className="space-y-4 text-xs text-ink-soft">
        {!liveSnapshot.world.isDemo && (
          <div className="rounded-xl border border-ink-line bg-sheet p-3">
            <h3 className="mb-2 font-medium text-ink">世界时区</h3>
            <WorldTimeZoneSetting
              worldId={liveSnapshot.world.id}
              timeZone={liveSnapshot.world.timeZone}
              onSaved={timeZone => setLiveSnapshot(current => ({ ...current, world: { ...current.world, timeZone }, timelines: current.timelines.map(t => ({ ...t, timeZone })) }))}
            />
          </div>
        )}
        <div className="rounded-xl border border-ink-line bg-sheet p-2 space-y-1">
          <button
            type="button"
            onClick={() => { setSettingsOpen(false); nextTourStep ? setTourOpen(true) : restartTour() }}
            className="block w-full rounded-lg px-3 py-2.5 text-left text-xs font-medium text-ink hover:bg-paper-deep"
          >
            {nextTourStep ? '🧭 继续导览' : '🧭 重新开启导览'}
          </button>
          {!guest && (
            <button
              type="button"
              onClick={() => { setSettingsOpen(false); navigate('/settings') }}
              className="block w-full rounded-lg px-3 py-2.5 text-left text-xs font-medium text-ink hover:bg-paper-deep"
            >
              ⚙️ LLM 设置与日预算
            </button>
          )}
          <button
            type="button"
            onClick={() => { setSettingsOpen(false); clearToken(); navigate('/login', { replace: true }) }}
            className="block w-full rounded-lg px-3 py-2.5 text-left text-xs font-medium text-cinnabar hover:bg-cinnabar-soft"
          >
            🚪 退出登录
          </button>
        </div>
      </div>
    </Drawer>
  </main>
}
