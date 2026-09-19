import { useEffect, useState } from 'react'
import { lifeApi } from '../../api/client'
import type { CommitmentView, ReturnBrief } from '../../api/types'

interface Props { worldId: string; timelineId: string; onClose: () => void }
const label: Record<string, string> = { proposed: '等你决定', accepted: '已经约好', fulfilled: '如约完成', missed: '错过了', expired: '邀请已过期', declined: '已婉拒', explained: '已经解释' }

export default function LifePanel({ worldId, timelineId, onClose }: Props) {
  const [brief, setBrief] = useState<ReturnBrief | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => { lifeApi.returnBrief(worldId, timelineId).then(setBrief).catch(e => setError(e instanceof Error ? e.message : '归来回顾加载失败')) }, [worldId, timelineId])
  const act = async (c: CommitmentView, action: string) => {
    setBusy(c.id); setError('')
    try { await lifeApi.act(worldId, c.id, action); setBrief(await lifeApi.returnBrief(worldId, timelineId)) }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败') }
    finally { setBusy(null) }
  }
  const markSeen = async () => { if (brief?.cursor) await lifeApi.markSeen(worldId, timelineId, brief.cursor); onClose() }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" onClick={onClose}>
    <section className="max-h-[82vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-ink-line bg-paper p-5 shadow-xl" onClick={e => e.stopPropagation()}>
      <div className="mb-4 flex items-center justify-between"><div><h2 className="font-story text-lg text-ink">你不在的时候</h2><p className="mt-1 text-xs text-ink-faint">只显示已经写入世界的事实。</p></div><button onClick={onClose} className="text-xs text-ink-faint">关闭</button></div>
      {error && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
      {!brief && !error && <p className="py-12 text-center text-sm text-ink-faint">回到世界的门正在打开…</p>}
      {brief && <>
        {!brief.events.length && <p className="rounded-xl border border-dashed border-ink-line p-5 text-center text-sm text-ink-faint">你离开后，暂时没有新的动静。</p>}
        <div className="space-y-2">{brief.events.map(e => <article key={e.id} className="rounded-xl border border-ink-line bg-sheet px-3 py-2.5"><p className="text-[11px] text-ink-faint">{e.simTime.slice(5,16).replace('T',' ')}{e.actorName ? ` · ${e.actorName}` : ''}</p><p className="font-story text-sm font-semibold text-ink">{e.title}</p><p className="mt-1 text-xs leading-relaxed text-ink-soft">{e.description}</p></article>)}</div>
        {brief.commitments.length > 0 && <div className="mt-5"><h3 className="mb-2 font-story text-sm text-ink-soft">与你有关的约定</h3><div className="space-y-2">{brief.commitments.map(c => <article key={c.id} className="rounded-xl border border-ink-line bg-sheet px-3 py-2.5"><div className="flex justify-between gap-3"><div><p className="font-story text-sm text-ink">{c.title}</p><p className="mt-1 text-xs text-ink-faint">{c.personName} · {c.location} · {label[c.status] ?? c.status}</p></div>{c.status === 'proposed' && <div className="flex gap-1"><button disabled={busy===c.id} onClick={() => void act(c,'accept')} className="rounded bg-ink px-2 py-1 text-[11px] text-white">接受</button><button disabled={busy===c.id} onClick={() => void act(c,'decline')} className="rounded border border-ink-faint px-2 py-1 text-[11px] text-ink-soft">拒绝</button></div>}{c.status === 'accepted' && <button disabled={busy===c.id} onClick={() => void act(c,'fulfill')} className="rounded bg-woad px-2 py-1 text-[11px] text-white">赴约</button>}</div></article>)}</div></div>}
        <button onClick={() => void markSeen()} className="mt-5 w-full rounded-lg bg-ink px-4 py-2 text-xs text-white">看完了，记下这个时间点</button>
      </>}
    </section>
  </div>
}
