import { useState } from 'react'
import type { TimelineInfo } from '../../api/types'

interface Props {
  timelines: TimelineInfo[]
  currentTimelineId: string
  onSwitch: (timelineId: string) => void
  onFork: () => void
  onArchive: (timelineId: string) => void
}

/** 时间线切换器：列表 + Fork 入口（活跃线上限 3）+ 归档 */
export default function TimelineSwitcher({ timelines, currentTimelineId, onSwitch, onFork, onArchive }: Props) {
  const [open, setOpen] = useState(false)
  const active = timelines.filter((t) => t.status === 'active')
  const current = timelines.find((t) => t.id === currentTimelineId)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg border border-ink-faint px-3 py-1.5 text-xs text-ink-soft hover:bg-paper-deep"
      >
        {current?.parentTimelineId === null ? '主线' : '分叉'} ▾
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 rounded-xl border border-ink-line bg-sheet p-2 shadow-lg">
          <ul className="max-h-56 space-y-1 overflow-y-auto">
            {timelines.map((t) => (
              <li key={t.id}>
                <div
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${
                    t.id === currentTimelineId ? 'bg-paper-deep font-medium text-ink' : 'text-ink-soft hover:bg-paper-deep'
                  }`}
                >
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      onSwitch(t.id)
                      setOpen(false)
                    }}
                  >
                    <span className={`mr-1 rounded-full px-1.5 py-0.5 ${t.parentTimelineId === null ? 'bg-paper-deep text-ink-soft' : 'bg-woad-soft text-woad-deep'}`}>
                      {t.parentTimelineId === null ? '主线' : '分叉'}
                    </span>
                    <span className="text-ink-faint">{t.simNow.slice(0, 16).replace('T', ' ')}</span>
                    {t.status === 'archived' && <span className="ml-1 text-ink-faint">（已归档）</span>}
                  </button>
                  {t.status === 'active' && active.length > 1 && (
                    <button
                      onClick={() => {
                        onArchive(t.id)
                        setOpen(false)
                      }}
                      className="shrink-0 text-ink-faint hover:text-red-500"
                      title="归档这条时间线"
                    >
                      归档
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-2 border-t border-ink-line/60 pt-2">
            <button
              onClick={() => {
                onFork()
                setOpen(false)
              }}
              disabled={active.length >= 3}
              className="w-full rounded-lg bg-ink px-3 py-1.5 text-xs text-white disabled:bg-ink-faint"
            >
              {active.length >= 3 ? '活跃时间线已满（先归档一条）' : '从当前时刻 Fork'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
