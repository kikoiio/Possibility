import { useState } from 'react'
import type { ForkScenario, TimelineInfo } from '../../api/types'

interface Props {
  timelines: TimelineInfo[]
  currentTimelineId: string
  onSwitch: (timelineId: string) => void
  onFork: (scenario: Pick<ForkScenario, 'whatIf' | 'changedVariable'>) => Promise<boolean>
  onArchive: (timelineId: string) => void
}

/** 时间线切换器：列表 + Fork 入口（活跃线上限 3）+ 归档 */
export default function TimelineSwitcher({ timelines, currentTimelineId, onSwitch, onFork, onArchive }: Props) {
  const [open, setOpen] = useState(false)
  const [forkOpen, setForkOpen] = useState(false)
  const [whatIf, setWhatIf] = useState('')
  const [changedVariable, setChangedVariable] = useState('')
  const [forkError, setForkError] = useState('')
  const [forking, setForking] = useState(false)
  const active = timelines.filter((t) => t.status === 'active')
  const current = timelines.find((t) => t.id === currentTimelineId)
  const depth = (id: string): number => {
    let n = 0
    let parent = timelines.find(t => t.id === id)?.parentTimelineId
    while (parent && n < timelines.length) { n++; parent = timelines.find(t => t.id === parent)?.parentTimelineId ?? null }
    return n
  }
  const ordered: TimelineInfo[] = []
  const seen = new Set<string>()
  const visit = (parentId: string | null) => {
    for (const t of timelines.filter(x => x.parentTimelineId === parentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (seen.has(t.id)) continue
      seen.add(t.id); ordered.push(t); visit(t.id)
    }
  }
  visit(null)
  for (const t of timelines) if (!seen.has(t.id)) ordered.push(t)

  const createFork = async () => {
    const scenario = { whatIf: whatIf.trim(), changedVariable: changedVariable.trim() }
    if (!scenario.whatIf || !scenario.changedVariable) {
      setForkError('请说明这条线的假设和唯一改变的条件。')
      return
    }
    setForkError('')
    setForking(true)
    try {
      if (await onFork(scenario)) setForkOpen(false)
    } finally {
      setForking(false)
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg border border-ink-faint px-3 py-1.5 text-xs text-ink-soft hover:bg-paper-deep"
      >
        {current?.parentTimelineId === null ? '主宇宙' : '平行宇宙'} ▾
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 rounded-xl border border-ink-line bg-sheet p-2 shadow-lg">
          <ul className="max-h-56 space-y-1 overflow-y-auto">
            {ordered.map((t) => (
              <li key={t.id}>
                <div
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${
                    t.id === currentTimelineId ? 'bg-paper-deep font-medium text-ink' : 'text-ink-soft hover:bg-paper-deep'
                  }`}
                >
                  <button
                    className="min-w-0 flex-1 text-left"
                    style={{ paddingLeft: `${depth(t.id) * 12}px` }}
                    onClick={() => {
                      onSwitch(t.id)
                      setOpen(false)
                    }}
                  >
                    <span className={`mr-1 rounded-full px-1.5 py-0.5 ${t.parentTimelineId === null ? 'bg-paper-deep text-ink-soft' : 'bg-woad-soft text-woad-deep'}`}>
                      {t.parentTimelineId === null ? '主宇宙' : '↳ 平行宇宙'}
                    </span>
                    <span className="text-ink-faint">{t.simNow.slice(0, 16).replace('T', ' ')}</span>
                    {t.status === 'archived' && <span className="ml-1 text-ink-faint">（已归档）</span>}
                    {t.parentTimelineId && <span className="block pt-1 text-[10px] text-ink-faint">源自 {t.parentTimelineId.slice(0, 8)} · {t.forkScenario?.whatIf ?? '在子宇宙中改变条件'}</span>}
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
                setOpen(false)
                setForkError('')
                setForkOpen(true)
              }}
              disabled={active.length >= 3}
              className="w-full rounded-lg bg-ink px-3 py-1.5 text-xs text-white disabled:bg-ink-faint"
            >
              {active.length >= 3 ? '活跃宇宙已满（先归档一条）' : '从当前时刻创造平行宇宙'}
            </button>
          </div>
        </div>
      )}
      {forkOpen && (
        <div role="dialog" aria-modal="true" aria-label="创建平行宇宙" className="absolute right-0 top-10 z-30 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-ink-line bg-sheet p-4 shadow-xl">
          <h2 className="text-sm font-semibold text-ink">创建平行宇宙</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-faint">从当前这个时刻复制世界。现在只记录假设；分叉后你再决定如何改变条件，源宇宙不会被改写。</p>
          <label className="mt-3 block text-xs text-ink-soft" htmlFor="fork-what-if">这条线要探索什么可能？</label>
          <textarea
            id="fork-what-if"
            value={whatIf}
            onChange={(event) => setWhatIf(event.target.value)}
            rows={2}
            maxLength={500}
            placeholder="例如：如果那封信在暴雨前送达，会发生什么？"
            className="mt-1 w-full rounded-lg border border-ink-line px-3 py-2 text-sm text-ink-soft focus:border-ink-faint focus:outline-none"
          />
          <label className="mt-3 block text-xs text-ink-soft" htmlFor="fork-changed-variable">准备改变的条件（只写一项）</label>
          <input
            id="fork-changed-variable"
            value={changedVariable}
            onChange={(event) => setChangedVariable(event.target.value)}
            maxLength={200}
            placeholder="例如：匿名信是否送达"
            className="mt-1 w-full rounded-lg border border-ink-line px-3 py-2 text-sm text-ink-soft focus:border-ink-faint focus:outline-none"
          />
          {forkError && <p role="alert" className="mt-2 text-xs text-red-600">{forkError}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setForkOpen(false)} disabled={forking} className="rounded-lg border border-ink-line px-3 py-1.5 text-xs text-ink-soft disabled:opacity-50">取消</button>
            <button type="button" onClick={() => void createFork()} disabled={forking} className="rounded-lg bg-ink px-3 py-1.5 text-xs text-white disabled:opacity-50">{forking ? '创建中…' : '记录条件并分叉'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
