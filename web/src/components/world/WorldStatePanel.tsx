import { useEffect, useState } from 'react'
import { lifeApi, worldsApi } from '../../api/client'
import type { CommitmentView, WorldSnapshot, WorldState } from '../../api/types'

interface Props { worldId: string; timelineId: string; snapshot: WorldSnapshot; readonly: boolean; refresh: number }

/** World state, not a prose event feed, is the primary observation surface. */
export default function WorldStatePanel({ worldId, timelineId, snapshot, readonly, refresh }: Props) {
  const [state, setState] = useState<WorldState | null>(null)
  const [error, setError] = useState('')
  const [commitments, setCommitments] = useState<CommitmentView[]>([])
  useEffect(() => {
    if (readonly) return
    let active = true
    worldsApi.state(worldId, timelineId).then(v => { if (active) { setState(v); setError('') } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : '状态加载失败') })
    lifeApi.returnBrief(worldId, timelineId).then(v => { if (active) setCommitments(v.commitments.filter(c => ['proposed', 'accepted', 'missed'].includes(c.status))) }).catch(() => {})
    return () => { active = false }
  }, [worldId, timelineId, readonly, refresh, snapshot.stateVersion])
  const environment = state?.current.filter(f => f.factType === 'environment') ?? snapshot.currentFacts.filter(f => f.factType === 'environment')
  const knowledge = state?.current.filter(f => f.factType === 'knowledge') ?? []
  const evidenceStatus = state?.evidenceStatus ?? snapshot.evidenceStatus ?? (snapshot.worldModelVersion == null ? 'legacy' : 'structured')
  return <section className="space-y-3">
    <div className="flex items-center justify-between"><h2 className="font-story text-lg text-ink">世界现在</h2><span className="text-xs text-ink-faint">{evidenceStatus === 'structured' ? `状态 v${state?.version ?? snapshot.stateVersion}` : '旧世界：部分历史无结构化证据'}</span></div>
    {error && <p className="text-xs text-red-600">{error}</p>}
    <p className="text-xs leading-relaxed text-ink-soft">{snapshot.world.description}</p>
    <div className="grid gap-2 sm:grid-cols-2">
      {snapshot.locationBoard.map(loc => <article key={loc.location} className="rounded-xl border border-ink-line bg-sheet p-3"><h3 className="text-sm font-medium text-ink">{loc.location}</h3><p className="mt-1 text-xs text-ink-soft">{loc.persons.length ? loc.persons.map(p => `${p.name}（${p.activity}）`).join('、') : '此刻无人'}</p></article>)}
    </div>
    {environment.length > 0 && <div className="rounded-xl border border-ink-line bg-sheet p-3"><h3 className="mb-2 text-sm font-medium text-ink">环境条件</h3>{environment.map(f => <p key={f.id} className="mt-1 text-xs text-ink-soft">{String(f.value.location ?? '全世界')} · {String(f.value.condition)}：{String(f.value.value)} <span className="text-ink-faint">（事实 v{f.version}）</span></p>)}</div>}
    {commitments.length > 0 && <div className="rounded-xl border border-ink-line bg-sheet p-3"><h3 className="mb-2 text-sm font-medium text-ink">未完成事项</h3>{commitments.map(c => <p key={c.id} className="mt-1 text-xs text-ink-soft">{c.personName} · {c.title} @{c.location} · {c.status === 'proposed' ? '待回应' : c.status === 'accepted' ? '已约定' : '待解释'}</p>)}</div>}
    {knowledge.length > 0 && <p className="text-xs text-ink-faint">已记录 {knowledge.length} 条居民获知信息；内容按个人知识边界使用，不作为公共传闻展示。</p>}
  </section>
}
