import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { publicApi, subscribeWorldStream, worldsApi, personaApi } from '../api/client'
import type {
  DialogueDetail,
  PersonFocus,
  ForkScenario,
  WorldEventItem,
  WorldSnapshot,
  WorldStreamEvent,
} from '../api/types'
import LocationPanel from '../components/world/LocationPanel'
import WorldEventFeed from '../components/world/WorldEventFeed'
import PersonDrawer from '../components/world/PersonDrawer'
import TimelineSwitcher from '../components/world/TimelineSwitcher'
import ChapterPanel from '../components/world/ChapterPanel'
import ScenePanel from '../components/world/ScenePanel'
import LifePanel from '../components/world/LifePanel'
import ComparePanel from '../components/world/ComparePanel'
import WorldStatePanel from '../components/world/WorldStatePanel'
import ConstructPanel from '../components/world/ConstructPanel'
import { withTimelineParam } from '../lib/timelineUrl'
import { isTimelineUpdateCurrent } from '../lib/timelineGuard'

const WORLD_SPEED = 6

export interface WorldViewProps {
  worldId: string
  readonly?: boolean
}

interface PersonLiveState {
  simTime: string
  location: string
  activity: string
  mood: string
  goal: string
  currentDialogueId: string | null
}

interface WorldClock {
  timelineId: string
  simNow: string
  callsToday: number
  worldStatus: string
  pauseReason: string | null
  stateVersion: number
}

function clockFromSnapshot(snap: WorldSnapshot): WorldClock {
  return { timelineId: snap.currentTimelineId, simNow: snap.simNow, callsToday: snap.world.callsToday,
    worldStatus: snap.world.status, pauseReason: snap.world.pauseReason, stateVersion: snap.stateVersion }
}

function fmtSimTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

