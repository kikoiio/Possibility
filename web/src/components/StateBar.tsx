import type { PersonState } from '../api/types'

function formatSimTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 状态条：人物当前的时间/地点/活动/情绪（F9） */
export default function StateBar({ state }: { state: PersonState }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-ink-line bg-sheet px-4 py-2 text-xs text-ink-soft">
      <span className="whitespace-nowrap" title="时间">
        🕐 {formatSimTime(state.simTime)}
      </span>
      <span className="max-w-40 truncate" title={`地点：${state.location}`}>
        📍 {state.location}
      </span>
      <span className="max-w-48 truncate" title={`正在：${state.activity}`}>
        ⚡ {state.activity}
      </span>
      <span className="max-w-32 truncate" title={`情绪：${state.mood}`}>
        💭 {state.mood}
      </span>
    </div>
  )
}
