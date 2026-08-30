import type { TimelineEvent } from '../api/types'

interface EventStreamProps {
  events: TimelineEvent[]
  isFork: boolean
  streaming?: boolean
}

function formatSimTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })
}

/** 事件流：按时间排列的推演/经历事件（F11） */
export default function EventStream({ events, isFork, streaming }: EventStreamProps) {
  return (
    <div className="space-y-3">
      {isFork && (
        <p className="rounded-lg bg-woad-soft/60 px-3 py-2 text-center text-xs text-woad-deep">
          这是一种可能的发展，不是预测
        </p>
      )}
      {events.length === 0 && !streaming && (
        <p className="py-6 text-center text-sm text-ink-faint">这条时间线上还没有事件</p>
      )}
      <ol className="relative space-y-3 border-l-2 border-ink-line pl-4">
        {events.map((e) => (
          <li key={e.id} className="relative">
            <span className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full bg-ink-faint" />
            <p className="text-xs text-ink-faint">{formatSimTime(e.simTime)}</p>
            <p className="text-sm font-medium text-ink">{e.title}</p>
            <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink-soft">{e.description}</p>
          </li>
        ))}
      </ol>
      {streaming && (
        <p className="pl-4 text-xs text-ink-faint">
          正在推演<span className="animate-pulse">…</span>
        </p>
      )}
    </div>
  )
}
