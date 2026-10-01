import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, clearToken, lifeApi, mapApi, publicApi, subscribeWorldStream, worldSceneApi, worldsApi } from '../api/client'
import type {
  ForkScenario, ForkScenarioInput, HistoryRange, TimelineComparison, TimelineInfo, WorldSnapshot,
} from '../api/types'
import { SceneHistoryPanel, type SceneRevisionItem } from '../components/scene/SceneHistoryPanel'
import { buildSceneOverlay } from '../scene/life/overlay'
import { SceneTimelineGuard } from '../scene/life/timelineGuard'
import { RequestScopeController } from '../world/requestScope'
import VoxelViewport from '../voxel/VoxelViewport'
import type { OrbitPose } from '../voxel/engine'
import { parseVoxelDocument, parseVoxelSpaces } from '../voxel/flags'
import { serialize, type SerializedVoxelDocument, type VoxelDocument } from '@possibility/voxel-contract'
import { planEditsViaApi } from '../voxel/plan-edits'
import AlignedTimeline from '../components/world/AlignedTimeline'
import { buildAlignedAxis, filterAt, type AxisMarker } from '../world/alignedTimeline'
import TimelineSwitcher from '../components/world/TimelineSwitcher'
import ForkCompareHint from '../components/world/ForkCompareHint'
import LifePanel from '../components/world/LifePanel'
import ComparePanel from '../components/world/ComparePanel'
import ScenePanel from '../components/world/ScenePanel'
import InjectBox from '../components/world/InjectBox'
import EvidenceNotice from '../components/world/EvidenceNotice'
import GlobalCapBanner from '../components/GlobalCapBanner'
import WorldLlmConfigPanel from '../components/WorldLlmConfigPanel'
import { GuestWorldMap } from '../components/map/GuestWorldMap'

/**
 * 世界画布页(S2 起唯一世界页):体素视口 + 全部世界能力(分叉/干预/在场/对照/LLM/生命周期)。
 * 文字主视图已退役;辅助文字以覆盖层形式保留。
 */
