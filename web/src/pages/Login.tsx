import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { apiFetch, authApi, clearGuestToken, clearToken, demoApi, getGuestToken, setGuestClaimPending, setToken, ApiError } from '../api/client'

interface AuthResponse {
  token: string
  user: { id: string; username: string }
}

export default function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [currentUser, setCurrentUser] = useState<{ id: string; username: string } | null>(null)
  const [switchingAccount, setSwitchingAccount] = useState(false)
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const claiming = search.get('claimDemo') === '1'

  useEffect(() => {
    if (!claiming || !getGuestToken() || !localStorage.getItem('possibility_token')) return
    let active = true
    void authApi.me().then(result => { if (active) setCurrentUser(result.user) }).catch(() => {
      if (active) { clearToken(); setCurrentUser(null) }
    })
    return () => { active = false }
  }, [claiming])

  async function retryClaim(authenticatedUser?: { id: string; username: string }) {
    if (!getGuestToken()) {
      setError('找不到原访客副本凭证，请先返回副本恢复页面。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const account = authenticatedUser ?? (await authApi.me()).user
      setCurrentUser(account)
      const requestKey = 'possibility_guest_claim_request_id'
      const requestId = localStorage.getItem(requestKey) ?? crypto.randomUUID()
      localStorage.setItem(requestKey, requestId)
      const claimed = await demoApi.claim(requestId)
      clearGuestToken()
      setGuestClaimPending(false)
      localStorage.removeItem(requestKey)
      navigate(`/worlds/${encodeURIComponent(claimed.worldId)}`, { replace: true })
    } catch (claimError) {
      setGuestClaimPending(true)
      setError(`账号 ${authenticatedUser?.username ?? currentUser?.username ?? '已登录账号'} 的访客副本暂时无法保存：${claimError instanceof Error ? claimError.message : '请稍后重试'}`)
    } finally {
      setBusy(false)
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const res = await apiFetch<AuthResponse>(`/api/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      })
      setToken(res.token)
      setCurrentUser(res.user)
      if (claiming && getGuestToken()) {
        if (switchingAccount) {
          setSwitchingAccount(false)
          setError(`保存目标已切换为 ${res.user.username}。请确认后重试保存。`)
          return
        }
        await retryClaim(res.user)
        return
      }
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="w-full max-w-sm rounded-2xl bg-sheet p-8 shadow-sm">
        <h1 className="mb-1 text-2xl font-semibold text-ink">Possibility</h1>
        <p className="mb-6 text-sm text-ink-soft">What would you like to make possible?</p>

        {claiming && getGuestToken() && <div className="mb-4 rounded-lg bg-[#edf2ed] p-3 text-sm text-ink-soft">
          {currentUser ? <>当前保存目标账号：<strong className="text-ink">{currentUser.username}</strong></> : '登录后会将当前访客副本保存到该账号。'}
        </div>}

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-ink-soft" htmlFor="username">
              用户名
            </label>
            <input
              id="username"
              className="w-full rounded-lg border border-ink-faint px-3 py-2 text-base outline-none focus:border-ink-soft"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-ink-soft" htmlFor="password">
              密码
            </label>
            <input
              id="password"
              type="password"
              className="w-full rounded-lg border border-ink-faint px-3 py-2 text-base outline-none focus:border-ink-soft"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-ink py-2.5 text-white disabled:opacity-50"
          >
            {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册'}
          </button>
        </form>

        {claiming && currentUser && getGuestToken() && <div className="mt-3 space-y-2">
          <button type="button" disabled={busy} onClick={() => void retryClaim()} className="w-full rounded-lg bg-ink py-2.5 text-white disabled:opacity-50">{busy ? '正在保存…' : '重试保存'}</button>
          <button type="button" disabled={busy} onClick={() => { clearToken(); setCurrentUser(null); setSwitchingAccount(true); setError('请登录要保存到的目标账号。') }} className="w-full rounded-lg border border-ink-line py-2 text-sm text-ink-soft disabled:opacity-50">切换账号</button>
        </div>}

        <button
          className="mt-4 w-full text-center text-sm text-ink-soft underline"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login')
            setError('')
          }}
        >
          {mode === 'login' ? '没有账号？注册一个' : '已有账号？去登录'}
        </button>

        <Link
          to={claiming ? '/demo/recover' : '/'}
          className="mt-3 block w-full text-center text-sm text-ink-faint transition hover:text-ink"
        >
          ← {claiming ? '返回原访客副本' : '返回演示世界'}
        </Link>
      </div>
    </div>
  )
}
