import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { publicApi, subscribeWorldStream, worldsApi } from '../api/client'
import type {
  DialogueDetail,
  PersonFocus,
  WorldEventItem,
  WorldSnapshot,
  WorldStreamEvent,
} from '../api/types'
import LocationPanel from '../components/world/LocationPanel'
import WorldEventFeed from '../components/world/WorldEventFeed'
import PersonDrawer from '../components/world/PersonDrawer'
import TimelineSwitcher from '../components/world/TimelineSwitcher'
import InjectBox from '../components/world/InjectBox'

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

function fmtSimTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

export default function WorldView({ worldId, readonly = false }: WorldViewProps) {
  const api = readonly ? publicApi : worldsApi
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null)
  const [timelineId, setTimelineId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [events, setEvents] = useState<WorldEventItem[]>([])
  const [liveStates, setLiveStates] = useState<Record<string, PersonLiveState>>({})
  const [turnsByDialogue, setTurnsByDialogue] = useState<Record<string, { turnIndex: number; personId: string; utterance: string; thought: string; simTime: string }[]>>({})
  const [clock, setClock] = useState<{ simNow: string; callsToday: number; worldStatus: string; pauseReason: string | null } | null>(null)
  const [displayNow, setDisplayNow] = useState<string>('')
  const clockBaseRef = useRef<{ simNow: number; realAt: number } | null>(null)
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null)
  const [personFocus, setPersonFocus] = useState<PersonFocus | null>(null)
  const [focusLoading, setFocusLoading] = useState(false)
  const [expandedDialogue, setExpandedDialogue] = useState<{ id: string; detail: DialogueDetail | null } | null>(null)
  const [actionError, setActionError] = useState('')

  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const loc of snapshot?.locationBoard ?? []) for (const p of loc.persons) m.set(p.id, p.name)
    return m
  }, [snapshot])

  // 装载快照（世界或时间线切换时重置一切本地增量状态）
  useEffect(() => {
    setSnapshot(null)
    setError('')
    api
      .snapshot(worldId, timelineId ?? undefined)
      .then((snap) => {
        setSnapshot(snap)
        setEvents(snap.events)
        setTurnsByDialogue({})
        setLiveStates({})
        setClock({ simNow: snap.simNow, callsToday: snap.world.callsToday, worldStatus: snap.world.status, pauseReason: snap.world.pauseReason })
        if (!timelineId) setTimelineId(snap.currentTimelineId)
        clockBaseRef.current = { simNow: Date.parse(snap.simNow), realAt: Date.now() }
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId, timelineId])

  // 订阅增量流
  useEffect(() => {
    if (!timelineId) return
    const unsub = subscribeWorldStream(
      worldId,
      timelineId,
      (ev: WorldStreamEvent) => {
        if (ev.type === 'event') {
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
          setClock({ simNow: ev.simNow, callsToday: ev.callsToday, worldStatus: ev.worldStatus, pauseReason: ev.pauseReason })
          clockBaseRef.current = { simNow: Date.parse(ev.simNow), realAt: Date.now() }
        }
      },
      { isPublic: readonly },
    )
    return unsub
  }, [worldId, timelineId, readonly])

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
      return
    }
    setFocusLoading(true)
    api
      .personFocus(worldId, selectedPersonId, timelineId)
      .then(setPersonFocus)
      .catch(() => setPersonFocus(null))
      .finally(() => setFocusLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPersonId, timelineId, worldId])

  // 展开对话
  const toggleDialogue = useCallback(
    (dialogueId: string) => {
      setExpandedDialogue((cur) => {
        if (cur?.id === dialogueId) return null
        return { id: dialogueId, detail: null }
      })
      setExpandedDialogue((cur) => cur)
      api
        .dialogueDetail(dialogueId)
        .then((detail) => setExpandedDialogue((cur) => (cur?.id === dialogueId ? { id: dialogueId, detail } : cur)))
        .catch(() => setExpandedDialogue(null))
    },
    [api],
  )

  const handlePauseResume = async () => {
    if (!snapshot) return
    setActionError('')
    try {
      if (clock?.worldStatus === 'running') await worldsApi.pause(worldId)
      else await worldsApi.resume(worldId)
      // 状态由流 clock 事件同步；立刻拉一次快照兜底（流可能尚未推）
      const snap = await worldsApi.snapshot(worldId, timelineId ?? undefined)
      setClock({ simNow: snap.simNow, callsToday: snap.world.callsToday, worldStatus: snap.world.status, pauseReason: snap.world.pauseReason })
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '操作失败')
    }
  }

  const handleFork = async () => {
    if (!timelineId) return
    setActionError('')
    try {
      await worldsApi.fork(worldId, timelineId)
      const snap = await worldsApi.snapshot(worldId, timelineId)
      setSnapshot(snap)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Fork 失败')
    }
  }

  const handleArchive = async (tid: string) => {
    setActionError('')
    try {
      await worldsApi.archiveTimeline(tid)
      if (tid === timelineId) {
        setTimelineId(null) // 触发重新装载（回落到主线）
      } else {
        const snap = await worldsApi.snapshot(worldId, timelineId ?? undefined)
        setSnapshot(snap)
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '归档失败')
    }
  }

  const handleInject = async (text: string) => {
    if (!timelineId) return
    setActionError('')
    try {
      await worldsApi.inject(worldId, text, timelineId)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '注入失败')
      throw e
    }
  }

  if (error) return <div className="p-8 text-center text-sm text-red-600">{error}</div>
  if (!snapshot || !clock) return <div className="p-8 text-center text-sm text-ink-faint">加载中…</div>

  const running = clock.worldStatus === 'running'
  const capped = clock.worldStatus === 'capped'

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
                  running ? 'bg-emerald-100 text-emerald-700' : capped ? 'bg-red-100 text-red-700' : 'bg-paper-deep text-ink-soft'
                }`}
              >
                {running && <span className="inline-block h-1.5 w-1.5 animate-pulse-soft rounded-full bg-emerald-500" />}
                {running ? '运行中' : capped ? '已达今日上限' : '已暂停'}
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
                  onSwitch={(tid) => setTimelineId(tid)}
                  onFork={handleFork}
                  onArchive={handleArchive}
                />
                <button
                  onClick={handlePauseResume}
                  className="rounded-lg border border-ink-faint px-3 py-1.5 text-xs text-ink-soft hover:bg-paper-deep"
                >
                  {running ? '暂停' : '继续'}
                </button>
              </>
            )}
          </div>
        </div>
        {capped && (
          <p className="mt-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-600">
            今日调用已达上限，世界已自动暂停。点「继续」可复位并恢复运行。
          </p>
        )}
        {actionError && <p className="mt-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-600">{actionError}</p>}
      </div>

      {/* 主体：地点 / 事件流 / 人物抽屉 */}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-ink-line bg-paper p-3 md:block">
          <LocationPanel
            locationBoard={snapshot.locationBoard}
            liveStates={liveStates}
            onSelectPerson={(pid) => setSelectedPersonId(pid)}
          />
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-3">
          {!readonly && <InjectBox onInject={handleInject} />}
          <WorldEventFeed
            events={events}
            names={names}
            turnsByDialogue={turnsByDialogue}
            expandedDialogue={expandedDialogue}
            onToggleDialogue={toggleDialogue}
          />
        </main>
        {selectedPersonId && (
          <PersonDrawer
            focus={personFocus}
            loading={focusLoading}
            liveState={liveStates[selectedPersonId] ?? null}
            fallbackName={names.get(selectedPersonId) ?? ''}
            personId={selectedPersonId}
            onClose={() => setSelectedPersonId(null)}
          />
        )}
      </div>
    </div>
  )
}
