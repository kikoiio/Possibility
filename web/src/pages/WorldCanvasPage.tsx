import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, authApi, getGuestToken, getToken, guestMapApi, lifeApi, mapApi, publicApi, sceneCompatibilityApi, setGuestRequestContext, subscribeAuthIdentityChange, subscribeWorldStream, worldSceneApi, worldsApi } from '../api/client'
import type {
  CompatibilityPurpose, ForkInitialAction, ForkScenario, ForkScenarioInput, ForkResult, HistoryRange, SceneCandidate, SceneTarget, TimelineComparison, WorldSnapshot,
} from '../api/types'
import type { SceneHistoryViewState } from '../components/scene/SceneHistoryPanel'
import { SceneCompatibilityPanel } from '../components/scene/SceneCompatibilityPanel'
import { SceneRepairPreview } from '../components/scene/SceneRepairPreview'
import { createCompatibilitySession, type CompatibilitySession, type CompatibilitySessionClient } from '../scene/compatibility-session'
import { startCompatibilityPolling } from '../scene/compatibility-polling'
import type { CompatibilityContinuation } from '../scene/compatibility-store'
import { buildSceneOverlay } from '../scene/life/overlay'
import { SceneTimelineGuard } from '../scene/life/timelineGuard'
import { RequestScopeController } from '../world/requestScope'
import VoxelViewport from '../voxel/VoxelViewport'
import type { OrbitPose } from '../voxel/engine'
import { parseVoxelDocument, parseVoxelSpaces } from '../voxel/flags'
import { deserialize, serialize, type SerializedVoxelDocument, type VoxelDocument } from '@possibility/voxel-contract'
import { planEditsViaApi, EditPlanRequestError } from '../voxel/plan-edits'
import type { VoxelEngine } from '../voxel/engine'
import { buildAlignedAxis, filterAt, type AxisMarker } from '../world/alignedTimeline'
import EvidenceNotice from '../components/world/EvidenceNotice'
import GlobalCapBanner from '../components/GlobalCapBanner'
import { GuestWorldMap } from '../components/map/GuestWorldMap'
import MapSelectionCard from '../components/map/MapSelectionCard'
import { formatWorldTime } from '../lib/world-time'
import WorldTimeZoneSetting from '../components/world/WorldTimeZoneSetting'
import WorldHeader from '../components/world/shell/WorldHeader'
import SplitViewStage from '../components/world/shell/SplitViewStage'
import WorldModalsContainer from '../components/world/shell/WorldModalsContainer'
import ComparisonHost from '../components/world/presentation/ComparisonHost'
import PresentationSwitcher from '../components/world/presentation/PresentationSwitcher'
import { createPresentationRuntime } from '../components/world/presentation/presentation-runtime'
import { readPresentationRoute, updatePanePresentation, updatePaneTimeline, updateRightPaneTarget } from '../components/world/presentation/presentation-route'
import { createPresentationStateStore } from '../lib/presentation-state'

type AsyncReadState<T> =
  | { status: 'closed' | 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; message: string }

/**
 * 世界画布页(S2 起唯一世界页):体素视口 + 全部世界能力(分叉/干预/在场/对照/LLM/生命周期)。
 * 文字主视图已退役;辅助文字以覆盖层形式保留。
 */
