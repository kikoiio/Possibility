import type { WorldEvent } from '@possibility/voxel-contract'

/**
 * S3b 事件披露(F4):close 档点击事件打开的侧边详情面板。
 * 展示完整场景文本、参与者、时间窗;留痕事件标注「已落幕」。
 */

const TYPE_LABELS: Record<WorldEvent['type'], string> = {
  celebration: '庆典',
  daily: '日常',
  turning: '转折',
}

export interface EventPanelProps {
  event: WorldEvent | null
  /** 'trace' = 已落幕留痕;事件被关闭/缺失传 null event */
  phase: 'active' | 'trace'
  onClose: () => void
  /** S4 身份统一:personId → 显示名(缺省显示原 id) */
  personNames?: Record<string, string>
  /** S4 身份统一:点击参与者 = 选中居民(与渲染拾取同一联动出口) */
  onSelectPerson?: (personId: string) => void
}

export default function EventPanel({ event, phase, onClose, personNames, onSelectPerson }: EventPanelProps) {
  if (!event) return null
  const start = new Date(event.timeWindow.start)
  const end = new Date(event.timeWindow.end)
  const fmt = (d: Date) => d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return (
    <aside
      className="absolute right-3 top-3 flex w-72 flex-col gap-2 rounded bg-black/70 p-4 text-xs leading-5 text-zinc-200 shadow-lg"
      data-testid="event-panel"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-50" data-testid="event-panel-title">{event.label}</span>
          <span className="rounded bg-zinc-700/80 px-1.5 py-0.5 text-[10px] text-zinc-300">{TYPE_LABELS[event.type]}</span>
          {phase === 'trace' && (
            <span className="rounded bg-zinc-500/60 px-1.5 py-0.5 text-[10px] text-zinc-300" data-testid="event-panel-trace">已落幕</span>
          )}
        </div>
        <button
          type="button"
          aria-label="关闭事件详情"
          className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-100"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <p className="whitespace-pre-line text-zinc-200" data-testid="event-panel-scene">{event.scene}</p>
      {event.participants && event.participants.length > 0 && (
        <div data-testid="event-panel-participants">
          <span className="text-zinc-400">在场:</span>{' '}
          {event.participants.map((personId, index) => (
            <span key={personId}>
              {index > 0 && '、'}
              {onSelectPerson ? (
                <button
                  type="button"
                  data-testid={`event-panel-participant-${personId}`}
                  className="underline decoration-zinc-500 underline-offset-2 hover:text-zinc-50"
                  onClick={() => onSelectPerson(personId)}
                >
                  {personNames?.[personId] ?? personId}
                </button>
              ) : (
                personNames?.[personId] ?? personId
              )}
            </span>
          ))}
        </div>
      )}
      <div className="text-zinc-400" data-testid="event-panel-time">
        {fmt(start)} — {fmt(end)}
      </div>
    </aside>
  )
}
