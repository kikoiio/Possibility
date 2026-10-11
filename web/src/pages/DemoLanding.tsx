import { useCallback, useEffect, useState } from 'react'
import { clearGuestToken, demoApi, getGuestToken, isGuestClaimPending, setGuestClaimPending, setGuestToken } from '../api/client'
import WorldCanvasPage from './WorldCanvasPage'

interface DemoSession {
  sessionId: string
  worldId: string
  timelineId: string
  generation: number
  expiresAt: string
  claimPending?: boolean
}
/** Guest landing and explicit recovery page. Starting a replacement is always a user action. */
export default function DemoLanding({ recoveryOnly = false }: { recoveryOnly?: boolean }) {
  const [demo, setDemo] = useState<DemoSession | null>(null)
  const [error, setError] = useState('')
  const [claimPending, setClaimPending] = useState(isGuestClaimPending())
  const [starting, setStarting] = useState(false)

  const load = useCallback(async () => {
    setError('')
    try {
      if (!getGuestToken()) {
        if (recoveryOnly) throw new Error('找不到原访客副本凭证。')
        const session = await demoApi.start()
        setDemo(session)
        setClaimPending(!!session.claimPending || isGuestClaimPending())
        return
      }
      const session = await demoApi.current()
      setDemo(session)
      setClaimPending(!!session.claimPending || isGuestClaimPending())
      if (session.claimPending) setGuestClaimPending(true)
    } catch (cause) {
      setClaimPending(isGuestClaimPending())
      setError(cause instanceof Error ? cause.message : '访客副本暂时无法恢复，请稍后重试')
    }
  }, [recoveryOnly])

  useEffect(() => { void load() }, [load])

  async function startNewExperience() {
    if (starting) return
    setStarting(true); setError('')
    const previousToken = getGuestToken()
    try {
      clearGuestToken()
      const session = await demoApi.start()
      setDemo(session)
      setClaimPending(!!session.claimPending)
    } catch (cause) {
      if (previousToken) setGuestToken(previousToken)
      setError(cause instanceof Error ? cause.message : '新的体验暂时无法创建，请稍后重试')
    } finally { setStarting(false) }
  }

  return (
    <div className="h-screen overflow-y-auto bg-paper">
      <main className="h-full min-h-0">
        {error && <div className="grid min-h-full place-items-center px-5 text-center text-sm text-red-700"><div className="max-w-sm">
          <p role="alert">{error}</p>
          {claimPending && <p className="mt-2 text-ink-soft">待保存副本凭证仍保留。请返回原副本继续恢复，或核实保存结果。</p>}
          <div className="mt-4 flex flex-wrap justify-center gap-4">
            <button onClick={() => void load()} className="underline">重试恢复</button>
            <a href="/login?claimDemo=1" className="underline">返回认领</a>
            <button onClick={() => void startNewExperience()} disabled={starting} className="underline disabled:opacity-50">{starting ? '创建中…' : '开始新体验'}</button>
          </div>
        </div></div>}
        {!error && !demo && <div className="grid h-full place-items-center text-sm text-ink-faint">加载中…</div>}
        {!error && demo && <WorldCanvasPage worldId={demo.worldId} readonly guest claimPending={claimPending} guestSession={demo} />}
      </main>
    </div>
  )
}
