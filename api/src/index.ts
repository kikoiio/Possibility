import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authRoutes } from './auth/routes'
import { devRoutes } from './dev/routes'
import { personRoutes } from './persons/routes'
import { chatRoutes } from './chat/routes'
import { timelineRoutes } from './timelines/routes'
import { homeRoutes } from './home/routes'
import { engineRoutes } from './engine/routes'
import { runTick } from './engine/tick'
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
import { settingsRoutes } from './settings/routes'
import { voxelRoutes } from './voxel/routes'
import { compatibilityRoutes } from './scenes/compatibility/routes'
import { cleanupExpiredGuestData } from './demo/cleanup'
import { createDb } from './db/client'
import { memoryRepairRoutes } from './admin/memory-repair-routes'
import { native2dRoutes } from './native2d/routes'

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
  /** Opt in to Cloudflare scheduled ticks; leave unset when the external pinger owns scheduling. */
  ENGINE_CRON_TICK?: string
  WORLD_SPEED?: string
  TICK_CALL_CAP?: string
  DAILY_CALL_CAP?: string
  MEMORY_SUMMARY_THRESHOLD?: string
  MEMORY_SUMMARY_L1_BATCH?: string
  MEMORY_SUMMARY_L2_THRESHOLD?: string
  MEMORY_SUMMARY_L2_BATCH?: string
  PREWORLD_DAILY_CAP?: string
  IDLE_ARCHIVE_DAYS?: string
  DIRECTOR_LLM?: string
  RETRIEVAL_RECENT_FLOOR?: string
  RETRIEVAL_TOP_K?: string
  RETRIEVAL_SUMMARY_FLOOR_PER_LEVEL?: string
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
  /** A1(B68): deterministic compatibility-fixture planner mode. Honored only when
   * ENVIRONMENT=s02-e2e; set solely by the isolated e2e launcher, never from HTTP bodies. */
  SCENE_COMPATIBILITY_FIXTURE?: string
  /** Only the isolated A1 browser launcher may enable a deterministic phone-chat reply. */
  A1_E2E_LIFE_FIXTURE?: string
}

const app = new Hono<{ Bindings: Env }>()
const GUEST_CLEANUP_CRON = '17 3 * * *'

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
app.route('/api', native2dRoutes)
app.route('/api', scenesRoutes) // 世界画布：路由必须在 /worlds/:id 通用快照之前
app.route('/api', compatibilityRoutes) // 场景兼容性检查、草稿与确认
// These routes accept either a login or a tightly scoped guest sandbox token.
app.route('/api', personaRoutes)
app.route('/api', sceneRoutes)
app.route('/api/worlds', worldsRoutes)
app.route('/api', chapterRoutes) // /worlds/:id/chapters、/chapters/:id
app.route('/api', memoryRoutes) // /memories/:id（校正/删除）
app.route('/api', lifeRoutes) // 归来回顾与承诺
app.route('/api', comparisonRoutes) // 时间线证据对照
app.route('/api/settings', settingsRoutes) // BYOK 与全局预算(F5/S3);须在 chat/timeline 全局鉴权之前
app.route('/api/admin', memoryRepairRoutes) // 管理员限定的居民记忆重建维护入口
app.route('/api', chatRoutes) // /persons/:id/conversations、/conversations/*
app.route('/api', timelineRoutes) // /persons/:id/fork*、/timelines/:id
app.route('/api/home', homeRoutes)

export default Object.assign(app, {
  scheduled(controller: ScheduledController, env: Env, context: ExecutionContext) {
    const engineCronEnabled = env.ENGINE_CRON_TICK === '1'
    const isGuestCleanupCron = controller.cron === GUEST_CLEANUP_CRON
    context.waitUntil((async () => {
      const db = createDb(env.DB)
      // Default deployments keep the daily cleanup trigger and leave engine
      // cadence to the external pinger. In opt-in mode, that trigger also
      // ticks the engine while additional cron expressions drive cadence.
      if (isGuestCleanupCron) {
        try { await cleanupExpiredGuestData(db) }
        catch (error) { console.error('[scheduled] guest cleanup failed:', error) }
      }
      // Continue after a cleanup failure; runTick owns the cross-Worker lease.
      if (engineCronEnabled) {
        try { await runTick(env, db) }
        catch (error) { console.error('[scheduled] engine tick failed:', error) }
      }
    })())
  },
})