export default function WorldCanvasPage({ worldId, readonly = false, guest = false }: { worldId: string; readonly?: boolean; guest?: boolean }) {
  const [search, setSearch] = useSearchParams(); const timelineId = search.get('timeline'); const navigate = useNavigate()
  const [worldChoices, setWorldChoices] = useState<{ id: string; name: string }[]>([])
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null)
  const [sceneDoc, setSceneDoc] = useState<unknown>(null)
  const [sceneMissing, setSceneMissing] = useState(false)
  const [canEditScene, setCanEditScene] = useState(false)
  const [resumeSpaceId, setResumeSpaceId] = useState('exterior')
  const [resumeMode, setResumeMode] = useState<'life' | 'possibility'>('life')
  const [otherSnapshot, setOtherSnapshot] = useState<WorldSnapshot | null>(null)
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
  const [mode, setMode] = useState<'life' | 'possibility'>(() => search.get('mode') === 'possibility' ? 'possibility' : 'life')
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const [regeneratingDemo, setRegeneratingDemo] = useState(false)
  const [regenerateError, setRegenerateError] = useState('')
  const [revisionList, setRevisionList] = useState<SceneRevisionItem[] | null>(null)
  const [revisionCurrent, setRevisionCurrent] = useState(0)
  // S2 再安家:原文字视图能力的覆盖层开关
  const [lifeOpen, setLifeOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [llmConfigOpen, setLlmConfigOpen] = useState(false)
  const [presenceOpen, setPresenceOpen] = useState(false)
  const [injectOpen, setInjectOpen] = useState(false)
  const [actionError, setActionError] = useState('')
  const [forkHint, setForkHint] = useState<{ sourceId: string; newId: string } | null>(null)
  // S4/F6:分叉弹窗打开时按线加载历史可回溯范围;失败保持 undefined(时刻区不渲染)
  const [historyRange, setHistoryRange] = useState<{ tid: string; range: HistoryRange } | null>(null)
  const forkRequestIdRef = useRef<string | null>(null)
  const requestScope = useRef<RequestScopeController | null>(null)
  if (!requestScope.current) requestScope.current = new RequestScopeController({ worldId, timelineId: timelineId ?? '', spaceId: 'exterior' })
  const snapshotVersion = useRef(0); snapshotVersion.current = snapshot?.stateVersion ?? 0
  const isSmall = useMemo(() => typeof window !== 'undefined' && matchMedia('(max-width: 767px)').matches, [])
  const activeTimelineId = timelineId ?? snapshot?.currentTimelineId ?? ''

  const read = useCallback(async () => {
    setError(''); setSceneMissing(false)
    const scopes = requestScope.current!
    scopes.update({ worldId, timelineId: timelineId ?? '', spaceId: 'exterior' })
    const request = scopes.create()
    try {
      if (readonly && !guest) {
        const [world, current] = await Promise.all([publicApi.snapshot(worldId, timelineId ?? undefined, request.controller.signal), publicApi.scene(worldId, request.controller.signal)])
        if (!scopes.accepts(request.scope)) return
        setSnapshot(world)
        if (current.status === 'ready') setSceneDoc(current.document)
        else { setSceneDoc(null); setSceneMissing(true) }
      } else {
        const bootstrap = await mapApi.bootstrap(worldId, timelineId ?? undefined, request.controller.signal)
        if (!scopes.accepts(request.scope)) return
        setSnapshot(bootstrap.world)
        setCanEditScene(bootstrap.access.editScene)
        setResumeSpaceId(bootstrap.resume.spaceId)
        setResumeMode(bootstrap.resume.mode === 'possibility' ? 'possibility' : 'life')
        if (bootstrap.scene.status === 'ready') setSceneDoc(bootstrap.scene.document)
        else if (bootstrap.scene.status === 'unavailable') { setSceneDoc(null); setSceneMissing(true) }
        else setSceneDoc(null)
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

  // URL 入口深链(同路由导航不重挂载):mode/right 从地址栏同步进状态
  useEffect(() => {
    if (search.get('mode') === 'possibility' && mode !== 'possibility') setMode('possibility')
    const urlRight = search.get('right')
    if (urlRight && urlRight !== rightTimelineId) setRightTimelineId(urlRight)
  }, [search])

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
  // S4 身份统一:事件面板参与者显示名(personId → 姓名,全地点板汇总)
  const personNames = useMemo(() => Object.fromEntries(
    [...(snapshot?.locationBoard ?? []), ...(otherSnapshot?.locationBoard ?? [])]
      .flatMap(row => row.persons.map(person => [person.id, person.name])),
  ), [snapshot, otherSnapshot])
  // 体素文档(S2 起唯一形态):单空间信封 → 视口;多空间包 → GuestWorldMap
  const voxelDoc = useMemo(() => parseVoxelDocument(sceneDoc), [sceneDoc])
  const voxelSpaces = useMemo(() => parseVoxelSpaces(sceneDoc), [sceneDoc])
  // S1 分屏:轴模型(纯函数) + 拖档截断;拖档只过滤事件流,视口始终渲染当前状态
  const splitActive = mode === 'possibility' && voxelDoc !== null
  const axis = useMemo(() => splitActive && comparison ? buildAlignedAxis(comparison) : null, [splitActive, comparison])
  const scrubbed = useMemo(() => axis && scrubAt ? filterAt(axis, scrubAt) : null, [axis, scrubAt])
  // 拖档对齐:带 simTime 重取对照(防抖),对齐 limitations(状态无历史表等)原文呈现
  const [alignedComparison, setAlignedComparison] = useState<TimelineComparison | null>(null)
  useEffect(() => {
    if (!scrubAt || !snapshot || !otherSnapshot) { setAlignedComparison(null); return }
    const leftId = snapshot.currentTimelineId
    const rightId = otherSnapshot.currentTimelineId
    let active = true
    const timer = setTimeout(() => {
      void lifeApi.compare(worldId, leftId, rightId, { simTime: scrubAt })
        .then((result) => { if (active) setAlignedComparison(result) })
        .catch(() => { if (active) setAlignedComparison(null) })
    }, 300)
    return () => { active = false; clearTimeout(timer) }
  }, [scrubAt, snapshot, otherSnapshot, worldId])
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

  // ── 时间线/世界生命周期(原文字视图顶栏能力,S2 再安家) ──
  const selectTimeline = useCallback((next: string | null) => {
    const params = new URLSearchParams(search)
    if (next) params.set('timeline', next); else params.delete('timeline')
    setSearch(params, { replace: true })
  }, [search, setSearch])

  const refreshSnapshot = useCallback(async () => {
    const snap = await worldsApi.snapshot(worldId, timelineId ?? undefined).catch(() => null)
    if (snap) setSnapshot(current => current?.currentTimelineId === snap.currentTimelineId && current.stateVersion > snap.stateVersion ? current : snap)
  }, [worldId, timelineId])

  const handleFork = async (scenario: ForkScenarioInput): Promise<boolean> => {
    const sourceTimelineId = activeTimelineId
    if (!sourceTimelineId) return false
    setActionError('')
    try {
      const requestId = forkRequestIdRef.current ?? crypto.randomUUID()
      forkRequestIdRef.current = requestId
      const fork = await worldsApi.fork(worldId, sourceTimelineId, requestId, scenario)
      forkRequestIdRef.current = null
      selectTimeline(fork.id)
      setForkHint({ sourceId: sourceTimelineId, newId: fork.id })
      return true
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Fork 失败')
      return false
    }
  }
  /** 一句话预览(S2/F1):LLM 起草五字段场景,不落库;S4/F6 可带已吸附的历史时刻 */
  const handleForkPreview = async (whatIf: string, startTime?: string): Promise<ForkScenario> => {
    if (!activeTimelineId) throw new Error('尚未选择时间线')
    return worldsApi.forkPreview(worldId, activeTimelineId, whatIf, startTime)
  }
  const handleForkOpen = () => {
    if (!activeTimelineId || historyRange?.tid === activeTimelineId) return
    worldsApi.historyRange(worldId, activeTimelineId)
      .then((range) => setHistoryRange({ tid: activeTimelineId, range }))
      .catch(() => { /* 范围不可用:时刻区不渲染,现时刻分叉不受影响 */ })
  }
  const handleCheckMoment = async (at: string): Promise<string> => {
    if (!activeTimelineId) throw new Error('尚未选择时间线')
    return (await worldsApi.checkMoment(worldId, activeTimelineId, at)).effectiveMoment
  }
  const handleArchiveTimeline = async (tid: string) => {
    setActionError('')
    try {
      await worldsApi.archiveTimeline(tid)
      if (tid === activeTimelineId) selectTimeline(null)
      else await refreshSnapshot()
    } catch (e) { setActionError(e instanceof Error ? e.message : '归档失败') }
  }
  const handlePauseResume = async () => {
    if (!snapshot) return
    setActionError('')
    try {
      if (snapshot.world.status === 'running') await worldsApi.pause(worldId)
      else await worldsApi.resume(worldId)
      await refreshSnapshot()
    } catch (e) { setActionError(e instanceof Error ? e.message : '操作失败') }
  }
  const handleArchiveWorld = async () => {
    setActionError('')
    try {
      await worldsApi.archive(worldId)
      await refreshSnapshot()
    } catch (e) { setActionError(e instanceof Error ? e.message : '归档失败') }
  }
  const handleInject = async (text: string, requestId: string) => {
    if (!activeTimelineId) return
    setActionError('')
    try {
      const state = await worldsApi.state(worldId, activeTimelineId)
      await worldsApi.inject(worldId, text, activeTimelineId, requestId, state.version)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '注入失败')
      throw e
    }
  }

  // ── 场景修订历史(体素信封同样走 voxel-revision 链) ──
  async function loadRevisionList() {
    try {
      const current = await worldSceneApi.get(worldId)
      setRevisionCurrent(current.status === 'ready' ? current.version : 0)
      setRevisionList((await worldSceneApi.history(worldId)).revisions)
    } catch (e) { setError(e instanceof Error ? e.message : '场景历史读取失败') }
  }
  async function restoreVersion(version: number) {
    setBusy(true)
    try {
      await worldSceneApi.restore(worldId, revisionCurrent, version)
      setRevisionList(null)
      voxelVersionRef.current = null
      void read()
    } catch (e) { setError(e instanceof Error ? e.message : '场景恢复失败'); if (e instanceof ApiError && e.status === 409) void read() }
    finally { setBusy(false) }
  }

  // S2b 体素保存通道:EditController 防抖回调须身份稳定(VoxelViewport 以 onSave 为装配依赖)。
  // voxel 信封的 version 是格式字面量而非修订版本,首次保存前经 GET scene 取真实版本,成功后用返回值推进;
  // 保存成功不 setSceneDoc——引擎内文档已是最新,换 voxelDoc 身份会导致整个视口重挂载。
  const voxelVersionRef = useRef<number | null>(null)
  const saveVoxel = useCallback(async (doc: VoxelDocument) => {
    try {
      if (voxelVersionRef.current == null) {
        const current = await worldSceneApi.get(worldId)
        voxelVersionRef.current = current.status === 'ready' ? current.version : 0
      }
      const saved = await worldSceneApi.commitVoxel(worldId, voxelVersionRef.current, crypto.randomUUID(), JSON.parse(serialize(doc)) as SerializedVoxelDocument)
      voxelVersionRef.current = saved.version
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { voxelVersionRef.current = null; setError('场景有新版本，请重新加载后再继续。'); void read() }
      else if (e instanceof ApiError && e.status === 422) setError(`体素场景未通过校验：${e.issues?.[0]?.message ?? e.message}`)
      else setError(e instanceof Error ? e.message : '体素保存失败')
    }
  }, [worldId, read])

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
              <VoxelViewport document={voxelDoc!} overlay={overlay} events={snapshot!.voxelEvents ?? null} personNames={personNames} instanceId="left" probePrimary
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
                ? <VoxelViewport document={voxelDoc!} overlay={otherOverlay} events={otherSnapshot.voxelEvents ?? null} personNames={personNames} instanceId="right"
                    cameraPose={linkActive ? sharedPose : undefined}
                    onCameraChange={setSharedPose}
                    onCameraModeChange={(m) => setSplitWalk(s => ({ ...s, right: m === 'walk' }))} />
                : <div className="grid h-full min-h-[430px] place-items-center rounded-2xl bg-white/60 text-sm text-[#718075]">正在读取另一种发展…</div>}
            </div>
            {renderSplitEvents('right', otherSnapshot)}
          </section>
        </div>
        {axis && <AlignedTimeline axis={axis} at={scrubAt} onScrub={setScrubAt} onSelect={handleSelectMarker} />}
        {compareSummary && <p className="text-xs text-[#687a6b]" data-testid="split-compare-summary">已有记录：{compareSummary.facts} 项事实差异、{compareSummary.states} 组人物状态差异、{compareSummary.events} 条分支独有事件。场景布局相同；画面只显示各自时间线已记录的生活状态。</p>}
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-white/70 px-3 py-2 text-xs text-[#526558]">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" data-testid="split-camera-link" checked={cameraLinked} onChange={(e) => setCameraLinked(e.target.checked)} />
            相机联动
          </label>
          {(splitWalk.left || splitWalk.right) && <span data-testid="split-walk-notice" className="text-amber-700">第一视角下相机联动已暂停（两线的「我」不在同一位置）</span>}
          <span className="text-[#849184]">联动开启时，一侧的旋转/缩放/平移同步到另一侧</span>
        </div>
        {(alignedComparison ?? comparison) && (alignedComparison ?? comparison)!.limitations.length > 0 && (
          <ul data-testid="split-limitations" className="space-y-0.5 text-[10px] text-[#849184]">
            {(alignedComparison ?? comparison)!.limitations.map((x, i) => <li key={i}>· {x}</li>)}
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
              events={(smallSide === 'left' ? snapshot!.voxelEvents : otherSnapshot?.voxelEvents) ?? null}
              instanceId={smallSide === 'left' ? 'left' : 'right'} probePrimary={smallSide === 'left'} personNames={personNames} />
          : <div className="grid min-h-[430px] place-items-center rounded-2xl bg-white/60 text-sm text-[#718075]">正在读取另一种发展…</div>}
        <p className="text-[10px] text-[#849184]">窄屏仅显示单视口；大屏可同时分屏查看两条时间线。</p>
      </div>
    )
  }

  if (error && !snapshot) return (
    <div className="flex min-h-full items-center bg-[#eef0e7] p-4">
      <div className="m-auto w-full max-w-md rounded-2xl border border-ink-faint bg-white p-6 text-center shadow-sm" data-testid="world-canvas-error">
        <p className="text-sm text-red-700">{error}</p>
        <button onClick={() => void read()} className="mt-4 rounded-full border border-[#d7ded3] bg-white px-4 py-2 text-sm text-[#536558]">重试</button>
      </div>
    </div>
  )
  if (!snapshot) return <div className="grid min-h-full place-items-center text-sm text-[#718075]">正在准备这方天地…</div>
  if (voxelSpaces) return <GuestWorldMap voxelSpaces={voxelSpaces} snapshot={snapshot} overlay={overlay} initialSpaceId={resumeSpaceId} initialMode={resumeMode} guest={guest} editable={canEditScene} />
  if (!voxelDoc) return (
    <div className="grid min-h-[calc(100vh-7rem)] bg-[#eef0e7] p-4">
      <div className="m-auto w-full max-w-md rounded-2xl border border-ink-faint bg-white p-6 text-center shadow-sm" data-testid="world-canvas-missing">
        <p className="text-sm text-[#526558]">{sceneMissing ? '场景暂时不可用，请重试。' : '这方天地还没有可渲染的场景。'}</p>
        <button onClick={() => void read()} className="mt-4 rounded-full border border-[#d7ded3] bg-white px-4 py-2 text-sm text-[#536558]">重试</button>
      </div>
    </div>
  )

  const worldStatus = snapshot.world.status
  const running = worldStatus === 'running'
  const capped = worldStatus === 'capped'
  const archived = worldStatus === 'archived'
  const evidenceReadonly = snapshot.evidence.level !== 'complete'
  const canInteract = !readonly && !guest && !evidenceReadonly
  async function regenerateDemo() {
    if (!snapshot || regeneratingDemo || !window.confirm('重新生成所有演示空间？当前场景将保留在历史版本中。')) return
    setRegeneratingDemo(true); setRegenerateError('')
    try {
      await worldSceneApi.regenerateDemo(worldId, revisionCurrent)
      await read()
      await loadRevisionList()
    } catch (e) { setRegenerateError(e instanceof Error ? e.message : '重新生成失败') }
    finally { setRegeneratingDemo(false) }
  }

  if (readonly) return <main className="relative h-full min-h-screen overflow-hidden bg-[#e7eee7]" data-testid="world-canvas-page">
    <VoxelViewport document={voxelDoc} overlay={overlay} events={snapshot.voxelEvents ?? null} personNames={personNames} />
    <div className="pointer-events-none absolute inset-0 z-10">
      <header className="pointer-events-auto absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-[#23382f]/65 to-transparent px-5 pb-8 pt-4 text-white sm:px-7">
        <div><p className="font-story text-xl font-semibold tracking-tight sm:text-2xl">Possibility</p><p className="text-[10px] tracking-[.24em] text-white/70">{snapshot.world.name} · 正在生活</p></div>
        <a href="/login" className="rounded-full border border-white/35 bg-[#263a31]/45 px-4 py-2 text-xs backdrop-blur-md transition hover:bg-[#263a31]/70 sm:text-sm">登录，创建你的世界</a>
      </header>
      <div className="absolute bottom-4 left-3 rounded-full border border-white bg-[#f8faf6] px-3 py-2 text-[10px] text-[#4f6457] shadow-sm sm:left-5">拖动浏览 · 滚轮缩放 · 点击建筑或人物</div>
      <div className="absolute bottom-4 right-3 rounded-full border border-white bg-[#f8faf6] px-3 py-2 text-[10px] text-[#66776b] shadow-sm sm:right-5">{guest ? '访客副本 · 可安全体验' : '只读世界'} · {snapshot.locationBoard.reduce((total, row) => total + row.persons.length, 0)} 位居民</div>
    </div>
  </main>

  return <main className="flex min-h-screen flex-col gap-3 bg-[#eef0e7] p-3 sm:p-5" data-testid="world-canvas-page">
    {revisionList && <SceneHistoryPanel revisions={revisionList} currentVersion={revisionCurrent} busy={busy} onRestore={version => void restoreVersion(version)} onClose={() => setRevisionList(null)} />}
    <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-[.16em] text-[#849183]">{snapshot.world.name}{snapshot.world.isDemo ? ' · 演示世界' : ''}</p><h1 className="font-story text-xl text-[#2d4435]">{mode === 'possibility' ? '另一种可能' : '这里正在生活'}</h1></div><div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="map-world-switcher">切换世界</label><select id="map-world-switcher" aria-label="切换世界" value={worldId} onChange={event => event.target.value === '__new__' ? navigate('/worlds/new') : navigate(`/worlds/${encodeURIComponent(event.target.value)}`)} className="max-w-44 rounded-full border border-[#d7ded3] bg-white/90 px-3 py-2 text-xs text-[#536558]">
        {worldChoices.map(world => <option key={world.id} value={world.id}>{world.name}</option>)}<option value="__new__">＋ 创建世界</option>
      </select>
      <TimelineSwitcher
        timelines={snapshot.timelines}
        currentTimelineId={activeTimelineId}
        onSwitch={(next) => selectTimeline(next)}
        onFork={handleFork}
        onPreview={handleForkPreview}
        onArchive={(tid) => void handleArchiveTimeline(tid)}
        writeLocked={evidenceReadonly}
        onSplitView={() => setMode('possibility')}
        historyRange={historyRange?.tid === activeTimelineId ? historyRange.range : undefined}
        onForkOpen={handleForkOpen}
        onCheckMoment={handleCheckMoment}
      />
      {canEditScene && snapshot.world.isDemo && voxelSpaces && <button data-testid="demo-regenerate" disabled={regeneratingDemo} onClick={() => void regenerateDemo()} className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]">{regeneratingDemo ? '重新生成中…' : '重新生成演示世界'}</button>}
      {canInteract && <button onClick={() => setInjectOpen(v => !v)} className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]">干预</button>}
      {canInteract && <button onClick={() => setPresenceOpen(true)} className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]">在场</button>}
      <button onClick={() => setLifeOpen(true)} className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]">你不在时</button>
      {snapshot.timelines.length > 1 && <button onClick={() => setCompareOpen(true)} className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]">对照宇宙</button>}
      <button onClick={() => setLlmConfigOpen(v => !v)} className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]">LLM</button>
      {(running || !evidenceReadonly) && <button onClick={() => void handlePauseResume()} className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]">{running ? '暂停' : '继续'}</button>}
      <button onClick={() => void loadRevisionList()} className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]">历史</button>
      <button onClick={() => navigate('/settings')} className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]">设置</button>
      <button onClick={() => void handleArchiveWorld()} className="rounded-full border border-[#d7ded3] bg-white/85 px-3 py-2 text-xs text-[#849184]">归档</button>
      <button aria-label="退出登录" title="退出登录" onClick={() => { clearToken(); navigate('/login', { replace: true }) }} className="rounded-full border border-[#d7ded3] bg-white/85 px-3 py-2 text-xs text-[#536558]">退出</button>
    </div></header>
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className={`rounded-full px-2 py-0.5 ${running ? 'bg-emerald-100 text-emerald-700' : capped ? 'bg-red-100 text-red-700' : archived ? 'bg-paper-deep text-ink-faint' : 'bg-paper-deep text-ink-soft'}`} data-testid="world-status">
        {running ? '运行中' : capped ? '已达今日上限' : archived ? '已归档（冻结可读）' : '已暂停'}
      </span>
      <span className="text-[#849184]">世界时间 {fmtSim(snapshot.simNow)} · 今日调用 {snapshot.world.callsToday}</span>
    </div>
    {capped && snapshot.world.pauseReason === 'global_daily_cap' && <GlobalCapBanner />}
    {capped && snapshot.world.pauseReason !== 'global_daily_cap' && (
      <p className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-600">今日调用已达上限，世界已自动暂停，次日自动恢复运行。</p>
    )}
    <EvidenceNotice evidence={snapshot.evidence} />
    {llmConfigOpen && <WorldLlmConfigPanel worldId={worldId} />}
    {error && <p role="status" className="rounded-xl bg-white px-4 py-2 text-sm text-red-700">{error}</p>}
    {actionError && <p role="status" className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-600">{actionError}</p>}
    {regenerateError && <p role="status" className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-600">{regenerateError}</p>}
    {/* S2/F6：人物级分叉跳页落点——forkFrom 触发「并排看看」横幅,关闭后抹参;页内分叉成功后同样提示 */}
    {(forkHint ?? (search.get('forkFrom') ? { sourceId: search.get('forkFrom')!, newId: activeTimelineId } : null)) && !guest && (
      <ForkCompareHint
        worldId={worldId}
        sourceId={(forkHint ?? { sourceId: search.get('forkFrom')! }).sourceId}
        newId={forkHint?.newId ?? activeTimelineId}
        onDismiss={() => {
          setForkHint(null)
          if (search.get('forkFrom')) { const params = new URLSearchParams(search); params.delete('forkFrom'); setSearch(params, { replace: true }) }
        }}
      />
    )}
    {injectOpen && canInteract && (
      <div className="rounded-2xl bg-white/85 px-4 py-3" data-testid="inject-overlay">
        <p className="mb-2 text-xs text-[#849184]">叙事干预会写入当前宇宙历史，并由居民在后续生活中自行感知和回应；它不等同于直接改变环境事实。</p>
        <InjectBox onInject={handleInject} />
      </div>
    )}
    <div className="flex min-h-[500px] flex-1 gap-3"><div className="flex min-w-0 flex-1 flex-col gap-3">
      {mode === 'possibility' && !isSmall ? renderSplitView() : mode === 'possibility' ? renderSmallSplit()
        : <VoxelViewport document={voxelDoc} overlay={overlay} events={snapshot.voxelEvents ?? null} personNames={personNames} editable planEdits={planEditsViaApi} onSave={saveVoxel} />}
      {mode === 'life' && <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-white/85 px-4 py-3 text-sm text-[#526558]"><span>{overlay?.timeOfDay === 'night' ? '夜色渐深，街灯亮起。' : overlay?.weather ? `此刻天气：${overlay.weather}` : '居民正按照自己的处境继续生活。'}</span><span className="text-xs text-[#849184]">{new Date(snapshot.simNow).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', weekday: 'short' })}</span></div>}
    </div></div>
    {lifeOpen && activeTimelineId && <LifePanel worldId={worldId} timelineId={activeTimelineId} onClose={() => setLifeOpen(false)} />}
    {compareOpen && activeTimelineId && snapshot.timelines.length > 1 && <ComparePanel worldId={worldId} currentTimelineId={activeTimelineId} timelines={snapshot.timelines} onClose={() => setCompareOpen(false)} />}
    {presenceOpen && activeTimelineId && <ScenePanel key={`${worldId}:${activeTimelineId}`} worldId={worldId} timelineId={activeTimelineId} locations={snapshot.world.locations} onClose={() => setPresenceOpen(false)} />}
  </main>
}
