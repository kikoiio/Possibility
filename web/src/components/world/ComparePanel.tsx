import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { lifeApi } from '../../api/client'
import type { TimelineInfo } from '../../api/types'
import { formatWorldTime } from '../../lib/world-time'
import { timelineDisplayName, timelineOptionLabel } from '../../world/timeline-display'

interface Props {
  worldId: string
  currentTimelineId: string
  timelines: TimelineInfo[]
  personNames?: Record<string, string>
  onClose: () => void
  initialLeftTimelineId?: string
  initialRightTimelineId?: string
  loadComparison?: (left: string, right: string) => Promise<unknown>
}

interface ForkEvidence {
  forkTimelineId: string
  sourceTimelineId: string | null
  sourceSimTime: string | null
  provenance: 'snapshot' | 'legacy'
  sourceStateVersion: number | null
  worldModelVersion: number | null
  scenario: {
    name?: string
    whatIf: string | null
    startTime: string | null
    changedVariable: string | null
    participants: string[]
    invariants: string[]
  } | null
}

interface StateEvidence {
  timelineId: string
  simTime: string
  updatedRealAt: string
}

interface CompareEvent {
  id: string
  simTime: string
  title: string
  description: string
  timelineId?: string
}

interface Comparison {
  left: { id: string; simNow: string }
  right: { id: string; simNow: string }
  timeAlignment: 'same_sim_time' | 'different_sim_times'
  sharedForkOrigin: {
    timelineId: string
    leftFork: ForkEvidence | null
    rightFork: ForkEvidence | null
  } | null
  differences: {
    states: {
      personId: string
      changes: {
        field: string
        left: string | null
        right: string | null
        leftEvidence: StateEvidence | null
        rightEvidence: StateEvidence | null
      }[]
    }[]
    facts: {
      key: string
      left: { value: unknown; factId: string; version: number; simTime: string } | null
      right: { value: unknown; factId: string; version: number; simTime: string } | null
    }[]
    worldModelVersions: { left: number | null; right: number | null }
    events: {
      shared: CompareEvent[]
      leftOnly: CompareEvent[]
      rightOnly: CompareEvent[]
    }
  }
  limitations: string[]
}

const FACT_KEY_LABELS: Record<string, string> = {
  weather: '天气状况',
  season: '时节气候',
  location: '地点变动',
  door_locked: '门锁状态',
  atmosphere: '空间氛围',
  rule: '空间规则',
  mystery: '关键线索',
}

const PERSON_FIELD_LABELS: Record<string, string> = {
  location: '所在地点',
  activity: '正在进行的事',
  mood: '心境与情绪',
  state: '身心状态',
  intention: '心里打算',
  clothing: '衣着打扮',
  relation: '人际关系',
}

function formatFactKey(key: string): string {
  return FACT_KEY_LABELS[key] || key
}

function formatFactValue(value: unknown): string {
  if (value === null || value === undefined) return '未设定'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(formatFactValue).join('、')
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.name === 'string') return obj.name
    if (typeof obj.label === 'string') return obj.label
    if (typeof obj.title === 'string') return obj.title
    return Object.entries(obj).map(([k, v]) => `${k}：${formatFactValue(v)}`).join('，')
  }
  return String(value)
}

function formatPersonField(field: string): string {
  return PERSON_FIELD_LABELS[field] || field
}

function formatPersonName(personId: string, personNames?: Record<string, string>): string {
  if (personNames && personNames[personId]) {
    return personNames[personId]
  }
  return `居民（${personId.slice(0, 8)}）`
}

