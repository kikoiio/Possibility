import { useEffect, useState } from 'react'
import { lifeApi } from '../../api/client'
import type { TimelineInfo } from '../../api/types'

interface Props { worldId: string; currentTimelineId: string; timelines: TimelineInfo[]; onClose: () => void }
interface ForkEvidence {
  forkTimelineId: string; sourceTimelineId: string | null; sourceSimTime: string | null
  provenance: 'snapshot' | 'legacy'; sourceStateVersion: number | null; worldModelVersion: number | null
  scenario: { whatIf: string | null; startTime: string | null; changedVariable: string | null; participants: string[]; invariants: string[] } | null
}
interface StateEvidence { timelineId: string; simTime: string; updatedRealAt: string }
interface CompareEvent { id: string; simTime: string; title: string; description: string }
interface Comparison {
  left: { id: string; simNow: string }; right: { id: string; simNow: string }
  timeAlignment: 'same_sim_time' | 'different_sim_times'
  sharedForkOrigin: { timelineId: string; leftFork: ForkEvidence | null; rightFork: ForkEvidence | null } | null
  differences: {
    states: { personId: string; changes: {field:string;left:string|null;right:string|null;leftEvidence:StateEvidence|null;rightEvidence:StateEvidence|null}[]}[]
    facts: { key: string; left: { value: unknown; factId: string; version: number; simTime: string } | null; right: { value: unknown; factId: string; version: number; simTime: string } | null }[]
    worldModelVersions: { left: number | null; right: number | null }
    events: {shared: CompareEvent[]; leftOnly: CompareEvent[]; rightOnly: CompareEvent[]}
  }
  limitations: string[]
}

