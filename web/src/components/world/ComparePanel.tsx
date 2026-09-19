import { useEffect, useState } from 'react'
import { lifeApi } from '../../api/client'
import type { TimelineInfo } from '../../api/types'

interface Props { worldId: string; currentTimelineId: string; timelines: TimelineInfo[]; onClose: () => void }
interface Comparison { left: { id: string; simNow: string }; right: { id: string; simNow: string }; sharedForkOrigin: unknown; differences: { states: { personId: string; changes: {field:string;left:string|null;right:string|null}[]}[]; events: {shared: unknown[]; leftOnly: unknown[]; rightOnly: unknown[]} }; limitations: string[] }

export default function ComparePanel({ worldId, currentTimelineId, timelines, onClose }: Props) {
  const [left, setLeft] = useState(currentTimelineId)
  const [right, setRight] = useState(timelines.find(t => t.id !== currentTimelineId)?.id ?? currentTimelineId)
  const [data, setData] = useState<Comparison | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { if (left === right) { setData(null); return } let live = true; lifeApi.compare(worldId, left, right).then(v => { if (live) setData(v as Comparison) }).catch(e => { if (live) setError(e instanceof Error ? e.message : '对照失败') }); return () => { live = false } }, [worldId, left, right])
  const label = (id: string) => timelines.find(t => t.id === id)?.parentTimelineId ? '分叉' : '主线'
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" onClick={onClose}><section className="max-h-[84vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-ink-line bg-paper p-5 shadow-xl" onClick={e => e.stopPropagation()}>
    <div className="flex items-center justify-between"><div><h2 className="font-story text-lg text-ink">两种人生</h2><p className="mt-1 text-xs text-ink-faint">这里展示记录差异，不把差异冒充成因果证明。</p></div><button onClick={onClose} className="text-xs text-ink-faint">关闭</button></div>
    <div className="mt-4 grid grid-cols-2 gap-2"><label className="text-xs text-ink-faint">左侧<select value={left} onChange={e => setLeft(e.target.value)} className="mt-1 block w-full rounded-lg border border-ink-line bg-sheet px-2 py-1.5 text-xs text-ink">{timelines.map(t => <option key={t.id} value={t.id}>{label(t.id)} · {t.simNow.slice(0,16).replace('T',' ')}</option>)}</select></label><label className="text-xs text-ink-faint">右侧<select value={right} onChange={e => setRight(e.target.value)} className="mt-1 block w-full rounded-lg border border-ink-line bg-sheet px-2 py-1.5 text-xs text-ink">{timelines.map(t => <option key={t.id} value={t.id}>{label(t.id)} · {t.simNow.slice(0,16).replace('T',' ')}</option>)}</select></label></div>
    {left === right && <p className="py-12 text-center text-sm text-ink-faint">请选择两条不同的时间线。</p>}
    {error && <p className="mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
    {data && <div className="mt-5 space-y-4"><div className="grid grid-cols-3 gap-2 text-center text-xs"><div className="rounded-xl bg-sheet p-3"><span className="block text-ink-faint">共同事件</span><b className="mt-1 block text-lg text-ink">{data.differences.events.shared.length}</b></div><div className="rounded-xl bg-woad-soft p-3"><span className="block text-ink-faint">左线独有</span><b className="mt-1 block text-lg text-woad-deep">{data.differences.events.leftOnly.length}</b></div><div className="rounded-xl bg-cinnabar-soft p-3"><span className="block text-ink-faint">右线独有</span><b className="mt-1 block text-lg text-cinnabar-deep">{data.differences.events.rightOnly.length}</b></div></div><div><h3 className="mb-2 font-story text-sm text-ink-soft">人物状态差异</h3>{!data.differences.states.length && <p className="text-xs text-ink-faint">目前没有记录到状态差异。</p>}{data.differences.states.map(s => <article key={s.personId} className="mb-2 rounded-xl border border-ink-line bg-sheet px-3 py-2 text-xs"><p className="font-medium text-ink">人物 {s.personId.slice(0,8)}</p>{s.changes.map(c => <p key={c.field} className="mt-1 text-ink-soft"><span className="text-ink-faint">{c.field}：</span>{c.left ?? '—'} <span className="px-1 text-ink-faint">→</span> {c.right ?? '—'}</p>)}</article>)}</div><ul className="space-y-1 text-[11px] text-ink-faint">{data.limitations.map((x,i) => <li key={i}>· {x}</li>)}</ul></div>}
  </section></div>
}
