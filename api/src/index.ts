import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authRoutes } from './auth/routes'
import { devRoutes } from './dev/routes'
import { personRoutes } from './persons/routes'
import { chatRoutes } from './chat/routes'
import { timelineRoutes } from './timelines/routes'
import { homeRoutes } from './home/routes'
import { engineRoutes } from './engine/routes'
import { worldsRoutes } from './worlds/routes'
import { publicRoutes } from './public/routes'

export interface Env {
  DB: D1Database
  ENVIRONMENT: string
  DEV_ADMIN_USERNAME?: string
  DEV_ADMIN_PASSWORD?: string
  LLM_BASE_URL: string
  LLM_API_KEY: string
  LLM_MODEL: string
  ENGINE_TICK_SECRET?: string
  WORLD_SPEED?: string
  TICK_CALL_CAP?: string
  DAILY_CALL_CAP?: string
  MEMORY_SUMMARY_THRESHOLD?: string
}

const app = new Hono<{ Bindings: Env }>()

app.use('/api/*', cors())

app.get('/api/health', (c) => c.json({ ok: true }))

app.route('/api/auth', authRoutes)
app.route('/api/dev', devRoutes)
app.route('/api/persons', personRoutes)
// 注意：chat/timeline 两个子应用挂在 /api 且带全局 authMiddleware，
// 后续新路由必须注册在它们之前，否则会被拦成 401
app.route('/api/engine', engineRoutes)
app.route('/api/worlds', worldsRoutes)
app.route('/api/public', publicRoutes)
app.route('/api', chatRoutes) // /persons/:id/conversations、/conversations/*
app.route('/api', timelineRoutes) // /persons/:id/fork*、/timelines/:id
app.route('/api/home', homeRoutes)

export default app
