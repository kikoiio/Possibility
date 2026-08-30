import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, setToken, ApiError } from '../api/client'

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
  const navigate = useNavigate()

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

        <button
          className="mt-4 w-full text-center text-sm text-ink-soft underline"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login')
            setError('')
          }}
        >
          {mode === 'login' ? '没有账号？注册一个' : '已有账号？去登录'}
        </button>
      </div>
    </div>
  )
}
