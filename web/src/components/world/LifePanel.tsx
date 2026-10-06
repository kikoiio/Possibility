import { useEffect, useRef, useState } from 'react'
import { lifeApi } from '../../api/client'
import type { CommitmentView, ReturnBrief, ReturnChange } from '../../api/types'
import { formatWorldTime } from '../../lib/world-time'
import EventEvidenceDetail from './EventEvidenceDetail'

interface Props {
  worldId: string
  timelineId: string
  timeZone?: string | null
  onClose: () => void
  onForkAtMoment: (simTime: string, premise: string) => void
}
const label: Record<string, string> = { proposed: '等你决定', accepted: '已经约好', fulfilled: '如约完成', missed: '错过了', expired: '邀请已过期', declined: '已婉拒', explained: '已经解释' }

export default function LifePanel({ worldId, timelineId, timeZone, onClose, onForkAtMoment }: Props) {
  const [brief, setBrief] = useState<ReturnBrief | null>(null)
  const [changes, setChanges] = useState<ReturnChange[]>([])
  const [watermark, setWatermark] = useState({ eventCursor: 0, revisionVersion: 0 })
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const loadInitial = async (generation = requestGeneration.current) => {
    if (generation !== requestGeneration.current) return
    setLoading(true)
    setError('')
    try {
      const result = await lifeApi.returnBrief(worldId, timelineId)
      if (generation !== requestGeneration.current) return
      setBrief(result)
      setChanges(result.changes)
      setWatermark({ eventCursor: result.nextEventCursor, revisionVersion: result.nextRevisionVersion })
      setHasMore(result.hasMore)
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setError(cause instanceof Error ? cause.message : '归来回顾加载失败')
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }
  useEffect(() => {
    const generation = ++requestGeneration.current
    setBrief(null)
    setChanges([])
    setWatermark({ eventCursor: 0, revisionVersion: 0 })
    setHasMore(false)
    setLoadingMore(false)
    setBusy(null)
    setSelectedEvent(null)
    void loadInitial(generation)
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current++
    }
  }, [worldId, timelineId])

  const loadMore = async () => {
    if (loadingMore || !hasMore) return
    const generation = requestGeneration.current
    const pageWatermark = watermark
    setLoadingMore(true)
    setError('')
    try {
      const result = await lifeApi.returnBrief(worldId, timelineId, pageWatermark)
      if (generation !== requestGeneration.current) return
      setBrief(result)
      setChanges(current => {
        const all = new Map(current.map(change => [change.id, change]))
        result.changes.forEach(change => all.set(change.id, change))
        return [...all.values()].sort((a, b) => a.simTime.localeCompare(b.simTime) || a.id.localeCompare(b.id))
      })
      setWatermark({ eventCursor: result.nextEventCursor, revisionVersion: result.nextRevisionVersion })
      setHasMore(result.hasMore)
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setError(cause instanceof Error ? cause.message : '更多记录加载失败')
    } finally {
      if (generation === requestGeneration.current) setLoadingMore(false)
    }
  }

  const act = async (commitment: CommitmentView, action: string) => {
    const generation = requestGeneration.current
    setBusy(commitment.id)
    setError('')
    try {
      await lifeApi.act(worldId, commitment.id, action)
      await loadInitial(generation)
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setError(cause instanceof Error ? cause.message : '操作失败')
    } finally {
      if (generation === requestGeneration.current) setBusy(null)
    }
  }

  const markSeen = async () => {
    const generation = requestGeneration.current
    setError('')
    try {
      await lifeApi.markSeen(worldId, timelineId, watermark.eventCursor, watermark.revisionVersion)
      if (generation !== requestGeneration.current) return
      onClose()
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setError(cause instanceof Error ? cause.message : '已读水位保存失败，请重试')
    }
  }

  const highlightedCount = changes.filter(change => change.highlight !== null).length
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" onClick={onClose}>
    <section className="max-h-[86vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-ink-line bg-paper p-5 shadow-xl" onClick={event => event.stopPropagation()}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-story text-lg text-ink">你不在的时候</h2>
          <p className="mt-1 text-xs text-ink-faint">只依据已经写入世界的记录。事实、关联与未知会分开展示。</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-xs text-ink-faint">关闭</button>
      </div>
      {error && <div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
        <span>{error}</span>
        {!brief && <button type="button" onClick={() => void loadInitial()} className="rounded border border-red-200 px-2 py-1">重试</button>}
      </div>}
      {!brief && loading && <p className="py-12 text-center text-sm text-ink-faint" role="status">回到世界的门正在打开…</p>}
      {brief && <>
        <div className="mb-4 rounded-xl bg-[#edf0e7] px-4 py-3">
          <p className="font-story text-sm text-ink">{brief.summary}</p>
          <p className="mt-1 text-[11px] text-ink-faint">模拟时间截至 {formatWorldTime(brief.simNow, timeZone)}{highlightedCount ? ' · ' + highlightedCount + ' 项重点变化' : ''}</p>
        </div>

        {!changes.length && <p className="rounded-xl border border-dashed border-ink-line p-5 text-center text-sm text-ink-faint">你离开后，暂时没有新的动静。</p>}
        <div className="space-y-2">
          {changes.map(change => <article key={change.id} className="rounded-xl border border-ink-line bg-sheet px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-ink-faint">{formatWorldTime(change.simTime, timeZone)}{change.actorName ? ' · ' + change.actorName : ''}</p>
              {change.highlight && <span className="rounded-full bg-[#e8eee5] px-2 py-1 text-[10px] text-[#45634d]">{change.highlight === 'commitment_change' ? '约定变化' : '状态变化'}</span>}
            </div>
            <p className="mt-1 font-story text-sm font-semibold text-ink">{change.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-soft">{change.description}</p>
            {change.eventId
              ? <button type="button" onClick={() => setSelectedEvent(current => current === change.eventId ? null : change.eventId)}
                  aria-expanded={selectedEvent === change.eventId}
                  className="mt-2 rounded-md border border-ink-line px-2.5 py-1.5 text-[11px] text-ink-soft">
                  {selectedEvent === change.eventId ? '收起来源与当时状态' : '查看来源与当时状态'}
                </button>
              : <p className="mt-2 text-[10px] text-ink-faint">来源事件缺失；保留事实记录供查看。</p>}
            {change.eventId && selectedEvent === change.eventId && <EventEvidenceDetail
              worldId={worldId}
              timelineId={timelineId}
              eventId={change.eventId}
              timeZone={timeZone}
              onForkAtMoment={(simTime, premise) => onForkAtMoment(simTime, premise)}
            />}
          </article>)}
        </div>
        {hasMore && <button type="button" onClick={() => void loadMore()} disabled={loadingMore}
          className="mt-3 w-full rounded-lg border border-ink-line bg-white px-3 py-2 text-xs text-ink-soft disabled:opacity-50">
          {loadingMore ? '正在读取更多记录…' : '加载更多变化'}
        </button>}

        {brief.commitments.length > 0 && <div className="mt-5">
          <h3 className="mb-2 font-story text-sm text-ink-soft">与你有关的约定</h3>
          <div className="space-y-2">{brief.commitments.map(commitment => <article key={commitment.id} className="rounded-xl border border-ink-line bg-sheet px-3 py-2.5">
            <div className="flex justify-between gap-3">
              <div><p className="font-story text-sm text-ink">{commitment.title}</p><p className="mt-1 text-xs text-ink-faint">{commitment.personName} · {commitment.location} · {label[commitment.status] ?? commitment.status}</p></div>
              {commitment.status === 'proposed' && <div className="flex gap-1">
                <button disabled={busy === commitment.id} onClick={() => void act(commitment, 'accept')} className="rounded bg-ink px-2 py-1 text-[11px] text-white">接受</button>
                <button disabled={busy === commitment.id} onClick={() => void act(commitment, 'decline')} className="rounded border border-ink-faint px-2 py-1 text-[11px] text-ink-soft">拒绝</button>
              </div>}
              {commitment.status === 'accepted' && <button disabled={busy === commitment.id} onClick={() => void act(commitment, 'fulfill')} className="rounded bg-woad px-2 py-1 text-[11px] text-white">赴约</button>}
            </div>
          </article>)}</div>
        </div>}
        <button type="button" onClick={() => void markSeen()} className="mt-5 w-full rounded-lg bg-ink px-4 py-2 text-xs text-white">看完了，记下这个时间点</button>
      </>}
    </section>
  </div>
}