export default function WorldView({ worldId, readonly = false }: WorldViewProps) {
  const api = readonly ? publicApi : worldsApi
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const timelineId = searchParams.get('timeline')
  const activeTimelineRef = useRef<string | null>(timelineId)
  activeTimelineRef.current = timelineId
  const selectTimeline = useCallback((next: string | null) => {
    activeTimelineRef.current = next
    setSearchParams(current => withTimelineParam(current, next), { replace: true })
  }, [setSearchParams])
  const [error, setError] = useState('')
  const [events, setEvents] = useState<WorldEventItem[]>([])
  const [liveStates, setLiveStates] = useState<Record<string, PersonLiveState>>({})
  const [turnsByDialogue, setTurnsByDialogue] = useState<Record<string, { turnIndex: number; personId: string; utterance: string; thought: string; simTime: string }[]>>({})
  const [clock, setClock] = useState<WorldClock | null>(null)
  const [displayNow, setDisplayNow] = useState<string>('')
  const clockBaseRef = useRef<{ simNow: number; realAt: number } | null>(null)
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null)
  const [personFocus, setPersonFocus] = useState<PersonFocus | null>(null)
  const [focusLoading, setFocusLoading] = useState(false)
  const [focusRefresh, setFocusRefresh] = useState(0)
  const [expandedDialogue, setExpandedDialogue] = useState<{ id: string; timelineId: string; detail: DialogueDetail | null } | null>(null)
  const [actionError, setActionError] = useState('')
  const [chaptersOpen, setChaptersOpen] = useState(false)
  const [sceneOpen, setSceneOpen] = useState(false)
  const [personaUnread, setPersonaUnread] = useState(0)
  const [lifeOpen, setLifeOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [mode, setMode] = useState<'observe' | 'presence' | 'construct'>('observe')
  const [stateRefresh, setStateRefresh] = useState(0)
  const forkRequestIdRef = useRef<string | null>(null)

  useEffect(() => {
    setSelectedPersonId(null)
  }, [worldId])

  useEffect(() => {
    if (mode !== 'presence') setSceneOpen(false)
  }, [mode])

  // 在场身份未读留言角标（打开面板即清零，由面板内送达逻辑标记已读）
  useEffect(() => {
    if (readonly) return
    let active = true
    setPersonaUnread(0)
    personaApi
      .get(worldId, timelineId ?? undefined)
      .then((d) => { if (active) setPersonaUnread(d.unread) })
      .catch(() => {})
    return () => { active = false }
  }, [worldId, timelineId, sceneOpen, readonly])

  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const loc of snapshot?.locationBoard ?? []) for (const p of loc.persons) m.set(p.id, p.name)
    return m
  }, [snapshot])

  // 装载快照（世界或时间线切换时重置一切本地增量状态）
  useEffect(() => {
    let active = true
    setSnapshot(null)
    setEvents([])
    setTurnsByDialogue({})
    setLiveStates({})
    setClock(null)
    setDisplayNow('')
    clockBaseRef.current = null
    setPersonFocus(null)
    setFocusLoading(false)
    setExpandedDialogue(null)
    setSceneOpen(false)
    setChaptersOpen(false)
    setLifeOpen(false)
    setCompareOpen(false)
    forkRequestIdRef.current = null
    setActionError('')
    setError('')
    api
      .snapshot(worldId, timelineId ?? undefined)
      .then((snap) => {
        if (!isTimelineUpdateCurrent(active, timelineId, activeTimelineRef.current, snap.currentTimelineId)) return
        setSnapshot(cur => cur?.currentTimelineId === snap.currentTimelineId && cur.stateVersion > snap.stateVersion ? cur : snap)
        setEvents(prev => {
          const byId = new Map([...snap.events, ...prev].map(e => [e.id, e]))
          return [...byId.values()].sort((a, b) => a.simTime.localeCompare(b.simTime) || a.id.localeCompare(b.id))
        })
        setTurnsByDialogue({})
        setLiveStates({})
        setClock(cur => cur?.timelineId === snap.currentTimelineId && cur.stateVersion > snap.stateVersion ? cur : clockFromSnapshot(snap))
        if (!timelineId) selectTimeline(snap.currentTimelineId)
        clockBaseRef.current = { simNow: Date.parse(snap.simNow), realAt: Date.now() }
      })
      .catch((e) => {
        if (isTimelineUpdateCurrent(active, timelineId, activeTimelineRef.current)) {
          setError(e instanceof Error ? e.message : '加载失败')
        }
      })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, worldId, timelineId, selectTimeline])

  // 订阅增量流
  useEffect(() => {
    if (!timelineId) return
    let active = true
    const unsub = subscribeWorldStream(
      worldId,
      timelineId,
      (ev: WorldStreamEvent) => {
        if (!isTimelineUpdateCurrent(active, timelineId, activeTimelineRef.current)) return
        if (ev.type === 'sync') {
          void api.snapshot(worldId, timelineId).then(snap => {
            if (!isTimelineUpdateCurrent(active, timelineId, activeTimelineRef.current, snap.currentTimelineId)) return
            setSnapshot(cur => cur?.currentTimelineId === snap.currentTimelineId && cur.stateVersion > snap.stateVersion ? cur : snap)
            setEvents(prev => {
              const byId = new Map([...snap.events, ...prev].map(e => [e.id, e]))
              return [...byId.values()].sort((a, b) => a.simTime.localeCompare(b.simTime) || a.id.localeCompare(b.id))
            })
            setClock(cur => cur?.timelineId === snap.currentTimelineId && cur.stateVersion > snap.stateVersion ? cur : clockFromSnapshot(snap))
          }).catch(() => {})
        } else if (ev.type === 'event') {
          setEvents((prev) =>
            prev.some((e) => e.id === ev.id)
              ? prev
              : [
                  ...prev,
                  {
                    id: ev.id,
                    simTime: ev.simTime,
                    title: ev.title,
                    description: ev.description,
                    kind: ev.kind,
                    actorPersonId: ev.actorPersonId,
                    actorName: null,
                    dialogueId: ev.dialogueId,
                    dialoguePreview: null,
                  },
                ],
          )
        } else if (ev.type === 'dialogue_turn') {
          setTurnsByDialogue((prev) => {
            const list = prev[ev.dialogueId] ?? []
            if (list.some((t) => t.turnIndex === ev.turnIndex)) return prev
            return {
              ...prev,
              [ev.dialogueId]: [
                ...list,
                { turnIndex: ev.turnIndex, personId: ev.personId, utterance: ev.utterance, thought: ev.thought, simTime: ev.simTime },
              ].sort((a, b) => a.turnIndex - b.turnIndex),
            }
          })
        } else if (ev.type === 'state') {
          setLiveStates((prev) => ({
            ...prev,
            [ev.personId]: {
              simTime: ev.simTime,
              location: ev.location,
              activity: ev.activity,
              mood: ev.mood,
              goal: ev.goal,
              currentDialogueId: ev.currentDialogueId,
            },
          }))
        } else if (ev.type === 'clock') {
          setClock({ timelineId, simNow: ev.simNow, callsToday: ev.callsToday, worldStatus: ev.worldStatus,
            pauseReason: ev.pauseReason, stateVersion: ev.stateVersion })
          clockBaseRef.current = { simNow: Date.parse(ev.simNow), realAt: Date.now() }
        }
      },
      { isPublic: readonly },
    )
    return () => { active = false; unsub() }
  }, [api, worldId, timelineId, readonly])

  useEffect(() => {
    if (!timelineId || !snapshot || !clock || clock.stateVersion <= snapshot.stateVersion) return
    let active = true
    api.snapshot(worldId, timelineId).then(next => {
      if (isTimelineUpdateCurrent(active, timelineId, activeTimelineRef.current, next.currentTimelineId)) {
        setSnapshot(cur => cur?.currentTimelineId === timelineId && cur.stateVersion > next.stateVersion ? cur : next)
      }
    }).catch(() => {})
    return () => { active = false }
  }, [api, worldId, timelineId, clock?.stateVersion, snapshot?.stateVersion])

  // 世界时钟：流更新为基准 + 本地 ×6 插值平滑
  useEffect(() => {
    const timer = setInterval(() => {
      const base = clockBaseRef.current
      if (base && clock?.worldStatus === 'running') {
        const sim = base.simNow + (Date.now() - base.realAt) * WORLD_SPEED
        setDisplayNow(new Date(sim).toISOString())
      } else if (clock) {
        setDisplayNow(clock.simNow)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [clock])

  // 人物详情抽屉
  useEffect(() => {
    if (!selectedPersonId || !timelineId) {
      setPersonFocus(null)
      setFocusLoading(false)
      return
    }
    let active = true
    setPersonFocus(null)
    setFocusLoading(true)
    api
      .personFocus(worldId, selectedPersonId, timelineId)
      .then(focus => { if (active) setPersonFocus(focus) })
      .catch(() => { if (active) setPersonFocus(null) })
      .finally(() => { if (active) setFocusLoading(false) })
    return () => { active = false }
  }, [api, selectedPersonId, timelineId, worldId, focusRefresh])

  // 展开对话
  const toggleDialogue = useCallback(
    (dialogueId: string) => {
      if (!timelineId) return
      setExpandedDialogue((cur) => {
        if (cur?.id === dialogueId && cur.timelineId === timelineId) return null
        return { id: dialogueId, timelineId, detail: null }
      })
      api
        .dialogueDetail(dialogueId, timelineId)
        .then((detail) => setExpandedDialogue((cur) =>
          cur?.id === dialogueId && cur.timelineId === timelineId ? { id: dialogueId, timelineId, detail } : cur))
        .catch(() => setExpandedDialogue((cur) =>
          cur?.id === dialogueId && cur.timelineId === timelineId ? null : cur))
    },
    [api, timelineId],
  )

  const handlePauseResume = async () => {
    if (!snapshot) return
    setActionError('')
    try {
      if (clock?.worldStatus === 'running') await worldsApi.pause(worldId)
      else await worldsApi.resume(worldId)
      // 状态由流 clock 事件同步；立刻拉一次快照兜底（流可能尚未推）
      const snap = await worldsApi.snapshot(worldId, timelineId ?? undefined)
      if (activeTimelineRef.current === snap.currentTimelineId) setClock(clockFromSnapshot(snap))
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '操作失败')
    }
  }

  const handleArchiveWorld = async () => {
    if (!snapshot) return
    setActionError('')
    try {
      await worldsApi.archive(worldId)
      const snap = await worldsApi.snapshot(worldId, timelineId ?? undefined)
      if (activeTimelineRef.current === snap.currentTimelineId) setClock(clockFromSnapshot(snap))
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '归档失败')
    }
  }

  const handleFork = async (scenario: Pick<ForkScenario, 'whatIf' | 'changedVariable'>): Promise<boolean> => {
    if (!timelineId) return false
    const sourceTimelineId = timelineId
    setActionError('')
    try {
      const requestId = forkRequestIdRef.current ?? crypto.randomUUID()
      forkRequestIdRef.current = requestId
      const fork = await worldsApi.fork(worldId, sourceTimelineId, requestId, scenario)
      forkRequestIdRef.current = null
      if (activeTimelineRef.current === sourceTimelineId) selectTimeline(fork.id)
      return true
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Fork 失败')
      return false
    }
  }

  const handleArchive = async (tid: string) => {
    setActionError('')
    try {
      await worldsApi.archiveTimeline(tid)
      if (tid === timelineId) {
        selectTimeline(null) // 触发重新装载（回落到主线）
      } else {
        const snap = await worldsApi.snapshot(worldId, timelineId ?? undefined)
        if (activeTimelineRef.current === snap.currentTimelineId) setSnapshot(snap)
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '归档失败')
    }
  }

  const handleInject = async (text: string, requestId: string) => {
    if (!timelineId) return
    setActionError('')
    try {
      const state = await worldsApi.state(worldId, timelineId)
      await worldsApi.inject(worldId, text, timelineId, requestId, state.version)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '注入失败')
      throw e
    }
  }

  if (error) return <div className="p-8 text-center text-sm text-red-600">{error}</div>
  if (!timelineId || !snapshot || !clock || snapshot.world.id !== worldId
    || snapshot.currentTimelineId !== timelineId || clock.timelineId !== timelineId) {
    return <div className="p-8 text-center text-sm text-ink-faint">加载中…</div>
  }

  const running = clock.worldStatus === 'running'
  const capped = clock.worldStatus === 'capped'
  const archived = clock.worldStatus === 'archived'

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏：世界名 / 时钟 / 状态 / 控制 */}
      <div className="border-b border-ink-line bg-sheet px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-story truncate text-lg font-semibold text-ink">{snapshot.world.name}</h1>
              {snapshot.world.isDemo && (
                <span className="rounded-full bg-cinnabar-soft px-2 py-0.5 text-xs text-cinnabar-deep">演示世界</span>
              )}
              <span
                className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
                  running ? 'bg-emerald-100 text-emerald-700' : capped ? 'bg-red-100 text-red-700' : archived ? 'bg-paper-deep text-ink-faint' : 'bg-paper-deep text-ink-soft'
                }`}
              >
                {running && <span className="inline-block h-1.5 w-1.5 animate-pulse-soft rounded-full bg-emerald-500" />}
                {running ? '运行中' : capped ? '已达今日上限' : archived ? '已归档（冻结可读）' : '已暂停'}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-ink-faint">
              世界时间 <span className="font-story text-ink-soft">{displayNow ? fmtSimTime(displayNow) : fmtSimTime(clock.simNow)}</span> ·
              今日调用 {clock.callsToday}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {!readonly && (
              <>
                <TimelineSwitcher
                  timelines={snapshot.timelines}
                  currentTimelineId={timelineId ?? snapshot.currentTimelineId}
                  onSwitch={selectTimeline}
                  onFork={handleFork}
                  onArchive={handleArchive}
                />
                <button
                  onClick={handlePauseResume}
                  className="rounded-lg border border-ink-faint px-3 py-1.5 text-xs text-ink-soft hover:bg-paper-deep"
                >
                  {running ? '暂停' : '继续'}
                </button>
                <button onClick={() => setLifeOpen(true)} className="rounded-lg border border-ink-faint px-3 py-1.5 text-xs text-ink-soft hover:bg-paper-deep">
                  你不在时
                </button>
                {snapshot.timelines.length > 1 && <button onClick={() => setCompareOpen(true)} className="rounded-lg border border-ink-faint px-3 py-1.5 text-xs text-ink-soft hover:bg-paper-deep">对照宇宙</button>}
                <button
                  onClick={() => setChaptersOpen(true)}
                  className="rounded-lg border border-ink-faint px-3 py-1.5 text-xs text-ink-soft hover:bg-paper-deep"
                >
                  章节
                </button>
                <button
                  onClick={handleArchiveWorld}
                  className="rounded-lg border border-ink-faint px-3 py-1.5 text-xs text-ink-faint hover:bg-paper-deep"
                >
                  归档
                </button>
              </>
            )}
          </div>
        </div>
        {capped && (
          <p className="mt-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-600">
            今日调用已达上限，世界已自动暂停，次日自动恢复运行。
          </p>
        )}
        {actionError && <p className="mt-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-600">{actionError}</p>}
      </div>

      {/* 主体：世界当前态优先；叙事流作为证据 */}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-ink-line bg-paper p-3 md:block">
          <LocationPanel
            locationBoard={snapshot.locationBoard}
            liveStates={liveStates}
            onSelectPerson={(pid) => setSelectedPersonId(pid)}
          />
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-3">
          {!readonly && <nav aria-label="交互模式" className="mb-4 flex gap-2 border-b border-ink-line pb-3">
            {(['observe', 'presence', 'construct'] as const).map(key => <button key={key} onClick={() => setMode(key)} className={`rounded-lg px-3 py-1.5 text-xs ${mode === key ? 'bg-ink text-white' : 'bg-sheet text-ink-soft'}`}>{key === 'observe' ? '观察' : key === 'presence' ? '在场' : '构造'}</button>)}
          </nav>}
          {(readonly || mode === 'observe') && <div className="space-y-5">
            <WorldStatePanel key={`${worldId}:${timelineId ?? snapshot.currentTimelineId}`} worldId={worldId} timelineId={timelineId ?? snapshot.currentTimelineId} snapshot={snapshot} readonly={readonly} refresh={stateRefresh} />
            <details className="rounded-xl border border-ink-line bg-sheet p-3"><summary className="cursor-pointer text-sm text-ink-soft">变化证据与交谈记录（{events.length}）</summary><div className="mt-3"><WorldEventFeed events={events} names={names} turnsByDialogue={turnsByDialogue} expandedDialogue={expandedDialogue} onToggleDialogue={toggleDialogue} /></div></details>
          </div>}
          {!readonly && mode === 'presence' && <section className="space-y-3 rounded-xl border border-ink-line bg-sheet p-4"><h2 className="font-story text-base text-ink">以在场身份进入</h2><p className="text-xs leading-relaxed text-ink-soft">你需要先进入一个地点，之后显式移动；只能与当时同处一地、清醒且空闲的人交谈。对话不自动等于已证实的世界事实。</p><button onClick={() => setSceneOpen(true)} className="relative rounded-lg bg-ink px-4 py-2 text-xs text-white">进入世界{personaUnread > 0 ? ` · ${personaUnread} 条口信` : ''}</button></section>}
          {!readonly && mode === 'construct' && timelineId && <ConstructPanel worldId={worldId} timelineId={timelineId} locations={snapshot.world.locations} onInject={handleInject} onChanged={() => { setStateRefresh(n => n + 1); void worldsApi.snapshot(worldId, timelineId).then(next => { if (activeTimelineRef.current === timelineId) setSnapshot(cur => cur?.currentTimelineId === timelineId ? next : cur) }).catch(() => {}) }} />}
        </main>
        {selectedPersonId && (
          <PersonDrawer
            focus={personFocus}
            loading={focusLoading}
            liveState={liveStates[selectedPersonId] ?? null}
            fallbackName={names.get(selectedPersonId) ?? ''}
            personId={selectedPersonId}
            canChat={!readonly}
            canEditMemories={!readonly && mode === 'construct'}
            timelineId={timelineId ?? snapshot.currentTimelineId}
            expectedVersion={Math.max(snapshot.stateVersion, clock?.stateVersion ?? 0)}
            onClose={() => setSelectedPersonId(null)}
            onMemoriesChanged={() => {
              const targetTimelineId = timelineId ?? snapshot.currentTimelineId
              setFocusRefresh((n) => n + 1)
              void worldsApi.snapshot(worldId, targetTimelineId).then(next => {
                if (activeTimelineRef.current !== targetTimelineId || next.currentTimelineId !== targetTimelineId) return
                setSnapshot(cur => cur?.currentTimelineId === next.currentTimelineId && cur.stateVersion > next.stateVersion ? cur : next)
                setClock(cur => cur?.timelineId === targetTimelineId && cur.stateVersion > next.stateVersion
                  ? cur : clockFromSnapshot(next))
              }).catch(() => {})
            }}
          />
        )}
        {chaptersOpen && timelineId && (
          <ChapterPanel worldId={worldId} timelineId={timelineId} onClose={() => setChaptersOpen(false)} />
        )}
        {sceneOpen && timelineId && (
          <ScenePanel key={`${worldId}:${timelineId}`} worldId={worldId} timelineId={timelineId} locations={snapshot.world.locations} onClose={() => setSceneOpen(false)} />
        )}
        {lifeOpen && timelineId && <LifePanel worldId={worldId} timelineId={timelineId} onClose={() => setLifeOpen(false)} />}
        {compareOpen && timelineId && snapshot.timelines.length > 1 && <ComparePanel worldId={worldId} currentTimelineId={timelineId} timelines={snapshot.timelines} onClose={() => setCompareOpen(false)} />}
      </div>
    </div>
  )
}
