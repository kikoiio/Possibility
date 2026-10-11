import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, authApi, clearToken, demoApi, getGuestToken, setToken } from '../api/client'
import GuestClaimStatusPanel from '../components/guest/GuestClaimStatusPanel'
import { createGuestClaimFlow } from '../guest/claim-flow'
import { createGuestClaimStore, createInitialGuestClaimContext } from '../guest/claim-store'

type Account = { id: string; username: string }

export default function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [currentUser, setCurrentUser] = useState<Account | null>(null)
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const claiming = search.get('claimDemo') === '1'
  const store = useMemo(() => createGuestClaimStore(), [])
  const flow = useMemo(() => createGuestClaimFlow({ store }), [store])

  useEffect(() => () => flow.dispose(), [flow])
  useEffect(() => {
    if (!claiming || !getGuestToken()) return
    let active = true
    void (async () => {
      if (!flow.context) {
        try {
          const session = await demoApi.current()
          const context = createInitialGuestClaimContext({ sessionId: session.sessionId, worldId: session.worldId, generation: session.generation }, { guestToken: getGuestToken() })
          store.write(context)
          // The flow was created before the compatibility context existed; reload
          // its source through the same persisted store without starting a claim.
          flow.setAccount(null)
          await flow.refreshStatus()
        } catch { /* The recovery panel explains a missing source copy. */ }
      }
      if (localStorage.getItem('possibility_token')) {
        try {
          const account = (await authApi.me({ redirectOnUnauthorized: false })).user
          if (active) { setCurrentUser(account); flow.setAccount(account); void flow.refreshStatus() }
        } catch {
          if (active) { clearToken(); setCurrentUser(null); flow.setAccount(null) }
        }
      }
    })()
    return () => { active = false }
  }, [claiming, flow, store])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(''); setBusy(true)
    try {
      const response = mode === 'login'
        ? await authApi.login({ username, password })
        : await authApi.register({ username, password })
      setToken(response.token)
      setCurrentUser(response.user)
      flow.setAccount(response.user)
      if (claiming && getGuestToken() && flow.context) {
        await flow.afterAuthentication(response.user)
        const completedWorldId = flow.getState().completedWorldId
        if (completedWorldId) navigate(`/worlds/${completedWorldId}`, { replace: true })
        return
      }
      navigate('/', { replace: true })
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '网络错误，请重试')
    } finally { setBusy(false) }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4 py-6">
      <div className="w-full max-w-sm rounded-2xl bg-sheet p-8 shadow-sm">
        <h1 className="mb-1 text-2xl font-semibold text-ink">Possibility</h1>
        <p className="mb-6 text-sm text-ink-soft">What would you like to make possible?</p>
        {claiming && getGuestToken() && !currentUser && <div className="mb-4 rounded-lg bg-[#edf2ed] p-3 text-sm text-ink-soft">登录后会将当前访客副本保存到该账号。</div>}
        {claiming && currentUser && <div className="mb-4 rounded-lg bg-[#edf2ed] p-3 text-sm text-ink-soft">当前保存目标账号：<strong className="text-ink">{currentUser.username}</strong></div>}
        <form onSubmit={onSubmit} className="space-y-4">
          <div><label className="mb-1 block text-sm text-ink-soft" htmlFor="username">用户名</label><input id="username" className="w-full rounded-lg border border-ink-faint px-3 py-2 text-base outline-none focus:border-ink-soft" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required /></div>
          <div><label className="mb-1 block text-sm text-ink-soft" htmlFor="password">密码</label><input id="password" type="password" className="w-full rounded-lg border border-ink-faint px-3 py-2 text-base outline-none focus:border-ink-soft" value={password} onChange={event => setPassword(event.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required /></div>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={busy} className="w-full rounded-lg bg-ink py-2.5 text-white disabled:opacity-50">{busy ? '请稍候…' : mode === 'login' ? '登录' : '注册'}</button>
        </form>
        {claiming && currentUser && <GuestClaimStatusPanel
          flow={flow}
          onReturnGuest={() => navigate('/demo/recover')}
          onSwitchAccount={() => { clearToken(); setCurrentUser(null); setError('请登录要保存到的目标账号。'); flow.setAccount(null) }}
        />}
        <button className="mt-4 w-full text-center text-sm text-ink-soft underline" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}>{mode === 'login' ? '没有账号？注册一个' : '已有账号？去登录'}</button>
        <Link to={claiming ? '/demo/recover' : '/'} className="mt-3 block w-full text-center text-sm text-ink-faint transition hover:text-ink">← {claiming ? '返回原访客副本' : '返回演示世界'}</Link>
      </div>
    </div>
  )
}
