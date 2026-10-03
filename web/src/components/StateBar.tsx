import type { PersonState } from '../api/types'
import { formatWorldTime } from '../lib/world-time'

/** 状态条：人物当前的时间/地点/活动/情绪（F9） */
export default function StateBar({ state, timeZone }: { state: PersonState; timeZone?: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-ink-line bg-sheet px-4 py-2 text-xs text-ink-soft">
      <span className="whitespace-nowrap" title="时间">
        🕐 {formatWorldTime(state.simTime, timeZone)}
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
