import { Link, NavLink, Navigate, Outlet, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import type { ReactElement } from 'react'
import { apiFetch, clearToken, getToken } from './api/client'
import Login from './pages/Login'
import Home from './pages/Home'
import People from './pages/People'
import PersonCreate from './pages/PersonCreate'
import PersonDetail from './pages/PersonDetail'
import TimelineView from './pages/TimelineView'
import Worlds from './pages/Worlds'
import WorldCreate from './pages/WorldCreate'
import WorldView from './pages/WorldView'
import DemoLanding from './pages/DemoLanding'

function RequireAuth({ children }: { children: ReactElement }) {
  if (!getToken()) return <Navigate to="/login" replace />
  return children
}

/** 落地页分派：未登录 → 演示世界只读视图；已登录 → 首页 */
function Landing() {
  if (getToken()) return <Navigate to="/home" replace />
  return <DemoLanding />
}

function Layout() {
  const navigate = useNavigate()

  async function logout() {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // 本地无论如何都清理登录态
    }
    clearToken()
    navigate('/login', { replace: true })
  }

  const tabClass = ({ isActive }: { isActive: boolean }) =>
    `flex-1 py-2.5 text-center text-xs ${isActive ? 'font-medium text-ink' : 'text-ink-faint'}`

  return (
    <div className="flex h-screen flex-col bg-paper">
      {/* 顶栏：品牌 + 桌面导航 + 退出 */}
      <header className="flex items-center justify-between border-b border-ink-line bg-sheet px-4 py-3">
        <Link to="/home" className="font-story text-lg font-semibold tracking-tight text-ink">
          Possibility
        </Link>
        <nav className="hidden gap-5 text-sm text-ink-soft sm:flex">
          <NavLink to="/home" end className={({ isActive }) => (isActive ? 'font-medium text-ink' : '')}>
            首页
          </NavLink>
          <NavLink to="/worlds" className={({ isActive }) => (isActive ? 'font-medium text-ink' : '')}>
            世界
          </NavLink>
          <NavLink to="/people" className={({ isActive }) => (isActive ? 'font-medium text-ink' : '')}>
            人物
          </NavLink>
        </nav>
        <button onClick={logout} className="text-sm text-ink-faint hover:text-ink">
          退出
        </button>
      </header>

      {/* 内容 */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>

      {/* 移动端底栏（在 flex 流内，不遮挡内容） */}
      <nav className="flex border-t border-ink-line bg-sheet sm:hidden">
        <NavLink to="/home" end className={tabClass}>
          首页
        </NavLink>
        <NavLink to="/worlds" className={tabClass}>
          世界
        </NavLink>
        <NavLink to="/people" className={tabClass}>
          人物
        </NavLink>
        <NavLink to="/people/new" className={tabClass}>
          ＋ 创建
        </NavLink>
      </nav>
    </div>
  )
}

/** 世界视图包装：从路由参数取 worldId */
function WorldViewRoute() {
  const { id } = useParams()
  if (!id) return <Navigate to="/worlds" replace />
  return (
    <div className="h-full">
      <WorldView worldId={id} />
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Landing />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/home" element={<Home />} />
        <Route path="/people" element={<People />} />
        <Route path="/people/new" element={<PersonCreate />} />
        <Route path="/people/:id" element={<PersonDetail />} />
        <Route path="/timelines/:id" element={<TimelineView />} />
        <Route path="/worlds" element={<Worlds />} />
        <Route path="/worlds/new" element={<WorldCreate />} />
        <Route path="/worlds/:id" element={<WorldViewRoute />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
