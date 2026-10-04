import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch, worldsApi } from '../api/client'
import type { PersonListItem, WorldSummary } from '../api/types'
import { formatWorldTime } from '../lib/world-time'
import { buildWorldDisambiguationItems, worldPersonLabel, worldStatusLabel } from '../lib/world-disambiguation'

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  running: { text: '运行中', cls: 'bg-emerald-100 text-emerald-700' },
  paused: { text: '已暂停', cls: 'bg-paper-deep text-ink-soft' },
  capped: { text: '已达上限', cls: 'bg-red-100 text-red-700' },
  archived: { text: '已归档', cls: 'bg-paper-deep text-ink-faint' },
}

/** 世界列表：本人全部世界 + 创建入口 */
export default function Worlds() {
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null)
  const [persons, setPersons] = useState<PersonListItem[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void Promise.all([worldsApi.list(), apiFetch<{ persons: PersonListItem[] }>('/api/persons')]).then(([worldResult, personResult]) => {
      if (!active) return
      setWorlds(worldResult.worlds)
      setPersons(personResult.persons)
    }).catch(() => {
      if (active) setError('加载失败，请稍后重试。')
      void worldsApi.list().then(({ worlds: items }) => { if (active) { setWorlds(items); setError('') } }).catch(() => {})
    })
    return () => { active = false }
  }, [])

  if (error) return <div className="p-8 text-center text-sm text-red-600">{error}</div>
  if (!worlds) return <div className="p-8 text-center text-sm text-ink-faint">加载中…</div>

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-base font-semibold text-ink">世界</h1>
        <Link to="/worlds/new" className="rounded-xl bg-ink px-4 py-2 text-sm text-white">
          创建世界
        </Link>
      </div>

      {worlds.length === 0 && (
        <div className="rounded-2xl border border-dashed border-ink-faint bg-sheet p-8 text-center">
          <p className="text-ink-soft">还没有世界。</p>
          <p className="mt-1 text-sm text-ink-faint">用一句话描述，就能让几个人物住进一个会自己运转的小世界。</p>
        </div>
      )}

      <div className="space-y-2">
        {buildWorldDisambiguationItems(worlds, persons).map((w) => {
          const st = STATUS_LABEL[w.status] ?? STATUS_LABEL.paused
          return (
            <article key={w.id} className="rounded-xl border border-ink-line bg-sheet px-4 py-3 hover:border-ink-faint">
              <Link to={`/worlds/${w.id}`} className="block rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{w.name}</span>
                  {w.isDemo && <span className="rounded-full bg-cinnabar-soft px-2 py-0.5 text-xs text-cinnabar-deep">演示</span>}
                  <span className={`rounded-full px-2 py-0.5 text-xs ${st.cls}`}>
                    {worldStatusLabel(w)}
                  </span>
                  <span className="ml-auto text-xs text-ink-faint">{w.personCount} 个人物</span>
                </div>
                <p className="mt-1 text-xs text-ink-soft">人物：{worldPersonLabel(w.personNames)}</p>
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-soft">{w.description}</p>
                <p className="mt-1 text-xs text-ink-faint">
                  创建于 {new Date(w.createdAt).toLocaleDateString('zh-CN')} · {w.simNow ? `世界时间 ${formatWorldTime(w.simNow, w.timeZone)}` : '尚无世界时间'} · 今日调用 {w.callsToday}
                </p>
              </Link>
              {!w.hasScene && (() => {
                const personId = w.personIds[0]
                const reason = '当前世界没有可用于补建场景的人物。'
                return personId ? (
                  <Link to={`/worlds/${encodeURIComponent(w.id)}/scene/repair`} className="mt-3 inline-flex rounded-lg border border-ink-faint px-3 py-1.5 text-xs font-medium text-ink-soft hover:border-ink-soft">
                    补建场景
                  </Link>
                ) : (
                  <div className="mt-3">
                    <button type="button" disabled title={reason} className="cursor-not-allowed rounded-lg border border-ink-line px-3 py-1.5 text-xs text-ink-faint opacity-70">补建场景</button>
                    {reason && <p className="mt-1 text-xs text-ink-faint">{reason}</p>}
                  </div>
                )
              })()}
            </article>
          )
        })}
      </div>
    </div>
  )
}