export default function ComparePanel({ worldId, currentTimelineId, timelines, onClose }: Props) {
  const [left, setLeft] = useState(currentTimelineId)
  const currentParentId = timelines.find(t => t.id === currentTimelineId)?.parentTimelineId
  const comparisonTarget = (currentParentId && timelines.some(t => t.id === currentParentId)
    ? currentParentId
    : timelines.find(t => t.id !== currentTimelineId)?.id) ?? currentTimelineId
  const [right, setRight] = useState(comparisonTarget)
  const [data, setData] = useState<Comparison | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { if (left === right) { setData(null); return } let live = true; lifeApi.compare(worldId, left, right).then(v => { if (live) setData(v as Comparison) }).catch(e => { if (live) setError(e instanceof Error ? e.message : '对照失败') }); return () => { live = false } }, [worldId, left, right])
  const label = (id: string) => timelines.find(t => t.id === id)?.parentTimelineId ? '分叉' : '主线'
  const fmt = (value: string | null | undefined) => value ? value.slice(0, 16).replace('T', ' ') : '未知'
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" onClick={onClose}><section className="max-h-[84vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-ink-line bg-paper p-5 shadow-xl" onClick={e => e.stopPropagation()}>
    <div className="flex items-center justify-between"><div><h2 className="font-story text-lg text-ink">两种人生</h2><p className="mt-1 text-xs text-ink-faint">这里展示记录差异，不把差异冒充成因果证明。</p></div><button onClick={onClose} className="text-xs text-ink-faint">关闭</button></div>
    <div className="mt-4 grid grid-cols-2 gap-2"><label className="text-xs text-ink-faint">左侧<select value={left} onChange={e => setLeft(e.target.value)} className="mt-1 block w-full rounded-lg border border-ink-line bg-sheet px-2 py-1.5 text-xs text-ink">{timelines.map(t => <option key={t.id} value={t.id}>{label(t.id)} · {t.simNow.slice(0,16).replace('T',' ')}</option>)}</select></label><label className="text-xs text-ink-faint">右侧<select value={right} onChange={e => setRight(e.target.value)} className="mt-1 block w-full rounded-lg border border-ink-line bg-sheet px-2 py-1.5 text-xs text-ink">{timelines.map(t => <option key={t.id} value={t.id}>{label(t.id)} · {t.simNow.slice(0,16).replace('T',' ')}</option>)}</select></label></div>
    {left === right && <p className="py-12 text-center text-sm text-ink-faint">请选择两条不同的时间线。</p>}
    {error && <p className="mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
    {data && <div className="mt-5 space-y-4">
      <p className={`rounded-lg px-3 py-2 text-xs ${data.timeAlignment === 'same_sim_time' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
        {data.timeAlignment === 'same_sim_time' ? '两线已对齐到相同世界时间。' : '两线世界时间尚未对齐；以下只是各自当前状态，不能直接解释为同一时刻的结果。'}
      </p>
      <p className="text-xs text-ink-faint">共同祖先：{data.sharedForkOrigin?.timelineId.slice(0, 8) ?? '未知'} · 设定版本：左 {data.differences.worldModelVersions.left ?? '旧数据'} / 右 {data.differences.worldModelVersions.right ?? '旧数据'}</p>
      <section className="rounded-xl border border-ink-line bg-sheet p-3"><h3 className="font-story text-sm text-ink-soft">共同过去与分叉条件</h3>
        {data.sharedForkOrigin ? <div className="mt-2 space-y-3 text-xs text-ink-soft">{([['左线', data.sharedForkOrigin.leftFork], ['右线', data.sharedForkOrigin.rightFork]] as const).map(([side, fork]) => fork && <div key={fork.forkTimelineId} className="border-t border-ink-line/60 pt-2 first:border-0 first:pt-0">
          <p className="font-medium text-ink">{side}分叉 · {fmt(fork.sourceSimTime)} · {fork.provenance === 'snapshot' ? `Checkpoint v${fork.sourceStateVersion ?? '?'}` : '旧分叉：历史证据不完整'}</p>
          {fork.scenario ? <><p className="mt-1">改变条件：{fork.scenario.changedVariable ?? fork.scenario.whatIf ?? '未记录'}{fork.scenario.whatIf && fork.scenario.whatIf !== fork.scenario.changedVariable ? `（${fork.scenario.whatIf}）` : ''}</p>
            {!!fork.scenario.participants.length && <p className="mt-1 text-ink-faint">相关人物：{fork.scenario.participants.join('、')}</p>}
            {!!fork.scenario.invariants.length && <p className="mt-1 text-ink-faint">保持不变：{fork.scenario.invariants.join('；')}</p>}</>
            : <p className="mt-1 text-ink-faint">未保存可核对的分叉条件。</p>}
        </div>)}</div> : <p className="mt-2 text-xs text-ink-faint">无法确认两条宇宙的共同分叉来源；不推断共同历史。</p>}
      </section>
      <div className="grid grid-cols-3 gap-2 text-center text-xs"><div className="rounded-xl bg-sheet p-3"><span className="block text-ink-faint">共同事件</span><b className="mt-1 block text-lg text-ink">{data.differences.events.shared.length}</b></div><div className="rounded-xl bg-woad-soft p-3"><span className="block text-ink-faint">左线独有</span><b className="mt-1 block text-lg text-woad-deep">{data.differences.events.leftOnly.length}</b></div><div className="rounded-xl bg-cinnabar-soft p-3"><span className="block text-ink-faint">右线独有</span><b className="mt-1 block text-lg text-cinnabar-deep">{data.differences.events.rightOnly.length}</b></div></div>
      <div className="grid gap-2 sm:grid-cols-3">{([['共同过去', data.differences.events.shared], ['左线独有', data.differences.events.leftOnly], ['右线独有', data.differences.events.rightOnly]] as const).map(([title, events]) => <section key={title} className="rounded-xl border border-ink-line bg-sheet p-3"><h3 className="text-xs font-medium text-ink-soft">{title}</h3>{events.length ? <ul className="mt-2 space-y-2">{events.slice(0, 4).map(event => <li key={event.id} className="text-[11px] text-ink-faint"><span className="text-ink-soft">{event.title}</span><br />{fmt(event.simTime)} · {event.id.slice(0, 8)}</li>)}</ul> : <p className="mt-2 text-[11px] text-ink-faint">暂无记录</p>}</section>)}</div>
      <div><h3 className="mb-2 font-story text-sm text-ink-soft">世界事实差异</h3>{!data.differences.facts.length && <p className="text-xs text-ink-faint">没有已记录的结构化事实差异；旧数据缺证据时不能据此断定完全相同。</p>}{data.differences.facts.map(f => <article key={f.key} className="mb-2 rounded-xl border border-ink-line bg-sheet px-3 py-2 text-xs"><p className="font-medium text-ink">{f.key}</p><p className="mt-1 text-ink-soft">左：{f.left ? JSON.stringify(f.left.value) : '未记录'} · 右：{f.right ? JSON.stringify(f.right.value) : '未记录'}</p><p className="mt-1 text-[11px] text-ink-faint">左证据：{f.left ? `${f.left.factId.slice(0, 8)} · v${f.left.version} · ${fmt(f.left.simTime)}` : '未记录'}<br />右证据：{f.right ? `${f.right.factId.slice(0, 8)} · v${f.right.version} · ${fmt(f.right.simTime)}` : '未记录'}</p></article>)}</div>
      <div><h3 className="mb-2 font-story text-sm text-ink-soft">人物状态差异</h3>{!data.differences.states.length && <p className="text-xs text-ink-faint">目前没有记录到状态差异。</p>}{data.differences.states.map(s => <article key={s.personId} className="mb-2 rounded-xl border border-ink-line bg-sheet px-3 py-2 text-xs"><p className="font-medium text-ink">人物 {s.personId.slice(0,8)}</p>{s.changes.map(c => <p key={c.field} className="mt-1 text-ink-soft"><span className="text-ink-faint">{c.field}：</span>{c.left ?? '—'} <span className="px-1 text-ink-faint">→</span> {c.right ?? '—'}<span className="block pl-10 text-[10px] text-ink-faint">左 {c.leftEvidence ? `${c.leftEvidence.timelineId.slice(0,8)} · ${fmt(c.leftEvidence.simTime)}` : '无证据'} / 右 {c.rightEvidence ? `${c.rightEvidence.timelineId.slice(0,8)} · ${fmt(c.rightEvidence.simTime)}` : '无证据'}</span></p>)}</article>)}</div>
      <ul className="space-y-1 text-[11px] text-ink-faint">{data.limitations.map((x,i) => <li key={i}>· {x}</li>)}</ul>
    </div>}
  </section></div>
}
