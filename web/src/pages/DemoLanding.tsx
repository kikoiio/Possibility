import { useEffect, useState } from 'react'
import { clearGuestToken, demoApi, getGuestToken, isGuestClaimPending, setGuestClaimPending } from '../api/client'
import WorldCanvasPage from './WorldCanvasPage'

/** 访客落地页（F16）：免登录直接进入演示世界只读视图 */
export default function DemoLanding({ recoveryOnly = false }: { recoveryOnly?: boolean }) {
  const [demo, setDemo] = useState<{ worldId: string; timelineId: string } | null>(null)
  const [error, setError] = useState('')
  const [claimPending, setClaimPending] = useState(isGuestClaimPending())

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        if (recoveryOnly && !getGuestToken()) throw new Error('找不到原访客副本凭证。')
        let session
        if (getGuestToken()) {
          try { session = await demoApi.current() }
          catch (cause) {
            if (recoveryOnly || isGuestClaimPending()) throw cause
            clearGuestToken()
            session = await demoApi.start()
          }
        } else {
          if (recoveryOnly) throw new Error('找不到原访客副本凭证。')
          session = await demoApi.start()
        }
        if (session.claimPending) setGuestClaimPending(true)
        if (active) { setClaimPending(!!session.claimPending || isGuestClaimPending()); setDemo(session) }
      } catch (cause) {
        if (active) {
          setClaimPending(isGuestClaimPending())
          setError(cause instanceof Error ? cause.message : '访客副本暂时无法恢复，请稍后重试')
        }
      }
    })()
    return () => { active = false }
  }, [recoveryOnly])

  return (
    <div className="h-screen overflow-hidden bg-paper">
      <main className="h-full min-h-0">
        {error && <div className="grid h-full place-items-center text-center text-sm text-red-700"><div>{error}{claimPending && <p className="mt-2 text-ink-soft">待保存副本凭证仍保留。请稍后重试，或返回登录页重新保存。</p>}<div className="mt-3 flex justify-center gap-4"><button onClick={() => window.location.reload()} className="underline">重试恢复</button><a href="/login?claimDemo=1" className="underline">返回认领</a></div></div></div>}
        {!error && !demo && <div className="grid h-full place-items-center text-sm text-ink-faint">加载中…</div>}
        {!error && demo && <WorldCanvasPage worldId={demo.worldId} readonly guest claimPending={claimPending} />}
      </main>
    </div>
  )
}
