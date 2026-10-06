import { useEffect, useRef, useState } from 'react'
import { lifeApi } from '../../api/client'
import type { EventEvidenceDetail as EvidenceDetailType } from '../../api/types'
import { formatWorldTime } from '../../lib/world-time'

interface Props {
  worldId: string
  timelineId: string
  eventId: string
  timeZone?: string | null
  onForkAtMoment: (simTime: string, premise: string) => void
}

function factDescription(fact: EvidenceDetailType['facts'][number]): string {
  const value = fact.value
  if (fact.factType === 'environment') {
    return [value.location, value.condition, value.value].filter(item => typeof item === 'string').join(' · ')
  }
  if (fact.factType === 'knowledge') {
    const recipient = typeof value.recipientId === 'string' ? value.recipientId : '居民'
    const topic = typeof value.topic === 'string' ? value.topic : '消息'
    const content = typeof value.content === 'string' ? value.content : ''
    return recipient + ' · ' + topic + (content ? '：' + content : '')
  }
  if (fact.factType === 'commitment') {
    const from = typeof value.from === 'string' ? value.from : '未知'
    const to = typeof value.to === 'string' ? value.to : '未知'
    return '状态：' + from + ' → ' + to
  }
  return fact.subjectId
}

export default function EventEvidenceDetail({ worldId, timelineId, eventId, timeZone, onForkAtMoment }: Props) {
  const [detail, setDetail] = useState<EvidenceDetailType | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const requestGeneration = useRef(0)
  const load = async (generation = requestGeneration.current) => {
    if (generation !== requestGeneration.current) return
    setLoading(true)
    setError('')
    try {
      const result = await lifeApi.eventEvidence(worldId, timelineId, eventId)
      if (generation !== requestGeneration.current) return
      setDetail(result)
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setError(cause instanceof Error ? cause.message : '证据读取失败')
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }
  useEffect(() => {
    const generation = ++requestGeneration.current
    setDetail(null)
    void load(generation)
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current++
    }
  }, [worldId, timelineId, eventId])

  if (loading) return <p className="px-3 py-4 text-xs text-ink-faint" role="status">正在核对来源与当时状态…</p>
  if (error || !detail) return <div className="rounded-xl bg-red-50 px-3 py-3 text-xs text-red-700">
    <p>{error || '没有可读取的证据详情。'}</p>
    <button type="button" onClick={() => void load()} className="mt-2 rounded-md border border-red-200 px-2.5 py-1.5 font-medium">重试读取</button>
  </div>

  return <div className="mt-3 space-y-3 rounded-xl bg-[#f5f3eb] p-3 text-xs text-ink-soft" data-testid="event-evidence-detail">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-medium text-ink">{detail.event.actorName ?? '世界事件'}{detail.event.location ? ' · ' + detail.event.location : ''} · {formatWorldTime(detail.event.simTime, timeZone)}</p>
      <span className="rounded-full bg-white px-2 py-1 text-[10px] text-ink-faint">时间线记录</span>
    </div>
    {detail.command && <p>来源命令 · 版本 {detail.command.version}{detail.command.actorName ? ' · ' + detail.command.actorName : ''}</p>}

    <section>
      <h4 className="font-story text-sm text-ink">记录事实</h4>
      {detail.facts.length ? <ul className="mt-1 space-y-1">{detail.facts.map(fact => <li key={fact.id} className="rounded-lg bg-white/80 px-2.5 py-2">
        <span className="font-medium text-ink">{fact.factType === 'knowledge' ? '居民知识' : fact.factType === 'commitment' ? '约定状态' : fact.factType === 'environment' ? '地点状态' : '世界状态'}</span>
        <span> · {factDescription(fact)}</span>
        <span className="ml-1 text-[10px] text-ink-faint">第 {fact.version} 版</span>
      </li>)}</ul> : <p className="mt-1">没有与此事件直接关联的版本化事实。</p>}
    </section>

    <section>
      <h4 className="font-story text-sm text-ink">当时可见的居民知识</h4>
      {detail.visibleKnowledge.length ? <ul className="mt-1 space-y-1">{detail.visibleKnowledge.map(item => <li key={item.factId} className="rounded-lg bg-white/80 px-2.5 py-2">
        <span className="font-medium text-ink">{item.recipientName ?? '居民'} · {item.topic}</span>
        <span className="ml-1 rounded-full bg-[#e8eee5] px-1.5 py-0.5 text-[10px]">{item.certainty === 'fact' ? '事实' : '传闻'}</span>
        {item.content && <p className="mt-1 whitespace-pre-wrap text-ink-soft">{item.content}</p>}
      </li>)}</ul> : <p className="mt-1">当前记录无法还原居民知识内容。</p>}
    </section>

    <section>
      <h4 className="font-story text-sm text-ink">当时状态</h4>
      {detail.reconstruction.status === 'complete'
        ? <><p className="mt-1">已重建到 {formatWorldTime(detail.reconstruction.simTime ?? detail.event.simTime, timeZone)} · 版本 {detail.reconstruction.version ?? '—'}</p>
          {detail.stateSnapshot.length > 0 && <ul className="mt-1 space-y-1">{detail.stateSnapshot.map((state, index) => <li key={(state.personName ?? 'resident') + '-' + index} className="rounded-lg bg-white/80 px-2.5 py-2">
            <span className="font-medium text-ink">{state.personName ?? '居民'}</span>
            <span> · {[state.location, state.activity, state.mood].filter(Boolean).join(' · ') || '没有可展示的状态字段'}</span>
          </li>)}</ul>}
          <p className="mt-1 text-[10px] text-ink-faint">可重建字段：{detail.reconstruction.completeDomains.join('、') || '无'}</p>
        </>
        : <p className="mt-1">该时点无法完整重建：{detail.reconstruction.reason ?? '来源记录不足。'}</p>}
    </section>

    <section>
      <h4 className="font-story text-sm text-ink">可能相关与未知</h4>
      <p className="mt-1">系统没有足够的直接来源来证明其他记录与此事件有关。时间接近本身不代表因果。</p>
      {detail.gaps.length > 0 && <ul className="mt-1 list-disc space-y-1 pl-4">{detail.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul>}
    </section>

    {detail.forkAvailable && <button type="button" onClick={() => onForkAtMoment(detail.event.simTime, '围绕“' + detail.event.title + '”探索另一种可能')}
      className="w-full rounded-lg bg-ink px-3 py-2 text-xs font-medium text-white" data-testid="fork-from-event">从这个时点探索另一种可能</button>}
  </div>
}