export default function WorldCanvasPage({ worldId, readonly = false, guest = false, claimPending = false }: { worldId: string; readonly?: boolean; guest?: boolean; claimPending?: boolean }) {
  const [search, setSearch] = useSearchParams(); const timelineId = search.get('timeline')
  const navigate = useNavigate()
  const presentationStore = useMemo(() => createPresentationStateStore(), [])
  const presentationRuntime = useMemo(() => createPresentationRuntime(guest ? 'guest' : readonly ? 'public' : 'account'), [guest, readonly])
  const [worldChoices, setWorldChoices] = useState<{ id: string; name: string; hasScene: boolean }[]>([])
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null)
  const [sceneDoc, setSceneDoc] = useState<unknown>(null)
  const [sceneMissing, setSceneMissing] = useState(false)
  const [canEditScene, setCanEditScene] = useState(false)
  const [resumeSpaceId, setResumeSpaceId] = useState('exterior')
  const [resumeMode, setResumeMode] = useState<'life' | 'possibility'>('life')
  const [rightSceneRead, setRightSceneRead] = useState<AsyncReadState<WorldSnapshot>>({ status: 'closed' })
  // S1 分屏:右线显式选择(URL ?right= 驱动)、完整对照数据、拖档对齐时刻、相机联动
  const [rightTimelineId, setRightTimelineId] = useState<string | null>(() => search.get('right'))
  const [comparisonRead, setComparisonRead] = useState<AsyncReadState<TimelineComparison>>({ status: 'closed' })
  const rightSnapshotRequestId = useRef(0)
  const comparisonRequestId = useRef(0)
  const [scrubAt, setScrubAt] = useState<string | null>(null)
  const [cameraLinked, setCameraLinked] = useState(true)
  const [sharedPose, setSharedPose] = useState<OrbitPose | null>(null)
  const [splitWalk, setSplitWalk] = useState<{ left: boolean; right: boolean }>({ left: false, right: false })
  const [smallSide, setSmallSide] = useState<'left' | 'right'>('left')
  const [selectedSplitEvent, setSelectedSplitEvent] = useState<string | null>(null)
  const splitEventEls = useRef(new Map<string, HTMLElement>())
  const [mode, setMode] = useState<'life' | 'possibility'>(() => search.get('mode') === 'possibility' ? 'possibility' : 'life')
  const [error, setError] = useState('')
  useEffect(() => {
    setGuestRequestContext(guest)
    return () => setGuestRequestContext(false)
  }, [guest])
  const [regeneratingDemo, setRegeneratingDemo] = useState(false)
  const [regenerateError, setRegenerateError] = useState('')
  const [sceneHistoryState, setSceneHistoryState] = useState<SceneHistoryViewState | { status: 'closed' }>({ status: 'closed' })
  const [revisionCurrent, setRevisionCurrent] = useState(0)
  const sceneHistoryRequestId = useRef(0)
  const sceneHistoryLoading = useRef(false)
  const [restoringRevision, setRestoringRevision] = useState(false)
  const [restoreError, setRestoreError] = useState('')
  const restoreRequestId = useRef(0)
  useEffect(() => () => { sceneHistoryRequestId.current += 1; restoreRequestId.current += 1 }, [worldId])
  // A1 场景兼容:诊断/修复草稿/确认/结果恢复全部经会话状态机驱动,面板只读展示 continuation。
  const [compatContinuation, setCompatContinuation] = useState<CompatibilityContinuation | null>(null)
  const [compatReadyScope, setCompatReadyScope] = useState<{ worldId: string; authIdentityEpoch: number } | null>(null)
  const [authIdentityEpoch, setAuthIdentityEpoch] = useState(0)
  const authIdentityEpochRef = useRef(0)
  const compatSessionRef = useRef<CompatibilitySession | null>(null)
  useEffect(() => subscribeAuthIdentityChange(() => {
    authIdentityEpochRef.current += 1
    setAuthIdentityEpoch(authIdentityEpochRef.current)
  }), [])
  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | null = null
    let session: CompatibilitySession | null = null
    const identityEpoch = authIdentityEpoch
    const identityToken = guest ? getGuestToken() : getToken()
    setCompatReadyScope(null)
    setCompatContinuation(null)
    const client: CompatibilitySessionClient = {
      inspect: input => sceneCompatibilityApi.inspection(worldId, input.target.kind === 'history' ? { version: input.target.version } : {}),
      createDraft: input => sceneCompatibilityApi.createDraft(worldId, {
        draftRequestId: input.draftRequestId,
        purpose: input.purpose,
        target: input.target,
        expectedCurrentVersion: input.expectedCurrentVersion,
      }),
      submit: input => sceneCompatibilityApi.confirm(worldId, {
        draftId: input.draftId,
        requestId: input.requestId,
        expectedCurrentVersion: input.expectedCurrentVersion,
        expectedAttempt: input.expectedAttempt,
      }),
      query: input => sceneCompatibilityApi.readRequest(worldId, input.requestId),
      recover: input => sceneCompatibilityApi.recoverRequest(worldId, input.requestId, {
        draftId: input.draftId,
        expectedCurrentVersion: input.expectedCurrentVersion,
        expectedAttempt: input.expectedAttempt,
      }),
    }
    const attachAuthorizedSession = async () => {
      try {
        const actorKey = guest ? 'guest' : (await authApi.me({ redirectOnUnauthorized: false })).user.id
        if (!active || authIdentityEpochRef.current !== identityEpoch || (guest ? getGuestToken() : getToken()) !== identityToken) return
        // Do not load locally cached draft metadata until the server confirms this
        // identity can read the requested world's current scene.
        await worldSceneApi.get(worldId, { redirectOnUnauthorized: false })
        if (!active || authIdentityEpochRef.current !== identityEpoch || (guest ? getGuestToken() : getToken()) !== identityToken) return
        session = createCompatibilitySession({ scope: { actorKey, worldId }, client })
        compatSessionRef.current = session
        unsubscribe = session.subscribe(setCompatContinuation)
        setCompatContinuation(session.snapshot())
        setCompatReadyScope({ worldId, authIdentityEpoch: identityEpoch })
      } catch {
        if (active) {
          setCompatContinuation(null)
          setCompatReadyScope(null)
        }
      }
    }
    void attachAuthorizedSession()
    return () => {
      active = false
      unsubscribe?.()
      session?.dispose()
      if (compatSessionRef.current === session) compatSessionRef.current = null
    }
  }, [worldId, guest, authIdentityEpoch])
  useEffect(() => {
    const continuation = compatReadyScope?.worldId === worldId && compatReadyScope.authIdentityEpoch === authIdentityEpoch
      ? compatContinuation : null
    const session = compatSessionRef.current
    if (!session || continuation?.state !== 'submitting' || !continuation.requestId) return
    return startCompatibilityPolling({
      query: async () => { await session.queryResult() },
      isVisible: () => document.visibilityState === 'visible',
      subscribeVisibility: listener => {
        document.addEventListener('visibilitychange', listener)
        return () => document.removeEventListener('visibilitychange', listener)
      },
    })
  }, [worldId, compatReadyScope, authIdentityEpoch, compatContinuation?.state, compatContinuation?.requestId])
  // S2 再安家:原文字视图能力的覆盖层开关
  const [lifeOpen, setLifeOpen] = useState(false)
  const [forkPrefill, setForkPrefill] = useState<{ key: string; whatIf: string; simTime: string } | null>(null)
  const [compareOpen, setCompareOpen] = useState(false)
  const [llmConfigOpen, setLlmConfigOpen] = useState(false)
  const [presenceOpen, setPresenceOpen] = useState(false)
  // S3/F1:单空间 owner 路径的地图选中(居民/地点卡)与 ScenePanel 预选地点
  const [mapSelected, setMapSelected] = useState<string | null>(null)
  const [mapPersonId, setMapPersonId] = useState<string | null>(null)
  const [presenceLocation, setPresenceLocation] = useState<string | null>(null)
  const [injectOpen, setInjectOpen] = useState(false)
  const [actionError, setActionError] = useState('')
  const [forkHint, setForkHint] = useState<(ForkResult & { sourceId: string; newId: string }) | null>(null)
  const [forkRefreshError, setForkRefreshError] = useState('')
  const [compareInitial, setCompareInitial] = useState<{ left: string; right: string } | null>(null)
  const timelineSwitching = useRef(false)
  const forking = useRef(false)
  const forkInputRef = useRef('')
  // S4/F6:分叉弹窗打开时按线加载历史可回溯范围;失败保持 undefined(时刻区不渲染)
  const [historyRange, setHistoryRange] = useState<{ tid: string; range: HistoryRange } | null>(null)
  const forkRequestIdRef = useRef<string | null>(null)
  const requestScope = useRef<RequestScopeController | null>(null)
  if (!requestScope.current) requestScope.current = new RequestScopeController({ worldId, timelineId: timelineId ?? '', spaceId: 'exterior' })
  const snapshotVersion = useRef(0); snapshotVersion.current = snapshot?.stateVersion ?? 0
  const isSmall = useMemo(() => typeof window !== 'undefined' && matchMedia('(max-width: 767px)').matches, [])
  const activeTimelineId = timelineId ?? snapshot?.currentTimelineId ?? ''
  const presentationRoute = readPresentationRoute(worldId, search, presentationStore.getPreferred())
  const comparisonWorkspaceActive = search.has('presentation') || search.has('rightWorld') || presentationRoute.left.presentation === 'native2d'
  const savedVoxelCamera = presentationStore.getCamera({ worldId, timelineId: activeTimelineId || 'main', presentation: 'voxel3d' })
  const legacyVoxelPose = savedVoxelCamera?.kind === 'voxel3d' ? savedVoxelCamera.pose : null
  const presentationWorlds = useMemo(() => {
    const options = worldChoices.map(world => ({
      id: world.id,
      name: world.name,
      timelineIds: world.id === worldId ? snapshot?.timelines.map(timeline => timeline.id) : undefined,
    }))
    if (!options.some(world => world.id === worldId)) {
      options.unshift({ id: worldId, name: snapshot?.world.name ?? worldId, timelineIds: snapshot?.timelines.map(timeline => timeline.id) })
    }
    return options
  }, [worldChoices, worldId, snapshot])
  const updatePresentationTarget = useCallback((pane: 'single' | 'left' | 'right', target: import('../components/world/presentation/presentation-types').PaneTarget | null) => {
    if (pane === 'right') {
      if (target) presentationStore.setPreferred(target.presentation)
      setSearch(updateRightPaneTarget(search, target), { replace: true })
      return
    }
    if (!target) return
    presentationStore.setPreferred(target.presentation)
    const next = updatePanePresentation(updatePaneTimeline(search, 'left', target.timelineId ?? null), 'left', target.presentation)
    if (target.worldId === worldId) setSearch(next, { replace: true })
    else navigate(`/worlds/${encodeURIComponent(target.worldId)}?${next.toString()}`)
  }, [navigate, presentationStore, search, setSearch, worldId])
  const selectSinglePresentation = useCallback((presentation: 'native2d' | 'voxel3d') => {
    if (presentation !== 'voxel3d' && presentationRoute.left.presentation === 'voxel3d') {
      const pose = (window as Window & { __voxelEngine?: { getOrbitPose(): OrbitPose | null } }).__voxelEngine?.getOrbitPose()
      if (pose && activeTimelineId) presentationStore.setCamera({ worldId, timelineId: activeTimelineId, presentation: 'voxel3d' }, { kind: 'voxel3d', version: 1, pose })
    }
    presentationStore.setPreferred(presentation)
    setSearch(updatePanePresentation(search, 'single', presentation), { replace: true })
  }, [activeTimelineId, presentationRoute.left.presentation, presentationStore, search, setSearch, worldId])
  const exitPresentationWorkspace = useCallback(() => {
    const next = new URLSearchParams(search)
    next.delete('presentation')
    presentationStore.setPreferred('voxel3d')
    setSearch(next, { replace: true })
  }, [presentationStore, search, setSearch])
  const saveLegacyCameraPose = useCallback((pose: OrbitPose) => {
    if (!activeTimelineId) return
    presentationStore.setCamera({ worldId, timelineId: activeTimelineId, presentation: 'voxel3d' }, { kind: 'voxel3d', version: 1, pose })
  }, [activeTimelineId, presentationStore, worldId])
  const otherSnapshot = rightSceneRead.status === 'ready' ? rightSceneRead.value : null
  const comparison = comparisonRead.status === 'ready' ? comparisonRead.value : null
  const compareSummary = comparison ? {
    facts: comparison.differences.facts.length,
    states: comparison.differences.states.length,
    events: comparison.differences.events.leftOnly.length + comparison.differences.events.rightOnly.length,
  } : null

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
        const bootstrap = guest
          ? await guestMapApi.bootstrap(worldId, timelineId ?? undefined, request.controller.signal)
          : await mapApi.bootstrap(worldId, timelineId ?? undefined, request.controller.signal)
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
      if (active) setWorldChoices(result.worlds.map(world => ({ id: world.id, name: world.name, hasScene: world.hasScene })))
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

  const readRightScene = useCallback(async (targetId: string) => {
    const requestId = ++rightSnapshotRequestId.current
    setRightSceneRead({ status: 'loading' })
    try {
      const result = await worldsApi.snapshot(worldId, targetId)
      if (requestId !== rightSnapshotRequestId.current || result.currentTimelineId !== targetId) return
      setRightSceneRead({ status: 'ready', value: result })
    } catch (error) {
      if (requestId === rightSnapshotRequestId.current) setRightSceneRead({ status: 'error', message: '另一种发展暂时无法读取。请重试，或关闭分屏。' })
    }
  }, [worldId])

  const readComparison = useCallback(async (currentId: string, targetId: string) => {
    const requestId = ++comparisonRequestId.current
    setComparisonRead({ status: 'loading' })
    try {
      const result = await lifeApi.compare(worldId, currentId, targetId)
      if (requestId !== comparisonRequestId.current) return
      setComparisonRead({ status: 'ready', value: result })
    } catch {
      if (requestId === comparisonRequestId.current) setComparisonRead({ status: 'error', message: '时间线对照暂时无法读取。请重试。' })
    }
  }, [worldId])

  useEffect(() => {
    const currentId = snapshot?.currentTimelineId
    const target = snapshot?.timelines.find(item => item.id === rightTimelineId && item.id !== currentId)
      ?? snapshot?.timelines.find(item => item.id !== currentId)
    if (mode !== 'possibility' || !currentId || !target) {
      ++rightSnapshotRequestId.current; ++comparisonRequestId.current
      setRightSceneRead({ status: 'closed' }); setComparisonRead({ status: 'closed' })
      if (mode !== 'possibility') { setScrubAt(null); setSplitWalk({ left: false, right: false }) }
      return
    }
    if (target.id !== rightTimelineId) setRightTimelineId(target.id) // 缺省回退:第一条其他线
    void readRightScene(target.id)
    void readComparison(currentId, target.id)
    return () => { ++rightSnapshotRequestId.current; ++comparisonRequestId.current }
  }, [mode, snapshot?.currentTimelineId, snapshot?.timelines, rightTimelineId, readRightScene, readComparison])

  const retryRightScene = () => {
    const currentId = snapshot?.currentTimelineId
    const targetId = rightTimelineId ?? snapshot?.timelines.find(item => item.id !== currentId)?.id
    if (currentId && targetId) void readRightScene(targetId)
  }
  const retryComparison = () => {
    const currentId = snapshot?.currentTimelineId
    const targetId = rightTimelineId ?? snapshot?.timelines.find(item => item.id !== currentId)?.id
    if (currentId && targetId) void readComparison(currentId, targetId)
  }

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
        setRightSceneRead(current => current.status === 'ready' && current.value.currentTimelineId === rightId && current.value.stateVersion < next.stateVersion
          ? { status: 'ready', value: next } : current)
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
      const presentationComparison = params.has('rightWorld') || params.has('rightPresentation') || params.get('presentation') === 'native2d'
      if (params.has('right') && !presentationComparison) { params.delete('right'); changed = true }
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
  // S3/F1:单空间 owner 路径选中派生(镜像 GuestWorldMap,不含导览)
  const mapVoxelObject = mapSelected ? voxelDoc?.objects.find(object => object.id === mapSelected) ?? null : null
  const mapLocationName = mapVoxelObject?.binding?.kind === 'location'
    ? mapVoxelObject.binding.locationName
    : voxelDoc?.locations.find(item => item.objectId === mapSelected)?.name ?? null
  const mapBoundPersonId = mapVoxelObject?.binding?.kind === 'person' ? mapVoxelObject.binding.personId : mapPersonId
  const mapPerson = mapBoundPersonId
    ? snapshot?.locationBoard.flatMap(row => row.persons.map(item => ({ ...item, location: row.location }))).find(item => item.id === mapBoundPersonId) ?? null
    : null
  const mapLocation = mapLocationName ? snapshot?.world.locations.find(item => item.name === mapLocationName) ?? null : null
  const mapPeople = mapLocationName ? snapshot?.locationBoard.find(row => row.location === mapLocationName)?.persons ?? [] : []
  // S1 分屏:轴模型(纯函数) + 拖档截断;拖档只过滤事件流,视口始终渲染当前状态
  const splitActive = mode === 'possibility' && (voxelDoc !== null || voxelSpaces !== null)
  const splitVoxelDoc = useMemo(() => {
    if (voxelDoc) return voxelDoc
    const space = voxelSpaces?.spaces.find(item => item.id === resumeSpaceId) ?? voxelSpaces?.spaces.find(item => item.id === voxelSpaces.defaultSpaceId)
    if (!space) return null
    try { return deserialize(JSON.stringify(space.document)) } catch { return null }
  }, [voxelDoc, voxelSpaces, resumeSpaceId])
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
  const selectTimeline = useCallback(async (next: string | null): Promise<boolean> => {
    if (timelineSwitching.current) return false
    timelineSwitching.current = true
    setActionError('')
    try {
      const bootstrap = await mapApi.bootstrap(worldId, next ?? undefined)
      if (next && bootstrap.world.currentTimelineId !== next) throw new Error('时间线暂时不可用，请重试。')
      setSnapshot(bootstrap.world)
      const params = new URLSearchParams(search)
      if (next) params.set('timeline', next); else params.delete('timeline')
      setSearch(params, { replace: true })
      setActionError('已切换时间线；当前时间和居民数量可能随各自记录的状态变化。')
      return true
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '时间线切换失败；原选择已保留，可重试。')
      return false
    } finally { timelineSwitching.current = false }
  }, [worldId, search, setSearch])

  const refreshSnapshot = useCallback(async () => {
    const snap = await worldsApi.snapshot(worldId, timelineId ?? undefined).catch(() => null)
    if (snap) setSnapshot(current => current?.currentTimelineId === snap.currentTimelineId && current.stateVersion > snap.stateVersion ? current : snap)
  }, [worldId, timelineId])

  const refreshForkResult = async (result: ForkResult): Promise<boolean> => {
    try {
      const bootstrap = await mapApi.bootstrap(worldId, result.id)
      if (bootstrap.world.currentTimelineId !== result.id ||
        ![result.sourceTimelineId, result.id].every(id => bootstrap.world.timelines.some(t => t.id === id))) {
        throw new Error('新分支列表暂未更新，请重试刷新。')
      }
      setSnapshot(bootstrap.world)
      const params = new URLSearchParams(search)
      params.set('timeline', result.id)
      setSearch(params, { replace: true })
      setForkRefreshError('')
      return true
    } catch {
      setForkRefreshError('分支已创建；时间线列表刷新失败，请重试刷新后比较。')
      return false
    }
  }

  const handleFork = async (scenario: ForkScenarioInput, f1?: { expectedSourceVersion: number; initialAction: ForkInitialAction }): Promise<boolean> => {
    const sourceTimelineId = activeTimelineId
    if (!sourceTimelineId || forking.current) return false
    forking.current = true
    setActionError('')
    try {
      const inputKey = JSON.stringify({ scenario, f1 })
      if (inputKey !== forkInputRef.current) { forkRequestIdRef.current = null; forkInputRef.current = inputKey }
      const requestId = forkRequestIdRef.current ?? crypto.randomUUID()
      forkRequestIdRef.current = requestId
      const fork = await worldsApi.fork(worldId, sourceTimelineId, requestId, scenario, f1)
      forkRequestIdRef.current = null
      setForkHint({ ...fork, sourceId: fork.sourceTimelineId, newId: fork.id })
      await refreshForkResult(fork)
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : '分支创建失败；输入已保留，可重试。'
      setActionError(message)
      throw new Error(message)
    } finally { forking.current = false }
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
  function closeSceneHistory() {
    sceneHistoryRequestId.current += 1
    sceneHistoryLoading.current = false
    restoreRequestId.current += 1
    setSceneHistoryState({ status: 'closed' })
    setRestoreError('')
    setRestoringRevision(false)
  }
  async function loadRevisionList() {
    if (sceneHistoryLoading.current || sceneHistoryState.status === 'loading') return
    const requestId = ++sceneHistoryRequestId.current
    sceneHistoryLoading.current = true
    setRestoreError('')
    setSceneHistoryState({ status: 'loading' })
    try {
      const [current, history] = await Promise.all([worldSceneApi.get(worldId), worldSceneApi.history(worldId)])
      if (requestId !== sceneHistoryRequestId.current) return
      const currentVersion = current.status === 'ready' ? current.version : 0
      setRevisionCurrent(currentVersion)
      setSceneHistoryState({ status: 'ready', currentVersion, revisions: history.revisions })
    } catch {
      if (requestId === sceneHistoryRequestId.current) setSceneHistoryState({ status: 'error', message: '场景历史暂时无法读取，请重试。' })
    } finally {
      if (requestId === sceneHistoryRequestId.current) sceneHistoryLoading.current = false
    }
  }
  // A1:打开兼容检查旅程(修复当前/恢复历史)。会话内已发布失败/未知状态,面板据此展示,此处不再重复报错。
  async function openCompatibility(purpose: CompatibilityPurpose, target: SceneTarget) {
    closeSceneHistory()
    const session = compatSessionRef.current
    if (!session) return
    try {
      const current = await worldSceneApi.get(worldId)
      const expectedCurrentVersion = current.status === 'ready' ? current.version : 0
      await session.check({ purpose, target, expectedCurrentVersion })
    } catch {
      // 会话已将检查失败/未知状态写入 continuation;提交结果未知时身份保留,可经面板恢复。
    }
  }
  function closeCompatibility() {
    const session = compatSessionRef.current
    if (!session) { setCompatContinuation(null); return }
    const state = session.snapshot().state
    // A8.2:提交中/结果未知不 reset——恢复身份(requestId/draftId/attempt)必须保留,仅收起面板。
    if (state === 'submitting' || state === 'unknown') setCompatContinuation(null)
    else session.reset()
  }
  async function restoreVersion(version: number) {
    if (sceneHistoryState.status !== 'ready' || restoringRevision) return
    const requestId = ++restoreRequestId.current
    setRestoringRevision(true)
    setRestoreError('')
    try {
      // A1:恢复前先检查目标历史版本——有效走原快速通道,无效进入完整 A1 修复旅程。
      const inspection = await sceneCompatibilityApi.inspection(worldId, { version })
      if (requestId !== restoreRequestId.current) return
      if (inspection.report.status === 'valid' && !inspection.canCreateRepairDraft) {
        await worldSceneApi.restore(worldId, sceneHistoryState.currentVersion, version)
        closeSceneHistory()
        voxelVersionRef.current = null
        void read()
      } else if (inspection.report.status === 'invalid' && inspection.canCreateRepairDraft) {
        void openCompatibility('restore-history', { kind: 'history', version })
      } else {
        setRestoreError('所选版本检查未完成，暂时不能恢复，请稍后重试。')
      }
    } catch (e) {
      if (requestId === restoreRequestId.current) {
        if (e instanceof ApiError && e.status === 422 && e.errorCode === 'compatibility-required') {
          void openCompatibility('restore-history', { kind: 'history', version })
        } else if (e instanceof ApiError && e.status === 422 && e.errorCode === 'validation-incomplete') {
          setRestoreError('所选版本检查未完成，暂时不能恢复，请稍后重试。')
        } else {
          setRestoreError('无法恢复到所选版本，请重试。')
        }
      }
      if (e instanceof ApiError && e.status === 409) void read()
    } finally { if (requestId === restoreRequestId.current) setRestoringRevision(false) }
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
      else if (e instanceof ApiError && e.status === 422 && e.errorCode === 'compatibility-required') void openCompatibility('repair-current', { kind: 'current' })
      else if (e instanceof ApiError && e.status === 422) setError(`体素场景未通过校验：${e.issues?.[0]?.message ?? e.message}`)
      else setError(e instanceof Error ? e.message : '体素保存失败')
    }
  }, [worldId, read])

  // A1(W20):编辑候选统一走服务端完整预检;回调身份须稳定(VoxelViewport 以 preflightEdits 为装配依赖)。
  const preflightSceneCandidate = useCallback((candidate: SceneCandidate) => sceneCompatibilityApi.preflight(worldId, candidate), [worldId])
  // A1(W31):手动编辑被既存问题(origin=existing)阻断时,直接打开修复旅程;本次编辑问题只留在编辑器反馈里。
  const handleEditBlocked = useCallback((blocked: import('../voxel/bridge/edit-controller').PreflightBlocked) => {
    if (blocked.kind !== 'invalid' || !blocked.report) return
    const issues = Array.isArray(blocked.report.issues) ? blocked.report.issues : []
    if (issues.some(issue => issue.origin === 'existing')) void openCompatibility('repair-current', { kind: 'current' })
  }, [worldId])
  // A1(W21):AI 规划命中服务端模型前闸门(422 compatibility-required)时,直接打开修复旅程,原输入保留在面板里。
  const planSceneEdits = useCallback((engine: VoxelEngine, intent: string) =>
    planEditsViaApi(engine, worldId, intent).catch(error => {
      if (error instanceof EditPlanRequestError && error.errorCode === 'compatibility-required') {
        void openCompatibility('repair-current', { kind: 'current' })
      }
      throw error
    }), [worldId])

  if (error && !snapshot && comparisonWorkspaceActive) return (
    <div className="min-h-full bg-sage-50 p-4">
      <ComparisonHost
        left={presentationRoute.left}
        right={presentationRoute.right}
        loadSession={presentationRuntime.loadSession}
        adapters={presentationRuntime.adapters}
        store={presentationStore}
        worlds={presentationWorlds}
        onTargetChange={updatePresentationTarget}
        onExit={exitPresentationWorkspace}
      />
    </div>
  )
  if (error && !snapshot) return (
    <div className="flex min-h-full items-center bg-sage-50 p-4">
      <div className="m-auto w-full max-w-md rounded-2xl border border-ink-faint bg-sheet p-6 text-center shadow-sm" data-testid="world-canvas-error">
        <p className="text-sm text-red-700">{error}</p>
        <button onClick={() => void read()} className="mt-4 rounded-full border border-ink-line/80 bg-sheet px-4 py-2 text-sm text-ink-soft hover:bg-paper-deep transition">重试</button>
      </div>
    </div>
  )
  if (!snapshot) return <div className="grid min-h-full place-items-center text-sm text-ink-faint">正在准备这方天地…</div>

  // A1 兼容面板:单空间/多空间(GuestWorldMap)共用同一会话与同一面板,只读预览按草稿惰性加载。
  const currentCompatContinuation = compatReadyScope?.worldId === worldId && compatReadyScope.authIdentityEpoch === authIdentityEpoch
    ? compatContinuation : null
  const compatDraft = currentCompatContinuation?.draft ?? null
  const compatSourceVersion = currentCompatContinuation?.source?.version ?? null
  const compatPreview = currentCompatContinuation?.state === 'preview' && compatDraft && compatSourceVersion !== null
    ? <SceneRepairPreview
        key={compatDraft.id}
        spaces={compatDraft.previewSpaces}
        loadSourceSpace={(sid, signal) => sceneCompatibilityApi.readSourceSpace(worldId, compatSourceVersion, sid, signal).then(res => res.document)}
        loadCandidateSpace={(sid, signal) => sceneCompatibilityApi.readDraftSpace(worldId, compatDraft.id, sid, signal).then(res => res.document)}
        changes={compatDraft.changes.items}
        ruleNotes={compatDraft.report?.ruleNotes.items ?? []}
        timeZone={snapshot.world.timeZone}
      />
    : undefined
  const compatPanel = currentCompatContinuation && currentCompatContinuation.state !== 'idle'
    ? <SceneCompatibilityPanel
        continuation={currentCompatContinuation}
        canEdit={canEditScene && !readonly}
        preview={compatPreview}
        onBuild={() => void compatSessionRef.current?.build().catch(() => undefined)}
        onConfirm={() => void compatSessionRef.current?.submit().catch(() => undefined)}
        onRecheck={() => {
          const { purpose, target } = currentCompatContinuation
          if (purpose && target) void openCompatibility(purpose, target)
        }}
        onQueryResult={() => void compatSessionRef.current?.queryResult().catch(() => undefined)}
        onClose={closeCompatibility}
      />
    : null
  const worldStatus = snapshot.world.status
  const running = worldStatus === 'running'
  const capped = worldStatus === 'capped'
  const archived = worldStatus === 'archived'
  const evidenceReadonly = snapshot.evidence.level !== 'complete'
  const canInteract = !readonly && !guest && !evidenceReadonly

  const modals = (
    <WorldModalsContainer
      worldId={worldId}
      snapshot={snapshot}
      activeTimelineId={activeTimelineId}
      personNames={personNames}
      canInteract={canInteract}
      guest={guest}
      sceneHistoryState={sceneHistoryState}
      restoringRevision={restoringRevision}
      restoreError={restoreError}
      onRestoreRevision={version => restoreVersion(version)}
      onRetryRevisionList={() => loadRevisionList()}
      onCloseSceneHistory={closeSceneHistory}
      compatPanel={compatPanel}
      llmConfigOpen={llmConfigOpen}
      forkHint={forkHint ?? (search.get('forkFrom') ? ({ sourceId: search.get('forkFrom')!, newId: activeTimelineId } as any) : null)}
      forkRefreshError={forkRefreshError}
      onRefreshForkResult={forkHint ? (fork) => refreshForkResult(fork) : undefined}
      onDismissForkHint={() => {
        setForkHint(null)
        if (search.get('forkFrom')) {
          const params = new URLSearchParams(search)
          params.delete('forkFrom')
          setSearch(params, { replace: true })
        }
      }}
      injectOpen={injectOpen}
      onInject={handleInject}
      lifeOpen={lifeOpen}
      onCloseLife={() => setLifeOpen(false)}
      onForkAtMoment={(simTime, premise) => {
        setLifeOpen(false)
        setForkPrefill({ key: crypto.randomUUID(), whatIf: premise, simTime })
      }}
      compareOpen={compareOpen}
      compareInitial={compareInitial}
      onOpenCompareFromHint={forkHint && !forkRefreshError ? () => {
        setCompareInitial({ left: forkHint.sourceId, right: forkHint.newId })
        setCompareOpen(true)
      } : undefined}
      onCloseCompare={() => setCompareOpen(false)}
      presenceOpen={presenceOpen}
      presenceLocation={presenceLocation}
      onClosePresence={() => {
        setPresenceOpen(false)
        setPresenceLocation(null)
      }}
    />
  )

  if (voxelSpaces) return <>
    {!comparisonWorkspaceActive && <div className="fixed left-3 top-3 z-[60] rounded-full bg-sheet/90 p-1 shadow-md sm:left-5 sm:top-5">
      <PresentationSwitcher paneId="single" value={presentationRoute.left.presentation} onChange={selectSinglePresentation} />
    </div>}
    <GuestWorldMap
      voxelSpaces={voxelSpaces}
      snapshot={snapshot}
      overlay={overlay}
      initialSpaceId={resumeSpaceId}
      initialMode={mode === 'possibility' ? 'possibility' : resumeMode}
      splitActive={comparisonWorkspaceActive || splitActive}
      onCloseSplit={() => closeSplit('right')}
      splitStage={comparisonWorkspaceActive ? <ComparisonHost
        left={presentationRoute.left}
        right={presentationRoute.right}
        loadSession={presentationRuntime.loadSession}
        adapters={presentationRuntime.adapters}
        store={presentationStore}
        worlds={presentationWorlds}
        onTargetChange={updatePresentationTarget}
        onExit={exitPresentationWorkspace}
      /> : snapshot && splitVoxelDoc ? <SplitViewStage
        isSmall={isSmall}
        snapshot={snapshot}
        otherSnapshot={otherSnapshot}
        voxelDoc={splitVoxelDoc}
        overlay={overlay}
        otherOverlay={otherOverlay}
        personNames={personNames}
        sharedPose={sharedPose}
        setSharedPose={setSharedPose}
        linkActive={linkActive}
        cameraLinked={cameraLinked}
        setCameraLinked={setCameraLinked}
        splitWalk={splitWalk}
        setSplitWalk={setSplitWalk}
        rightTimelineId={rightTimelineId}
        setRightTimelineId={setRightTimelineId}
        rightSceneRead={rightSceneRead}
        retryRightScene={retryRightScene}
        swapSplit={swapSplit}
        closeSplit={closeSplit}
        scrubAt={scrubAt}
        setScrubAt={setScrubAt}
        axis={axis}
        handleSelectMarker={handleSelectMarker}
        compareSummary={compareSummary}
        comparisonRead={comparisonRead}
        retryComparison={retryComparison}
        alignedComparison={alignedComparison}
        comparison={comparison}
        smallSide={smallSide}
        setSmallSide={setSmallSide}
        selectedSplitEvent={selectedSplitEvent}
        splitEventEls={splitEventEls}
        splitEvents={splitEvents}
      /> : null}
      guest={guest}
      claimPending={claimPending}
      editable={canEditScene}
      planEdits={canEditScene ? planSceneEdits : undefined}
      preflightEdits={canEditScene ? preflightSceneCandidate : undefined}
      onCompatibilityRequired={() => void openCompatibility('repair-current', { kind: 'current' })}
      onOpenHistory={guest ? undefined : () => { if (sceneHistoryState.status === 'closed') void loadRevisionList() }}
      onOpenCompatibility={guest ? undefined : () => void openCompatibility('repair-current', { kind: 'current' })}
      onInject={canInteract ? () => setInjectOpen(v => !v) : undefined}
      onPresence={canInteract ? () => setPresenceOpen(true) : undefined}
      onLife={() => setLifeOpen(true)}
      onPauseResume={(running || !evidenceReadonly) ? () => void handlePauseResume() : undefined}
      onArchive={!guest ? () => void handleArchiveWorld() : undefined}
      onLlmConfig={!guest ? () => setLlmConfigOpen(v => !v) : undefined}
      onCompare={snapshot.timelines.length > 1 ? () => { setCompareInitial(null); setCompareOpen(true) } : undefined}
      running={running}
      canInteract={canInteract}
    />
    {modals}
  </>
  if (!voxelDoc) {
    const personId = snapshot.locationBoard.flatMap(row => row.persons.map(person => person.id))[0]
    const rebuildHref = personId
      ? `/worlds/${encodeURIComponent(worldId)}/scene/repair`
      : null
    return (
      <div className="grid min-h-[calc(100vh-7rem)] bg-sage-50 p-4">
        <div className="m-auto w-full max-w-md rounded-2xl border border-ink-faint bg-sheet p-6 text-center shadow-sm" data-testid="world-canvas-missing">
          <p className="text-sm text-ink-soft">{sceneMissing ? '场景暂时不可用，请重试。' : '待创建场景'}</p>
          {!sceneMissing && <p className="mt-2 text-sm text-ink-faint">为这个世界创建场景后，即可继续进入。</p>}
          {rebuildHref && !sceneMissing && !readonly && !guest
            ? <Link to={rebuildHref} className="mt-4 inline-flex rounded-lg bg-sage-700 hover:bg-sage-800 px-4 py-2 text-sm text-white transition">补建场景</Link>
            : !sceneMissing && <p className="mt-3 text-xs text-ink-faint">当前没有可用于补建场景的居民，或此世界为只读。</p>}
          <button onClick={() => void read()} className="mt-4 rounded-full border border-ink-line/80 bg-sheet px-4 py-2 text-sm text-ink-soft hover:bg-paper-deep transition">重试</button>
        </div>
      </div>
    )
  }

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

  if (readonly) return <main className="relative h-screen overflow-hidden bg-sage-100" data-testid="world-canvas-page">
    {comparisonWorkspaceActive ? <ComparisonHost
      left={presentationRoute.left}
      right={presentationRoute.right}
      loadSession={presentationRuntime.loadSession}
      adapters={presentationRuntime.adapters}
      store={presentationStore}
      worlds={presentationWorlds}
      onTargetChange={updatePresentationTarget}
      onExit={exitPresentationWorkspace}
    /> : <VoxelViewport document={voxelDoc} overlay={overlay} events={snapshot.voxelEvents ?? null} personNames={personNames} timeZone={snapshot.world.timeZone} cameraPose={legacyVoxelPose} onCameraChange={saveLegacyCameraPose} />}
    <div className="pointer-events-none absolute inset-0 z-stage">
      <header className="pointer-events-auto absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-sage-900/65 to-transparent px-5 pb-8 pt-4 text-white sm:px-7">
        <div><p className="font-story text-xl font-semibold tracking-tight sm:text-2xl">Possibility</p><p className="text-[10px] tracking-[.24em] text-white/70">{snapshot.world.name} · 正在生活</p></div>
        {!comparisonWorkspaceActive && <PresentationSwitcher paneId="single" value={presentationRoute.left.presentation} onChange={selectSinglePresentation} />}
        <a href="/login" className="rounded-full border border-white/35 bg-sheet-dark px-4 py-2 text-xs backdrop-blur-md transition hover:bg-sage-900/70 sm:text-sm">登录，创建你的世界</a>
      </header>
      <div className="absolute bottom-4 left-3 rounded-full border border-white bg-sheet px-3 py-2 text-[10px] text-sage-800 shadow-sm sm:left-5">拖动浏览 · 滚轮缩放 · 点击建筑或人物</div>
      <div className="absolute bottom-4 right-3 rounded-full border border-white bg-sheet px-3 py-2 text-[10px] text-sage-600 shadow-sm sm:right-5">{guest ? '访客副本 · 可安全体验' : '只读世界'} · {snapshot.locationBoard.reduce((total, row) => total + row.persons.length, 0)} 位居民</div>
    </div>
  </main>

  return <main className="flex h-screen min-h-0 flex-col gap-3 overflow-hidden bg-sage-50 p-3 sm:p-5" data-testid="world-canvas-page">
    {modals}
    <WorldHeader
      worldId={worldId}
      world={snapshot.world}
      timelines={snapshot.timelines}
      mode={mode}
      worldChoices={worldChoices}
      activeTimelineId={activeTimelineId}
      evidenceReadonly={evidenceReadonly}
      running={running}
      canInteract={canInteract}
      canEditScene={canEditScene}
      voxelSpaces={Boolean(voxelSpaces)}
      guest={guest}
      regeneratingDemo={regeneratingDemo}
      historyRange={historyRange?.tid === activeTimelineId ? historyRange.range : undefined}
      forkPrefill={forkPrefill}
      sceneHistoryOpen={sceneHistoryState.status !== 'closed'}
      onSwitchTimeline={selectTimeline}
      onForkTimeline={handleFork}
      onPreviewFork={handleForkPreview}
      onArchiveTimeline={(tid) => void handleArchiveTimeline(tid)}
      onSplitView={() => setMode('possibility')}
      onForkOpen={handleForkOpen}
      onCheckMoment={handleCheckMoment}
      onRegenerateDemo={() => void regenerateDemo()}
      onToggleInject={() => setInjectOpen(v => !v)}
      onOpenPresence={() => setPresenceOpen(true)}
      onOpenLife={() => setLifeOpen(true)}
      onOpenCompare={() => { setCompareInitial(null); setCompareOpen(true) }}
      onToggleLlmConfig={() => setLlmConfigOpen(v => !v)}
      onPauseResume={() => void handlePauseResume()}
      onOpenHistory={() => { if (sceneHistoryState.status === 'closed') void loadRevisionList() }}
      onOpenCompatibility={() => void openCompatibility('repair-current', { kind: 'current' })}
      onArchiveWorld={() => void handleArchiveWorld()}
    />
    {canInteract && !snapshot.world.isDemo && <WorldTimeZoneSetting worldId={worldId} timeZone={snapshot.world.timeZone} onSaved={zone => {
      setSnapshot(current => current ? { ...current, world: { ...current.world, timeZone: zone }, timelines: current.timelines.map(t => ({ ...t, timeZone: zone })) } : current)
      setRightSceneRead(current => current.status === 'ready' ? { status: 'ready', value: { ...current.value, world: { ...current.value.world, timeZone: zone }, timelines: current.value.timelines.map(t => ({ ...t, timeZone: zone })) } } : current)
    }} />}
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className={`rounded-full px-2 py-0.5 ${running ? 'bg-emerald-100 text-emerald-700' : capped ? 'bg-red-100 text-red-700' : archived ? 'bg-paper-deep text-ink-faint' : 'bg-paper-deep text-ink-soft'}`} data-testid="world-status">
        {running ? '运行中' : capped ? '已达今日上限' : archived ? '已归档（冻结可读）' : '已暂停'}
      </span>
      <span className="text-ink-faint">世界时间 {formatWorldTime(snapshot.simNow, snapshot.world.timeZone)} · 今日调用 {snapshot.world.callsToday}</span>
    </div>
    {capped && snapshot.world.pauseReason === 'global_daily_cap' && <GlobalCapBanner />}
    {capped && snapshot.world.pauseReason !== 'global_daily_cap' && (
      <p className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-600">今日调用已达上限，世界已自动暂停，次日自动恢复运行。</p>
    )}
    <EvidenceNotice evidence={snapshot.evidence} />
    {error && <p role="status" className="rounded-xl bg-sheet px-4 py-2 text-sm text-red-700 border border-red-200">{error}</p>}
    {actionError && <p role="status" className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-600">{actionError}</p>}
    {regenerateError && <p role="status" className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-600">{regenerateError}</p>}
    {!comparisonWorkspaceActive && <div className="self-start rounded-full bg-sheet/90 p-1 shadow-sm">
      <PresentationSwitcher paneId="single" value={presentationRoute.left.presentation} onChange={selectSinglePresentation} />
    </div>}
    <div className="flex min-h-0 flex-1 gap-3"><div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-3" data-testid="owner-map-stage">
      {comparisonWorkspaceActive ? <ComparisonHost
        left={presentationRoute.left}
        right={presentationRoute.right}
        loadSession={presentationRuntime.loadSession}
        adapters={presentationRuntime.adapters}
        store={presentationStore}
      worlds={presentationWorlds}
      onTargetChange={updatePresentationTarget}
        onExit={exitPresentationWorkspace}
      /> : mode === 'possibility' ? (
        <SplitViewStage
          isSmall={isSmall}
          snapshot={snapshot}
          otherSnapshot={otherSnapshot}
          voxelDoc={voxelDoc}
          overlay={overlay}
          otherOverlay={otherOverlay}
          personNames={personNames}
          sharedPose={sharedPose}
          setSharedPose={setSharedPose}
          linkActive={linkActive}
          cameraLinked={cameraLinked}
          setCameraLinked={setCameraLinked}
          splitWalk={splitWalk}
          setSplitWalk={setSplitWalk}
          rightTimelineId={rightTimelineId}
          setRightTimelineId={setRightTimelineId}
          rightSceneRead={rightSceneRead}
          retryRightScene={retryRightScene}
          swapSplit={swapSplit}
          closeSplit={closeSplit}
          scrubAt={scrubAt}
          setScrubAt={setScrubAt}
          axis={axis}
          handleSelectMarker={handleSelectMarker}
          compareSummary={compareSummary}
          comparisonRead={comparisonRead}
          retryComparison={retryComparison}
          alignedComparison={alignedComparison}
          comparison={comparison}
          smallSide={smallSide}
          setSmallSide={setSmallSide}
          selectedSplitEvent={selectedSplitEvent}
          splitEventEls={splitEventEls}
          splitEvents={splitEvents}
        />
      ) : <div className="flex min-h-0 flex-1 flex-col [&>div]:min-h-0"><VoxelViewport document={voxelDoc} overlay={overlay} events={snapshot.voxelEvents ?? null} personNames={personNames} timeZone={snapshot.world.timeZone} cameraPose={legacyVoxelPose} onCameraChange={saveLegacyCameraPose} editable={canEditScene} planEdits={canEditScene ? planSceneEdits : undefined} preflightEdits={canEditScene ? preflightSceneCandidate : undefined} onEditBlocked={handleEditBlocked} onSave={saveVoxel}
          onSelectLocation={(_name, objectId) => { setMapSelected(objectId); setMapPersonId(null) }}
          onSelectPerson={(personId) => { setMapPersonId(personId); setMapSelected(null) }} /></div>}
      {mode !== 'possibility' && (mapVoxelObject || mapLocationName || mapPerson) && <MapSelectionCard
        person={mapPerson}
        locationName={mapLocationName}
        locationDescription={mapLocation?.description ?? null}
        peopleHere={mapPeople}
        fallbackLabel={mapVoxelObject?.label ?? null}
        onClose={() => { setMapSelected(null); setMapPersonId(null) }}
        onEnter={(name) => { setPresenceLocation(name); setPresenceOpen(true) }}
      />}
      {mode === 'life' && <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-sheet/85 px-4 py-3 text-sm text-ink-soft border border-ink-line/50"><span>{overlay?.timeOfDay === 'night' ? '夜色渐深，街灯亮起。' : overlay?.weather ? `此刻天气：${overlay.weather}` : '居民正按照自己的处境继续生活。'}</span><span className="text-xs text-ink-faint">{formatWorldTime(snapshot.simNow, snapshot.world.timeZone)}</span></div>}
    </div></div>
  </main>
}