export default function ComparePanel({
  worldId,
  currentTimelineId,
  timelines,
  personNames,
  onClose,
  initialLeftTimelineId,
  initialRightTimelineId,
  loadComparison,
}: Props) {
  const navigate = useNavigate()
  const [left, setLeft] = useState(initialLeftTimelineId ?? currentTimelineId)
  const currentParentId = timelines.find(t => t.id === currentTimelineId)?.parentTimelineId
  const comparisonTarget =
    (currentParentId && timelines.some(t => t.id === currentParentId)
      ? currentParentId
      : timelines.find(t => t.id !== currentTimelineId)?.id) ?? currentTimelineId
  const [right, setRight] = useState(initialRightTimelineId ?? comparisonTarget)
  const [data, setData] = useState<Comparison | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    setData(null)
    setError('')
    if (left === right) {
      setData(null)
      return
    }
    let live = true
    const loader = loadComparison ? loadComparison(left, right) : lifeApi.compare(worldId, left, right)
    loader
      .then(v => {
        if (live) setData(v as Comparison)
      })
      .catch(e => {
        if (live) setError(e instanceof Error ? e.message : '对照失败')
      })
    return () => {
      live = false
    }
  }, [worldId, left, right, loadComparison])

  const label = (id: string) => {
    const timeline = timelines.find(t => t.id === id)
    return timeline ? timelineOptionLabel(timeline) : '未知时间线'
  }

  const zoneForTimeline = (id: string | null | undefined) =>
    timelines.find(t => t.id === id)?.timeZone ?? timelines[0]?.timeZone

  const fmt = (value: string | null | undefined, timelineId?: string | null) =>
    value ? formatWorldTime(value, zoneForTimeline(timelineId)) : '未知时间'

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs animate-fade-in"
      onClick={onClose}
    >
      <section
        className="max-h-[86vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-ink-line bg-paper p-5 sm:p-6 shadow-2xl animate-fade-in-up"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-line/60 pb-3">
          <div>
            <h2 className="font-story text-lg font-semibold text-ink">两种人生</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              记录平行宇宙间的真实差异，以可验证的生活轨迹代替主观推想。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              data-testid="compare-split-entry"
              disabled={left === right}
              onClick={() =>
                navigate(
                  `/worlds/${encodeURIComponent(worldId)}?mode=possibility&timeline=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`
                )
              }
              className="rounded-full bg-sage-700 px-3.5 py-1 text-xs font-medium text-white shadow-xs transition hover:bg-sage-800 disabled:bg-ink-line disabled:text-ink-faint"
            >
              分屏查看
            </button>
            <button
              onClick={onClose}
              className="rounded-full px-2.5 py-1 text-xs text-ink-faint hover:bg-paper-deep hover:text-ink transition"
              aria-label="关闭"
            >
              关闭
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-xs text-ink-soft">
            <span className="block font-medium mb-1">左侧时间线</span>
            <select
              value={left}
              onChange={e => setLeft(e.target.value)}
              className="block w-full rounded-xl border border-ink-line bg-sheet px-3 py-2 text-xs text-ink shadow-xs outline-none focus:border-sage-700 transition"
            >
              {timelines.map(t => (
                <option key={t.id} value={t.id}>
                  {label(t.id)} · {formatWorldTime(t.simNow, t.timeZone)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-soft">
            <span className="block font-medium mb-1">右侧时间线</span>
            <select
              value={right}
              onChange={e => setRight(e.target.value)}
              className="block w-full rounded-xl border border-ink-line bg-sheet px-3 py-2 text-xs text-ink shadow-xs outline-none focus:border-sage-700 transition"
            >
              {timelines.map(t => (
                <option key={t.id} value={t.id}>
                  {label(t.id)} · {formatWorldTime(t.simNow, t.timeZone)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {left === right && (
          <p className="py-12 text-center text-sm text-ink-faint">请在上方选择两条不同的时间线进行对比。</p>
        )}

        {error && <p className="mt-3 rounded-xl bg-red-50 px-3.5 py-2.5 text-xs text-red-600">{error}</p>}

        {data && (
          <div className="mt-5 space-y-4">
            <div
              className={`rounded-xl px-3.5 py-2.5 text-xs flex items-center gap-2 ${
                data.timeAlignment === 'same_sim_time'
                  ? 'bg-sage-100/70 text-sage-800 border border-sage-200'
                  : 'bg-amber-50 text-amber-800 border border-amber-200'
              }`}
            >
              <span className="text-sm">
                {data.timeAlignment === 'same_sim_time' ? '✓' : 'ℹ'}
              </span>
              <span>
                {data.timeAlignment === 'same_sim_time'
                  ? '两线已对齐到相同世界时间。可直接观察同期走向。'
                  : '两线世界时间尚未对齐；以下只是各自当前状态，不能直接解释为同一时刻的结果。'}
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-faint px-1">
              <span>
                共同历史根源：
                <strong className="font-medium text-ink-soft">
                  {data.sharedForkOrigin ? label(data.sharedForkOrigin.timelineId) : '未记录'}
                </strong>
              </span>
              <span>
                世界设定版本：
                {data.differences.worldModelVersions.left === data.differences.worldModelVersions.right
                  ? `一致 (v${data.differences.worldModelVersions.left ?? '旧'})`
                  : `左 v${data.differences.worldModelVersions.left ?? '?'} / 右 v${data.differences.worldModelVersions.right ?? '?'}`}
              </span>
            </div>

            <section className="rounded-xl border border-ink-line bg-sheet p-3.5 shadow-xs">
              <h3 className="font-story text-sm font-semibold text-ink">共同过去与分叉条件</h3>
              {data.sharedForkOrigin ? (
                <div className="mt-2.5 space-y-3 text-xs text-ink-soft">
                  {([['左线', data.sharedForkOrigin.leftFork], ['右线', data.sharedForkOrigin.rightFork]] as const).map(
                    ([side, fork]) =>
                      fork && (
                        <div
                          key={fork.forkTimelineId}
                          className="rounded-lg bg-paper-light/60 p-2.5 border border-ink-line/40"
                        >
                          <p className="font-medium text-ink flex items-center justify-between">
                            <span>
                              {side}分叉 ·{' '}
                              {fork.scenario?.name ||
                                fork.scenario?.whatIf ||
                                timelineDisplayName(
                                  timelines.find(t => t.id === fork.forkTimelineId) ?? {
                                    parentTimelineId: 'unknown',
                                  }
                                )}
                            </span>
                            <span className="text-[10px] text-ink-faint">
                              {fork.provenance === 'snapshot'
                                ? `Checkpoint v${fork.sourceStateVersion ?? '?'}`
                                : '历史证据不完整'}
                            </span>
                          </p>
                          <p className="mt-1 text-[11px] text-ink-faint">
                            分叉自原时刻：{fmt(fork.sourceSimTime, fork.sourceTimelineId)}
                          </p>
                          {fork.scenario ? (
                            <div className="mt-1.5 space-y-1 text-ink-soft">
                              <p>
                                改变前提：
                                <strong className="font-medium text-cinnabar-deep">
                                  {fork.scenario.changedVariable ?? fork.scenario.whatIf ?? '未记录'}
                                </strong>
                                {fork.scenario.whatIf && fork.scenario.whatIf !== fork.scenario.changedVariable ? (
                                  <span className="text-ink-faint">（{fork.scenario.whatIf}）</span>
                                ) : null}
                              </p>
                              {!!fork.scenario.participants.length && (
                                <p className="text-[11px] text-ink-faint">
                                  牵涉居民：{fork.scenario.participants.join('、')}
                                </p>
                              )}
                              {!!fork.scenario.invariants.length && (
                                <p className="text-[11px] text-ink-faint">
                                  约定不变：{fork.scenario.invariants.join('；')}
                                </p>
                              )}
                            </div>
                          ) : (
                            <p className="mt-1 text-ink-faint">未保存可核对的分叉前置条件。</p>
                          )}
                        </div>
                      )
                  )}
                </div>
              ) : (
                <p className="mt-2 text-xs text-ink-faint">无法确认两条宇宙的共同分叉来源；不推断共同历史。</p>
              )}
            </section>

            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-xl border border-ink-line/60 bg-sheet p-3 shadow-xs">
                <span className="block text-ink-faint">共同历史事件</span>
                <b className="mt-1 block text-lg font-semibold text-ink">
                  {data.differences.events.shared.length}
                </b>
              </div>
              <div className="rounded-xl border border-woad/20 bg-woad-soft/60 p-3 shadow-xs">
                <span className="block text-woad-deep/80">左线独有经历</span>
                <b className="mt-1 block text-lg font-semibold text-woad-deep">
                  {data.differences.events.leftOnly.length}
                </b>
              </div>
              <div className="rounded-xl border border-cinnabar/20 bg-cinnabar-soft/60 p-3 shadow-xs">
                <span className="block text-cinnabar-deep/80">右线独有经历</span>
                <b className="mt-1 block text-lg font-semibold text-cinnabar-deep">
                  {data.differences.events.rightOnly.length}
                </b>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              {(
                [
                  ['共同过去', data.differences.events.shared, 'border-ink-line/60'],
                  ['左线独有', data.differences.events.leftOnly, 'border-woad/30'],
                  ['右线独有', data.differences.events.rightOnly, 'border-cinnabar/30'],
                ] as const
              ).map(([title, events, borderCls]) => (
                <section key={title} className={`rounded-xl border ${borderCls} bg-sheet p-3 shadow-xs`}>
                  <h3 className="text-xs font-medium text-ink-soft flex items-center justify-between">
                    <span>{title}</span>
                    <span className="text-[10px] text-ink-faint">{events.length} 项</span>
                  </h3>
                  {events.length ? (
                    <ul className="mt-2 space-y-2">
                      {events.slice(0, 4).map(event => (
                        <li
                          key={event.id}
                          className="rounded-lg bg-paper-light/70 p-2 text-[11px] text-ink-soft border border-ink-line/30"
                        >
                          <span className="font-medium text-ink block">{event.title}</span>
                          <span className="mt-0.5 block text-[10px] text-ink-faint">
                            {fmt(event.simTime, event.timelineId ?? (title === '右线独有' ? right : left))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-[11px] text-ink-faint py-2 text-center">暂无记录</p>
                  )}
                </section>
              ))}
            </div>

            <div>
              <h3 className="mb-2 font-story text-sm font-semibold text-ink">世界事实差异</h3>
              {!data.differences.facts.length && (
                <p className="rounded-xl bg-sheet p-3 border border-ink-line/60 text-xs text-ink-faint">
                  没有已记录的结构化事实差异；旧数据缺证据时不能据此断定完全相同。
                </p>
              )}
              {data.differences.facts.map(f => (
                <article
                  key={f.key}
                  className="mb-2.5 rounded-xl border border-ink-line/80 bg-sheet p-3 text-xs shadow-xs transition hover:border-ink-line"
                >
                  <p className="font-medium text-ink flex items-center gap-1.5">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-sage-600" />
                    <span>{formatFactKey(f.key)}</span>
                    {formatFactKey(f.key) !== f.key && (
                      <span className="font-normal text-[11px] text-ink-faint">({f.key})</span>
                    )}
                  </p>
                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-lg bg-paper-light/70 p-2.5 border border-ink-line/40">
                    <div>
                      <span className="text-[11px] font-medium text-woad-deep">左线：</span>
                      <span className="text-ink-soft ml-1">
                        {f.left ? formatFactValue(f.left.value) : '未记录'}
                      </span>
                      {f.left && (
                        <span className="block mt-0.5 text-[10px] text-ink-faint">
                          依据：{fmt(f.left.simTime, left)} · 纪实 v{f.left.version}
                        </span>
                      )}
                    </div>
                    <div className="border-t sm:border-t-0 sm:border-l border-ink-line/50 pt-1.5 sm:pt-0 sm:pl-2.5">
                      <span className="text-[11px] font-medium text-cinnabar-deep">右线：</span>
                      <span className="text-ink-soft ml-1">
                        {f.right ? formatFactValue(f.right.value) : '未记录'}
                      </span>
                      {f.right && (
                        <span className="block mt-0.5 text-[10px] text-ink-faint">
                          依据：{fmt(f.right.simTime, right)} · 纪实 v{f.right.version}
                        </span>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>

            <div>
              <h3 className="mb-2 font-story text-sm font-semibold text-ink">人物状态差异</h3>
              {!data.differences.states.length && (
                <p className="rounded-xl bg-sheet p-3 border border-ink-line/60 text-xs text-ink-faint">
                  目前没有记录到状态差异。
                </p>
              )}
              {data.differences.states.map(s => (
                <article
                  key={s.personId}
                  className="mb-2.5 rounded-xl border border-ink-line/80 bg-sheet p-3 text-xs shadow-xs"
                >
                  <p className="font-medium text-ink flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 rounded-full bg-woad" />
                    <span>{formatPersonName(s.personId, personNames)}</span>
                  </p>
                  <div className="mt-2 space-y-2">
                    {s.changes.map(c => (
                      <div
                        key={c.field}
                        className="rounded-lg bg-paper-light/70 p-2.5 border border-ink-line/40"
                      >
                        <div className="flex items-center gap-1 text-[11px] font-medium text-ink-soft">
                          <span>{formatPersonField(c.field)}</span>
                          {formatPersonField(c.field) !== c.field && (
                            <span className="font-normal text-[10px] text-ink-faint">({c.field})</span>
                          )}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-ink">
                          <span className="rounded bg-sheet px-2 py-0.5 border border-ink-line/60 text-ink-soft">
                            {c.left ?? '无记录'}
                          </span>
                          <span className="text-ink-faint text-xs">➔</span>
                          <span className="rounded bg-cinnabar-soft px-2 py-0.5 text-cinnabar-deep font-medium border border-cinnabar/20">
                            {c.right ?? '无记录'}
                          </span>
                        </div>
                        {(c.leftEvidence || c.rightEvidence) && (
                          <p className="mt-1.5 text-[10px] text-ink-faint">
                            {c.leftEvidence ? `原线观察于 ${fmt(c.leftEvidence.simTime, left)}` : '原线无观察记录'}
                            {' · '}
                            {c.rightEvidence ? `平行线观察于 ${fmt(c.rightEvidence.simTime, right)}` : '平行线无观察记录'}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>

            {data.limitations.length > 0 && (
              <ul className="space-y-1 text-[11px] text-ink-faint border-t border-ink-line/50 pt-2">
                {data.limitations.map((x, i) => (
                  <li key={i}>· {x}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
