import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../api/client'
import type { HomeData } from '../api/types'

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export default function Home() {
  const [data, setData] = useState<HomeData | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    apiFetch<HomeData>('/api/home')
      .then(setData)
      .catch(() => setError('加载失败'))
  }, [])

  if (error) return <div className="p-8 text-center text-sm text-red-600">{error}</div>
  if (!data) return <div className="p-8 text-center text-sm text-ink-faint">加载中…</div>

  const activeTimelines = data.timelines.filter((t) => t.eventCount > 0)

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      {data.persons.length === 0 && (
        <div className="rounded-2xl border border-dashed border-ink-faint bg-sheet p-8 text-center">
          <p className="text-ink-soft">这里还空无一人。</p>
          <p className="mt-1 text-sm text-ink-faint">What would you like to make possible?</p>
          <Link
            to="/people/new"
            className="mt-4 inline-block rounded-xl bg-ink px-6 py-2.5 text-sm text-white"
          >
            创建第一个人物
          </Link>
        </div>
      )}

      {data.persons.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-ink-soft">最近的人物</h2>
          <div className="space-y-2">
            {data.persons.map((p) => (
              <Link
                key={p.id}
                to={`/people/${p.id}`}
                className="flex items-center justify-between rounded-xl border border-ink-line bg-sheet px-4 py-3"
              >
                <span className="font-medium text-ink">{p.name}</span>
                <span className="text-xs text-ink-faint">{relativeTime(p.lastActivity)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {data.worlds.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-ink-soft">运行中的世界</h2>
            <Link to="/worlds" className="text-xs text-ink-faint hover:text-ink">
              全部世界 →
            </Link>
          </div>
          <div className="space-y-2">
            {data.worlds.map((w) => (
              <Link
                key={w.id}
                to={`/worlds/${w.id}`}
                className="block rounded-xl border border-ink-line bg-sheet px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      w.status === 'running' ? 'bg-emerald-500' : w.status === 'capped' ? 'bg-red-400' : 'bg-ink-faint'
                    }`}
                  />
                  <span className="font-medium text-ink">{w.name}</span>
                  {w.isDemo && <span className="rounded-full bg-cinnabar-soft px-2 py-0.5 text-xs text-cinnabar-deep">演示</span>}
                  <span className="ml-auto text-xs text-ink-faint">{w.personCount} 人</span>
                </div>
                <p className="mt-1 text-xs text-ink-faint">
                  {w.simNow ? `世界时间 ${w.simNow.slice(0, 16).replace('T', ' ')}` : '尚未启动'} · 今日 {w.todayEventCount} 条事件
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {activeTimelines.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-ink-soft">继续运行的世界</h2>
          <div className="space-y-2">
            {activeTimelines.map((t) => (
              <Link
                key={t.id}
                to={`/timelines/${t.id}`}
                className="block rounded-xl border border-ink-line bg-sheet px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  {t.parentTimelineId === null ? (
                    <span className="rounded-full bg-paper-deep px-2 py-0.5 text-xs text-ink-soft">主线</span>
                  ) : (
                    <span className="rounded-full bg-woad-soft px-2 py-0.5 text-xs text-woad-deep">What-if</span>
                  )}
                  <span className="font-medium text-ink">{t.worldName}</span>
                  <span className="text-xs text-ink-faint">{t.personName}</span>
                </div>
                <p className="mt-1 text-xs text-ink-faint">
                  {t.eventCount} 条事件 · 世界时间 {t.simNow.slice(0, 16).replace('T', ' ')}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
