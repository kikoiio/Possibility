import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { apiFetch, ApiError, postSSE } from '../api/client'
import type {
  ForkScenario,
  PersonDetail,
  TimelineDetail,
  TimelineEvent,
  TimelineSummary,
} from '../api/types'
import ScenarioCard from '../components/ScenarioCard'
import EventStream from '../components/EventStream'

type Phase = 'view' | 'preview' | 'simulating'

export default function TimelineView() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [detail, setDetail] = useState<TimelineDetail | null>(null)
  const [siblings, setSiblings] = useState<TimelineSummary[]>([])
  const [phase, setPhase] = useState<Phase>('view')
  const [whatIf, setWhatIf] = useState('')
  const [scenario, setScenario] = useState<ForkScenario | null>(null)
  const [streamEvents, setStreamEvents] = useState<TimelineEvent[]>([])
  const [streamText, setStreamText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const forkIdRef = useRef<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setError('')
    try {
      const d = await apiFetch<TimelineDetail>(`/api/timelines/${id}`)
      setDetail(d)
      if (d.person) {
        const p = await apiFetch<PersonDetail>(`/api/persons/${d.person.id}`)
        setSiblings(p.timelines)
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败')
    }
  }, [id])

  useEffect(() => {
    setPhase('view')
    setScenario(null)
    setStreamEvents([])
    setStreamText('')
    load()
  }, [load])

  async function onPreview() {
    if (!whatIf.trim() || !detail?.person || busy) return
    setError('')
    setBusy(true)
    try {
      const s = await apiFetch<ForkScenario>(`/api/persons/${detail.person.id}/fork/preview`, {
        method: 'POST',
        body: JSON.stringify({ whatIf: whatIf.trim() }),
      })
      setScenario(s)
      setPhase('preview')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '场景生成失败')
    } finally {
      setBusy(false)
    }
  }

  async function onConfirm() {
    if (!scenario || !detail?.person) return
    setPhase('simulating')
    setStreamEvents([])
    setStreamText('')
    setError('')
    forkIdRef.current = null
    try {
      await postSSE(`/api/persons/${detail.person.id}/fork`, { scenario }, (ev) => {
        if (ev.type === 'timeline') {
          forkIdRef.current = ev.timelineId
        } else if (ev.type === 'event') {
          setStreamEvents((es) => [
            ...es,
            { id: ev.id, timelineId: '', simTime: ev.simTime, title: ev.title, description: ev.description },
          ])
        } else if (ev.type === 'text') {
          setStreamText((t) => t + ev.delta)
        } else if (ev.type === 'error') {
          setError(ev.message)
        }
      })
    } catch {
      setError('推演中断，请重试')
    }
    if (forkIdRef.current) {
      navigate(`/timelines/${forkIdRef.current}`, { replace: true })
    } else {
      setPhase('view')
    }
  }

  if (error && !detail) {
    return <div className="p-8 text-center text-sm text-red-600">{error}</div>
  }
  if (!detail) {
    return <div className="p-8 text-center text-sm text-ink-faint">加载中…</div>
  }

  const isMain = detail.timeline.parentTimelineId === null
  const isSimulating = phase === 'simulating'

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 pb-8">
      {/* 头部 + 时间线切换 */}
      <div className="mb-4">
        <Link to={detail.person ? `/people/${detail.person.id}` : '/'} className="text-xs text-ink-faint">
          ← {detail.person?.name ?? '返回'}
        </Link>
        <div className="mt-1 flex items-center justify-between gap-2">
          <h1 className="truncate text-lg font-semibold text-ink">{detail.world.name}</h1>
          {siblings.length > 1 && (
            <select
              className="rounded-lg border border-ink-faint bg-sheet px-2 py-1 text-xs text-ink-soft"
              value={detail.timeline.id}
              onChange={(e) => navigate(`/timelines/${e.target.value}`)}
            >
              {siblings.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.parentTimelineId === null ? '主线' : `What-if：${t.forkScenario?.whatIf?.slice(0, 18)}…`}
                </option>
              ))}
            </select>
          )}
        </div>
        {!isMain && detail.timeline.forkScenario && (
          <p className="mt-1 text-xs text-woad">What-if：{detail.timeline.forkScenario.whatIf}</p>
        )}
      </div>

      {/* 主线：发起 what-if */}
      {isMain && phase === 'view' && (
        <div className="mb-6 rounded-xl border border-ink-line bg-sheet p-4">
          <h2 className="mb-2 text-sm font-medium text-ink-soft">如果当时不一样，会怎样？</h2>
          <textarea
            className="h-20 w-full rounded-xl border border-ink-faint p-3 text-sm outline-none focus:border-ink-soft"
            placeholder="例如：如果我毕业后没有去出版社，而是当年就回杭州开了这家书店"
            value={whatIf}
            onChange={(e) => setWhatIf(e.target.value)}
            disabled={busy}
          />
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          <button
            onClick={onPreview}
            disabled={busy || !whatIf.trim()}
            className="mt-2 w-full rounded-xl bg-ink py-2.5 text-sm text-white disabled:opacity-50"
          >
            {busy ? '正在生成场景设定…' : '看看这个 What-if'}
          </button>
        </div>
      )}

      {/* 场景确认 */}
      {phase === 'preview' && scenario && (
        <div className="mb-6">
          <ScenarioCard
            scenario={scenario}
            onChange={setScenario}
            onConfirm={onConfirm}
            onCancel={() => setPhase('view')}
          />
        </div>
      )}

      {/* 推演中：事件逐条生长 */}
      {isSimulating && (
        <div className="mb-6 space-y-4">
          {scenario && <ScenarioCard scenario={scenario} />}
          {error && <p className="text-xs text-red-600">{error}</p>}
          <EventStream events={streamEvents} isFork streaming />
        </div>
      )}

      {/* 已有时间线的事件流 */}
      {phase === 'view' && (
        <div className="space-y-4">
          <EventStream events={detail.events} isFork={!isMain} />
          {!isMain && detail.person && (
            <Link
              to={`/people/${detail.person.id}?timeline=${detail.timeline.id}`}
              className="block rounded-xl bg-ink py-3 text-center text-sm text-white"
            >
              和这条时间线里的 {detail.person.name} 聊聊
            </Link>
          )}
        </div>
      )}

      {/* 推演尾声的一段话 */}
      {streamText && phase === 'simulating' && (
        <p className="mt-4 rounded-xl bg-paper-deep px-4 py-3 text-sm text-ink-soft">{streamText}</p>
      )}
    </div>
  )
}
