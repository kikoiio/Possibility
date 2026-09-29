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
import { chapterRoutes } from './chapters/routes'
import { memoryRoutes } from './memories/routes'
import { personaRoutes } from './persona/routes'
import { sceneRoutes } from './scene/routes'
import { publicRoutes } from './public/routes'
import { lifeRoutes } from './life/routes'
import { comparisonRoutes } from './life/compare'
import { scenesRoutes } from './scenes/routes'
import { mapRoutes } from './map/routes'
import { demoRoutes } from './demo/routes'
import { voxelRoutes } from './voxel/routes'
import { cleanupExpiredGuestData } from './demo/cleanup'
import { createDb } from './db/client'

export interface Env {
  DB: D1Database
  ENVIRONMENT: string
  DEV_ADMIN_USERNAME?: string
  DEV_ADMIN_PASSWORD?: string
  LLM_BASE_URL: string
  LLM_API_KEY: string
  LLM_MODEL: string
  /** Optional Cloudflare service binding for controlled provider routing. */
  LLM_PROVIDER?: Fetcher
  ENGINE_TICK_SECRET?: string
  WORLD_SPEED?: string
  TICK_CALL_CAP?: string
  DAILY_CALL_CAP?: string
  MEMORY_SUMMARY_THRESHOLD?: string
  PREWORLD_DAILY_CAP?: string
  IDLE_ARCHIVE_DAYS?: string
  DIRECTOR_LLM?: string
  RETRIEVAL_RECENT_FLOOR?: string
  RETRIEVAL_TOP_K?: string
  RETRIEVAL_SUMMARY_K?: string
  RETRIEVAL_W1?: string
  RETRIEVAL_W2?: string
  RETRIEVAL_W3?: string
  RETRIEVAL_HALF_LIFE_HOURS?: string
  RETRIEVAL_CANDIDATE_RECENT?: string
  RETRIEVAL_CANDIDATE_IMPORTANT?: string
  RETRIEVAL_CANDIDATE_MENTIONS?: string
  RETRIEVAL_CANDIDATE_ANNOTATED?: string
  /** Internal per-invocation fence; set only by runTick, never supplied by deployment config. */
  ENGINE_TICK_LEASE_TOKEN?: string
}

const app = new Hono<{ Bindings: Env }>()

app.use('/api/*', cors())

app.get('/api/health', (c) => c.json({ ok: true }))

app.route('/api/auth', authRoutes)
app.route('/api/dev', devRoutes)
app.route('/api/persons', personRoutes)
// Public sub-app has its own 404 fallback; mount before all /api-wide auth middleware.
app.route('/api/public', publicRoutes)
app.route('/api/demo', demoRoutes)
// 注意：chat/timeline 两个子应用挂在 /api 且带全局 authMiddleware，
// 后续新路由必须注册在它们之前，否则会被拦成 401
app.route('/api/engine', engineRoutes)
app.route('/api', voxelRoutes) // /api/voxel/*：体素 AI 编辑规划
app.route('/api', mapRoutes)
app.route('/api', scenesRoutes) // 世界画布：路由必须在 /worlds/:id 通用快照之前
// These routes accept either a login or a tightly scoped guest sandbox token.
app.route('/api', personaRoutes)
app.route('/api', sceneRoutes)
app.route('/api/worlds', worldsRoutes)
app.route('/api', chapterRoutes) // /worlds/:id/chapters、/chapters/:id
app.route('/api', memoryRoutes) // /memories/:id（校正/删除）
app.route('/api', lifeRoutes) // 归来回顾与承诺
app.route('/api', comparisonRoutes) // 时间线证据对照
app.route('/api', chatRoutes) // /persons/:id/conversations、/conversations/*
app.route('/api', timelineRoutes) // /persons/:id/fork*、/timelines/:id
app.route('/api/home', homeRoutes)

export default Object.assign(app, {
  scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext) {
    context.waitUntil(cleanupExpiredGuestData(createDb(env.DB)))
  },
})
