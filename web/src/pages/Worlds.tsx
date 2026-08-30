import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { worldsApi } from '../api/client'
import type { WorldSummary } from '../api/types'

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  running: { text: '运行中', cls: 'bg-emerald-100 text-emerald-700' },
  paused: { text: '已暂停', cls: 'bg-paper-deep text-ink-soft' },
  capped: { text: '已达上限', cls: 'bg-red-100 text-red-700' },
}

/** 世界列表：本人全部世界 + 创建入口 */
export default function Worlds() {
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    worldsApi
      .list()
      .then((d) => setWorlds(d.worlds))
      .catch(() => setError('加载失败'))
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
        {worlds.map((w) => {
          const st = STATUS_LABEL[w.status] ?? STATUS_LABEL.paused
          return (
            <Link
              key={w.id}
              to={`/worlds/${w.id}`}
              className="block rounded-xl border border-ink-line bg-sheet px-4 py-3 hover:border-ink-faint"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium text-ink">{w.name}</span>
                {w.isDemo && <span className="rounded-full bg-cinnabar-soft px-2 py-0.5 text-xs text-cinnabar-deep">演示</span>}
                <span className={`rounded-full px-2 py-0.5 text-xs ${st.cls}`}>{st.text}</span>
                <span className="ml-auto text-xs text-ink-faint">{w.personCount} 个人物</span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-soft">{w.description}</p>
              <p className="mt-1 text-xs text-ink-faint">
                {w.simNow ? `世界时间 ${w.simNow.slice(0, 16).replace('T', ' ')}` : ''} · 今日调用 {w.callsToday}
              </p>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
