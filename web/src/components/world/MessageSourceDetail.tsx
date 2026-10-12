import { useEffect, useState } from 'react'
import { provenanceApi } from '../../api/provenance'
import type { ProvenanceSnapshot } from '../../api/types'

interface Props {
  worldId: string
  timelineId: string
  residentId: string
  receiptId?: string
  topic?: string
}

export default function MessageSourceDetail({ worldId, timelineId, residentId, receiptId, topic }: Props) {
  const [snapshot, setSnapshot] = useState<ProvenanceSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const load = async () => {
    setError('')
    try {
      setSnapshot(await provenanceApi.evidence(worldId, { timelineId, residentId, receiptId, topic, limit: 50 }))
      setOpen(true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '来源暂时不可用') }
  }
  useEffect(() => { setSnapshot(null); setOpen(false); setError('') }, [worldId, timelineId, residentId, receiptId, topic])
  return <section className="mt-2 text-xs text-ink-soft">
    <button type="button" onClick={() => void (open ? setOpen(false) : load())} className="rounded-md border border-ink/15 px-2.5 py-1.5 font-medium">
      {open ? '收起来源' : '查看来源'}
    </button>
    {error && <p className="mt-2 text-red-700">{error}</p>}
    {open && snapshot && <div className="mt-2 space-y-2 rounded-lg bg-white/70 p-2.5">
      <p>{snapshot.completeness === 'complete' ? '来源范围完整' : '来源范围不完整，不能据此断言从未听过'}</p>
      {snapshot.records.length ? snapshot.records.map(record => <article key={record.evidenceId} className="border-t border-ink/10 pt-2 first:border-0 first:pt-0">
        <p className="font-medium">{record.topic} · {record.assertion.state === 'verified' ? '已有内容依据' : '尚未证实'}</p>
        <p className="mt-0.5">“{record.content}”</p>
        <p className="mt-0.5 text-[10px] text-ink-faint">{record.sender?.name ?? '来源未知'} · {record.reception.state === 'established' ? '有接收记录' : '接收记录待核实'}</p>
      </article>) : <p>当前范围没有可展示的传话记录。</p>}
      {snapshot.gaps.map(gap => <p key={gap} className="text-amber-700">{gap}</p>)}
    </div>}
  </section>
}
