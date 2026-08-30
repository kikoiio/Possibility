import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { publicApi } from '../api/client'
import type { DemoInfo } from '../api/types'
import WorldView from './WorldView'

/** 访客落地页（F16）：免登录直接进入演示世界只读视图 */
export default function DemoLanding() {
  const [demo, setDemo] = useState<DemoInfo | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    publicApi
      .demo()
      .then(setDemo)
      .catch(() => setError('演示世界加载失败'))
  }, [])

  return (
    <div className="flex h-screen flex-col bg-paper">
      <header className="flex items-center justify-between border-b border-ink-line bg-sheet px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="font-story text-lg font-semibold tracking-tight text-ink">Possibility</span>
          <span className="text-xs tracking-widest text-ink-faint">平行世界</span>
        </div>
        <Link
          to="/login"
          className="rounded-xl bg-cinnabar px-4 py-1.5 text-sm text-white transition-colors hover:bg-cinnabar-deep"
        >
          登录，创建你的世界
        </Link>
      </header>
      <main className="min-h-0 flex-1">
        {error && <div className="p-8 text-center text-sm text-red-600">{error}</div>}
        {!error && !demo && <div className="p-8 text-center text-sm text-ink-faint">加载中…</div>}
        {!error && demo && <WorldView worldId={demo.id} readonly />}
      </main>
    </div>
  )
}
