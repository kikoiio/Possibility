import { useEffect, useState } from 'react'
import { clearGuestToken, demoApi, getGuestToken } from '../api/client'
import WorldCanvasPage from './WorldCanvasPage'

/** 访客落地页（F16）：免登录直接进入演示世界只读视图 */
export default function DemoLanding() {
  const [demo, setDemo] = useState<{ worldId: string; timelineId: string } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const session = getGuestToken() ? await demoApi.current().catch(() => { clearGuestToken(); return demoApi.start() }) : await demoApi.start()
        if (active) setDemo(session)
      } catch { if (active) setError('雾影庄暂时无法准备，请稍后重试') }
    })()
    return () => { active = false }
  }, [])

  return (
    <div className="h-screen overflow-hidden bg-paper">
      <main className="h-full min-h-0">
        {error && <div className="grid h-full place-items-center text-sm text-red-700">{error}</div>}
        {!error && !demo && <div className="grid h-full place-items-center text-sm text-ink-faint">加载中…</div>}
        {!error && demo && <WorldCanvasPage worldId={demo.worldId} readonly guest />}
      </main>
    </div>
  )
}
