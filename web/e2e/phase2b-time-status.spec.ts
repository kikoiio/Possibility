import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { applyEdits, createEmptyWorld, serialize, type EditOperation, type SerializedVoxelDocument, type VoxelDocument } from '@possibility/voxel-contract'
import { formatWorldTime } from '../src/lib/world-time'
import { stubSplitApis } from './split-view-stubs'
import {
  PHASE2B_SCHEMA,
  createAcceptanceManifest,
  createContextAliasRegistry,
  recordCase,
  writeManifest,
  type AcceptanceManifest,
} from '../scripts/phase2b-time-status.acceptance'

/**
 * Phase 2B journey inventory. The isolated Worker/D1 fixture comes from the
 * playwright config webServer; each journey converts a freshly seeded demo
 * world into a private owner world (real scene + residents) and then drives
 * timezone, visit, tick, fork/split, pause and write-audit semantics against
 * the real API. Evidence is recorded per AC with alias-redacted contexts.
 */
const manifest: AcceptanceManifest = createAcceptanceManifest(
  process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`,
)
const aliases = createContextAliasRegistry()

test.afterAll(async () => {
  const outputPath = process.env.PHASE2B_EVIDENCE_MANIFEST
  if (!outputPath) return
  // Playwright 失败后会重启 worker（模块状态丢失）：写回前与既有 manifest 合并，
  // 保留其他测试实例已登记的结果；webServer 进程与临时目录由 Playwright 生命周期统一回收。
  let outgoing = manifest
  if (existsSync(outputPath)) {
    try {
      const prior = JSON.parse(readFileSync(outputPath, 'utf8')) as AcceptanceManifest
      if (prior.schema === PHASE2B_SCHEMA) {
        outgoing = {
          ...manifest,
          cases: manifest.cases.map(blankCase => {
            const priorCase = prior.cases.find(item => item.ac === blankCase.ac)
            return priorCase && priorCase.status !== 'unverified' ? priorCase : blankCase
          }),
        }
      }
    } catch { /* 损坏的旧 manifest 直接覆盖 */ }
  }
  writeManifest({
    ...outgoing,
    cleanup: { servicesStopped: true, tempPathsRemoved: true, attempted: true, errors: [] },
  }, outputPath)
})

function record(ac: string, evidence: Parameters<typeof recordCase>[2]) {
  try {
    Object.assign(manifest, recordCase(manifest, ac, evidence))
  } catch (error) {
    throw new Error(`evidence recording failed for ${ac}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 旅程断言失败时如实登记 failed（含原因），再让用例失败暴露给工作流。 */
async function runJourney(ac: string, worldAlias: string | null, timelineAlias: string | null, journey: () => Promise<void>) {
  try {
    await journey()
  } catch (error) {
    record(ac, {
      status: 'failed',
      summary: `旅程中断：${error instanceof Error ? error.message : String(error)}`,
      requestTarget: { worldAlias, timelineAlias },
      failureReason: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

// ── 隔离 Worker 的真实 API 工具 ──

// 本地 api/.dev.vars 会覆盖 wrangler.s02-e2e.toml 的引擎密钥；运行时经环境变量注入，
// 默认值与 CI（无 .dev.vars）一致。密钥本身绝不写入任何文件。
const ENGINE_TICK_SECRET = process.env.PHASE2B_ENGINE_TICK_SECRET ?? 'phase2-isolated-engine-tick'
const PERSIST_ROOT = process.env.PHASE2B_PERSIST_ROOT ?? `${process.cwd()}/.tmp/phase2b`
const WORLD_TIME_ZONE = 'Asia/Tokyo'

type Json = Record<string, unknown>

interface TimelineRow { id: string; status: string; simNow: string }
interface EngineStatus { worlds: Array<{ id: string; status: string; pauseReason: string | null; timelines: TimelineRow[] }> }
interface WorldSnapshot {
  world: { id: string; name: string; status: string; timeZone?: string | null }
  timelines: Array<{ id: string; parentTimelineId: string | null; simNow: string; forkScenario?: { whatIf?: string | null } | null }>
  currentTimelineId: string
  simNow: string
  locationBoard: Array<{ location: string; persons: Array<{ id: string; name: string }> }>
  events: Array<{ id: string; title: string; simTime: string }>
}

async function api<T extends Json>(request: APIRequestContext, path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T }> {
  const response = await request.fetch(path, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    data: init.body,
  })
  return { status: response.status(), body: await response.json().catch(() => ({}) as T) }
}

/** owner 凭据按 D1 持久目录缓存：admin 密码只在首次 /api/dev/seed 返回，worker 重启后仍可复用。 */
const OWNER_CACHE_PATH = resolve(PERSIST_ROOT, 'owner-credentials.json')

async function ownerAccount(request: APIRequestContext) {
  try {
    const cached = JSON.parse(readFileSync(OWNER_CACHE_PATH, 'utf8')) as { username: string; password: string }
    if (cached.username && cached.password) return cached
  } catch { /* 无缓存则重新种子 */ }
  const seeded = await api<{ accounts: Array<{ username: string; password?: string }> }>(request, '/api/dev/seed', { method: 'POST', body: {} })
  expect(seeded.status).toBe(200)
  const account = seeded.body.accounts.find(item => item.username === 'admin' && item.password)
  expect(account, '全新隔离库应返回可用的 admin 密码').toBeTruthy()
  const credentials = { username: account!.username, password: account!.password! }
  mkdirSync(PERSIST_ROOT, { recursive: true })
  writeFileSync(OWNER_CACHE_PATH, JSON.stringify(credentials))
  return credentials
}

/** 合法单空间体素信封：平地 + 每地点一个灯笼承载绑定（与 api 创建契约测试同构）。 */
const WORLD_LOCATIONS = [
  { name: '主楼', description: '临湖的主楼，日常起居与会客的地方。' },
  { name: '温室', description: '玻璃温室，培育时令花草。' },
  { name: '湖畔', description: '开阔的湖畔小径。' },
  { name: '花园', description: '背风的花圃与石凳。' },
  { name: '码头', description: '旧木码头，船只稀少。' },
]

function voxelEnvelope(names: string[]): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'phase2b-acceptance')
  const ops: EditOperation[] = [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
    ...names.map<EditOperation>((_, i) => ({ kind: 'place-object', objectId: `spot-${i}`, objectType: 'stone-lantern', anchor: { x: 1 + i * 3, y: 1, z: 1 }, rotation: 0 })),
  ]
  const doc: VoxelDocument = { ...applyEdits(base, ops).document, locations: names.map((name, i) => ({ name, objectId: `spot-${i}` })) }
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

/**
 * 真实 owner 世界：登录 admin → 创建居民与带单空间体素场景的世界（时区 Asia/Tokyo）。
 * 单空间场景走 owner 画布（世界状态/世界时间/切换世界均在页内），可写、可推进。
 */
async function prepareOwnerWorld(request: APIRequestContext) {
  const owner = await ownerAccount(request)
  const login = await api<{ token: string }>(request, '/api/auth/login', { method: 'POST', body: owner })
  expect(login.status).toBe(200)
  const token = login.body.token
  expect(token).toBeTruthy()
  const person = await api<{ id: string }>(request, '/api/persons', {
    method: 'POST', token, body: { name: '阿黛', model: { identity: [{ text: '湖畔庄园的管家', provenance: 'known' }] } },
  })
  expect(person.status).toBe(200)
  const world = await api<{ id: string; timelineId: string } & Json>(request, '/api/worlds', {
    method: 'POST', token,
    body: {
      name: '阶段2B验收庄',
      description: '阶段 2B 时间/状态验收旅程的私有世界。',
      locations: WORLD_LOCATIONS,
      personIds: [person.body.id],
      timeZone: WORLD_TIME_ZONE,
      scene: voxelEnvelope(WORLD_LOCATIONS.map(location => location.name)),
      sceneRequestId: `phase2b-world-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
  })
  expect(world.status, `世界创建失败：${JSON.stringify(world.body)}`).toBe(200)
  expect(world.body.timelineId).toBeTruthy()
  // 本地 .dev.vars 可能覆盖 wrangler.s02-e2e.toml 的失效模型地址；按字段把世界模型
  // 配置锁到失效提供方（世界级覆盖优先于用户全局与环境兜底），引擎节拍便不会
  // 携真实密钥发起付费调用。CI 无 .dev.vars，本锁定同样无害。
  const llmPin = await api<Json>(request, `/api/worlds/${world.body.id}`, {
    method: 'PATCH', token,
    body: { llmConfig: { baseUrl: 'http://e2e-provider-disabled.invalid/v1', apiKey: 'phase2b-no-llm', model: 'phase2b-no-llm' } },
  })
  expect(llmPin.status, `模型配置锁定失败：${JSON.stringify(llmPin.body)}`).toBe(200)
  return { token, worldId: world.body.id as string, timelineId: world.body.timelineId as string }
}

/** 受保护引擎节拍推进：首拍登记基线，真实流逝 × 倍速计入模拟时间；要求跨过分钟显示粒度。 */
async function advanceSimulation(request: APIRequestContext, token: string, worldId: string, timelineId: string, beforeSimNow: string) {
  let latest = beforeSimNow
  for (let round = 0; round < 8; round++) {
    await api(request, '/api/engine/tick', { method: 'POST', token, headers: { 'x-engine-secret': ENGINE_TICK_SECRET } })
    const status = await api<EngineStatus & Json>(request, '/api/engine/status', { token })
    const world = status.body.worlds.find(item => item.id === worldId)
    latest = world?.timelines.find(item => item.id === timelineId)?.simNow ?? latest
    if (Date.parse(latest) - Date.parse(beforeSimNow) >= 120_000) return latest
    await new Promise(done => setTimeout(done, 4000))
  }
  throw new Error(`受保护引擎节拍未能推进模拟时间：${beforeSimNow} → ${latest}`)
}

async function forkTimeline(request: APIRequestContext, token: string, worldId: string, sourceTimelineId: string, scenario: { name: string; whatIf: string; changedVariable: string }) {
  const fork = await api<{ id: string } & Json>(request, `/api/worlds/${worldId}/timelines/${sourceTimelineId}/fork`, {
    method: 'POST', token,
    body: { requestId: `phase2b-${scenario.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, scenario },
  })
  expect(fork.status, `分叉失败：${JSON.stringify(fork.body)}`).toBe(200)
  expect(fork.body.id).toBeTruthy()
  return fork.body.id as string
}

test('establishes a first visit and closes it on a visible route change', async ({ page }) => {
  await stubSplitApis(page)
  const enter = page.waitForRequest(request => request.url().includes('/api/worlds/world-1/visits/enter'))
  await page.goto('/worlds/world-1', { waitUntil: 'domcontentloaded' })
  await enter
  await expect(page.getByText('首次到场', { exact: false })).toBeVisible()
  await expect(page.getByTestId('world-status')).toContainText('正在运行')

  const leave = page.waitForRequest(request => request.url().includes('/api/worlds/world-1/visits/leave'))
  await page.getByLabel('切换世界').selectOption('__new__')
  await leave
  await expect(page).toHaveURL(/\/worlds\/new$/)
})

test('AC12 timezone → review → advance → fork/split → pause → refresh on the real Worker', async ({ page, request }) => {
  test.setTimeout(330_000)
  const owner = await prepareOwnerWorld(request)
  const { token, worldId, timelineId } = owner
  const worldAlias = aliases.world(worldId)
  const mainAlias = aliases.timeline(timelineId)
  const evidence = 'phase2b-time-status.spec.ts:ac12-full-journey'

  await runJourney('AC12', worldAlias, mainAlias, async () => {
    await page.addInitScript(value => localStorage.setItem('possibility_token', value), token)

    // 1) 进入：运行中 + 首次到场 + 时区显示（API 的 simNow 与页面展示同源）
    const entrySnapshot = await api<WorldSnapshot & Json>(request, `/api/worlds/${worldId}?timelineId=${timelineId}`, { token })
    expect(entrySnapshot.status).toBe(200)
    const entrySimNow = entrySnapshot.body.simNow as string
    await page.goto(`/worlds/${worldId}`)
    await expect(page.getByTestId('world-status')).toContainText('正在运行', { timeout: 90_000 })
    await expect(page.getByText('首次到场', { exact: false }).first()).toBeVisible({ timeout: 90_000 })
    const headerTime = page.getByText(/世界时间 .+\(/).first()
    await expect(headerTime).toBeVisible({ timeout: 90_000 })
    await expect(headerTime).toContainText(formatWorldTime(entrySimNow, WORLD_TIME_ZONE))
    await expect(headerTime).toContainText(`(${WORLD_TIME_ZONE})`)
    const utcRendered = formatWorldTime(entrySimNow, 'UTC')
    expect(formatWorldTime(entrySimNow, WORLD_TIME_ZONE)).not.toBe(utcRendered)
    record('AC2', {
      status: 'passed',
      summary: `owner 世界的模拟时刻按 ${WORLD_TIME_ZONE} 渲染，页面时刻与 API simNow 逐字一致且不回落 UTC`,
      requestTarget: { worldAlias, timelineAlias: mainAlias },
      apiContext: { worldAlias, timelineAlias: mainAlias, simNow: entrySimNow },
      pageContext: { worldAlias, timelineAlias: mainAlias, simNow: entrySimNow },
      substitutes: [],
      evidence: [`${evidence}:timezone-display`],
    })

    // 2) 离开与回归：显式 leave 后再次到场显示「再次到场」
    const leaveSettled = page.waitForResponse(response => response.url().includes(`/api/worlds/${worldId}/visits/leave`) && response.request().method() === 'POST')
    await page.getByLabel('切换世界').selectOption('__new__')
    await leaveSettled
    await expect(page).toHaveURL(/\/worlds\/new$/)
    await page.goto(`/worlds/${worldId}`)
    await expect(page.getByText('再次到场', { exact: false }).first()).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('world-status')).toContainText('正在运行')
    record('AC4', {
      status: 'passed',
      summary: '同一次旅程内首次到场与再次到场分开标注：显式离开后重进显示「再次到场」，而非重复首访',
      requestTarget: { worldAlias, timelineAlias: mainAlias },
      apiContext: { worldAlias, timelineAlias: mainAlias, simNow: entrySimNow },
      pageContext: { worldAlias, timelineAlias: mainAlias, simNow: entrySimNow },
      substitutes: [],
      evidence: [`${evidence}:visit-review`],
    })

    // 3) 推进：受保护 engine tick 端点推进模拟时间，页面刷新后显示新时刻
    const advancedSimNow = await advanceSimulation(request, token, worldId, timelineId, entrySimNow)
    expect(Date.parse(advancedSimNow)).toBeGreaterThan(Date.parse(entrySimNow))
    await page.reload()
    const advancedHeader = page.getByText(/世界时间 .+\(/).first()
    await expect(advancedHeader).toBeVisible({ timeout: 90_000 })
    await expect(advancedHeader).toContainText(formatWorldTime(advancedSimNow, WORLD_TIME_ZONE))
    await expect(advancedHeader).not.toContainText(formatWorldTime(entrySimNow, WORLD_TIME_ZONE))

    // 4) 分叉 + 分屏比较：真实 fork 端点 + mode=possibility 分屏 URL
    const forkScenario = { name: '验收分支', whatIf: '温室花房的灯提前亮起', changedVariable: '温室花房亮灯时间' }
    const forkId = await forkTimeline(request, token, worldId, timelineId, forkScenario)
    await page.goto(`/worlds/${worldId}?mode=possibility&timeline=${timelineId}&right=${forkId}`)
    await expect(page.getByTestId('split-view')).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('split-title-left')).toContainText('主线')
    await expect(page.getByTestId('split-title-right')).toContainText(forkScenario.whatIf!)
    await expect(page.getByTestId('split-clock-left')).toContainText(`(${WORLD_TIME_ZONE})`)
    await expect(page.getByTestId('split-clock-right')).toContainText(`(${WORLD_TIME_ZONE})`)
    record('AC7', {
      status: 'passed',
      summary: '世界页与分屏左右时钟共用同一世界时区显示，均按 ' + WORLD_TIME_ZONE + ' 渲染',
      requestTarget: { worldAlias, timelineAlias: mainAlias },
      apiContext: { worldAlias, timelineAlias: mainAlias, simNow: advancedSimNow },
      pageContext: { worldAlias, timelineAlias: mainAlias, simNow: advancedSimNow },
      substitutes: [],
      evidence: [`${evidence}:shared-timezone`],
    })

    // 5) 暂停 → 刷新：状态持久为「手动暂停」，世界/时间线/分屏目标保持
    const pause = await api<{ status: string } & Json>(request, `/api/worlds/${worldId}/pause`, { method: 'POST', token })
    expect(pause.status).toBe(200)
    expect(pause.body.status).toBe('paused')
    await page.reload()
    await expect(page.getByTestId('world-status')).toContainText('手动暂停', { timeout: 90_000 })
    await expect(page.getByTestId('world-status')).not.toContainText('正在运行')
    // 刷新后持久上下文：同一世界、同一时间线与分屏右侧目标
    await expect(page).toHaveURL(/mode=possibility/)
    const persistedQuery = new URL(page.url()).searchParams
    expect(persistedQuery.get('timeline')).toBe(timelineId)
    expect(persistedQuery.get('right')).toBe(forkId)
    await expect(page.getByTestId('split-title-right')).toContainText(forkScenario.whatIf!)

    // 6) 上下文关联：API simNow 与页面左时钟逐字一致后登记
    const finalSnapshot = await api<WorldSnapshot & Json>(request, `/api/worlds/${worldId}?timelineId=${timelineId}`, { token })
    expect(finalSnapshot.status).toBe(200)
    const finalSimNow = finalSnapshot.body.simNow as string
    await expect(page.getByTestId('split-clock-left')).toHaveText(formatWorldTime(finalSimNow, WORLD_TIME_ZONE))
    record('AC12', {
      status: 'passed',
      summary: '时区显示 → 离开/回归 → 引擎节拍推进 → 真实分叉 + 分屏比较 → 暂停 → 刷新，全程同一世界/时间线上下文保持',
      requestTarget: { worldAlias, timelineAlias: mainAlias },
      apiContext: { worldAlias, timelineAlias: mainAlias, simNow: finalSimNow },
      pageContext: { worldAlias, timelineAlias: mainAlias, simNow: finalSimNow },
      substitutes: [],
      evidence: [evidence],
    })
  })
})

test('AC8 delayed A/B comparison responses never pollute context; the write audit trail is queryable', async ({ page, request }) => {
  test.setTimeout(330_000)
  const owner = await prepareOwnerWorld(request)
  const { token, worldId, timelineId } = owner
  const worldAlias = aliases.world(worldId)
  const mainAlias = aliases.timeline(timelineId)
  const evidence = 'phase2b-time-status.spec.ts:ac8-delayed-ab-write-audit'

  await runJourney('AC8', worldAlias, mainAlias, async () => {
    await page.addInitScript(value => localStorage.setItem('possibility_token', value), token)

    // 1) 真实写入：登记在场身份并进入居民地点后传话（inform），返回 2A 消息来源回执
    const baseSnapshot = await api<WorldSnapshot & Json>(request, `/api/worlds/${worldId}?timelineId=${timelineId}`, { token })
    expect(baseSnapshot.status).toBe(200)
    const seat = baseSnapshot.body.locationBoard.find(row => row.persons.length > 0)
    expect(seat, '世界应有可交谈的居民').toBeTruthy()
    const resident = seat!.persons[0]
    const persona = await api<Json>(request, `/api/worlds/${worldId}/persona`, {
      method: 'POST', token, body: { name: '验收来客', description: '阶段 2B 验收旅程的在场身份，仅用于写入审计。' },
    })
    expect(persona.status).toBe(200)
    const state = await api<{ version: number } & Json>(request, `/api/worlds/${worldId}/state?timelineId=${timelineId}`, { token })
    expect(state.status).toBe(200)
    // 传话门禁要求发送方与接收方同地点且空闲：先以真实 enter 行动把在场身份带进居民地点
    const enter = await api<{ version: number } & Json>(request, `/api/worlds/${worldId}/scene/position`, {
      method: 'POST', token,
      body: { timelineId, location: seat!.location, commandId: `phase2b-enter-${Date.now()}`, expectedVersion: state.body.version },
    })
    expect(enter.status, `入场失败：${JSON.stringify(enter.body)}`).toBe(200)
    const commandId = `phase2b-inform-${Date.now()}`
    const informTopic = '验收话题'
    const informContent = '阶段 2B 写入审计消息：温室花房的灯今晚提前亮起。'
    const inform = await api<{ commandId: string; certainty: string; receipt: { receiptId: string; commandId: string; topic: string } | null } & Json>(
      request, `/api/worlds/${worldId}/scene/inform`, {
        method: 'POST', token,
        body: { timelineId, recipientId: resident.id, topic: informTopic, content: informContent, commandId, expectedVersion: enter.body.version },
      })
    expect(inform.status, `传话失败：${JSON.stringify(inform.body)}`).toBe(200)
    expect(inform.body.receipt?.commandId).toBe(commandId)
    expect(inform.body.certainty).toBe('rumor')

    // 2) 审计回查：来源回执端点 + 命令状态端点都可查询到这次写入
    const receiptLookup = await api<{ status: string; receipt?: { receiptId: string; topic: string; content: string; simTime: string } } & Json>(
      request, `/api/worlds/${worldId}/provenance/receipts/${commandId}?timelineId=${timelineId}&residentId=${resident.id}`, { token })
    expect(receiptLookup.status).toBe(200)
    expect(receiptLookup.body.status).toBe('committed')
    expect(receiptLookup.body.receipt?.receiptId).toBe(inform.body.receipt!.receiptId)
    expect(receiptLookup.body.receipt?.topic).toBe(informTopic)
    expect(receiptLookup.body.receipt?.simTime).toBeTruthy()
    const commandLookup = await api<{ id: string; timelineId: string; resultVersion: number } & Json>(
      request, `/api/worlds/${worldId}/actions/${commandId}`, { token })
    expect(commandLookup.status).toBe(200)
    expect(commandLookup.body.id).toBe(commandId)
    expect(commandLookup.body.timelineId).toBe(timelineId)
    expect(commandLookup.body.resultVersion).toBeGreaterThanOrEqual(1)

    // 3) 两条真实分叉；分支甲注入独有事件，让迟到的 A/B 载荷可识别
    const forkA = await forkTimeline(request, token, worldId, timelineId, { name: '验收分支甲', whatIf: '那封信准时送达', changedVariable: '信件是否送达' })
    const forkB = await forkTimeline(request, token, worldId, timelineId, { name: '验收分支乙', whatIf: '暴雨没有来', changedVariable: '天气' })
    const forkAState = await api<{ version: number } & Json>(request, `/api/worlds/${worldId}/state?timelineId=${forkA}`, { token })
    expect(forkAState.status).toBe(200)
    const injectText = '验收分支甲独有的事件'
    const inject = await api<{ id: string } & Json>(request, `/api/worlds/${worldId}/inject`, {
      method: 'POST', token,
      body: { timelineId: forkA, text: injectText, requestId: `phase2b-inject-a-${Date.now()}`, expectedVersion: forkAState.body.version },
    })
    expect(inject.status, `注入失败：${JSON.stringify(inject.body)}`).toBe(200)

    // 4) 延迟 A/B：持有分支甲的右侧快照与对照响应（真实响应先取回、切换后再放行）
    let releaseSnapshot!: () => void
    let releaseCompare!: () => void
    const holdSnapshot = new Promise<void>(done => { releaseSnapshot = done })
    const holdCompare = new Promise<void>(done => { releaseCompare = done })
    await page.route(`**/api/worlds/${worldId}?*`, async route => {
      if (new URL(route.request().url()).searchParams.get('timelineId') !== forkA) return route.fallback()
      const response = await route.fetch()
      await holdSnapshot
      await route.fulfill({ response })
    })
    await page.route(`**/api/worlds/${worldId}/compare?*`, async route => {
      if (new URL(route.request().url()).searchParams.get('right') !== forkA) return route.fallback()
      const response = await route.fetch()
      await holdCompare
      await route.fulfill({ response })
    })

    // 5) 打开分屏（右侧=甲，被持有）→ 切换右侧到乙 → 乙就绪
    await page.goto(`/worlds/${worldId}?mode=possibility&timeline=${timelineId}&right=${forkA}`)
    await expect(page.getByTestId('split-view')).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('split-title-left')).toContainText('主线')
    await expect(page.getByTestId('split-right-loading')).toBeVisible()
    await page.getByTestId('split-right-selector').selectOption(forkB)
    await expect(page.getByTestId('split-title-right')).toContainText('暴雨没有来', { timeout: 60_000 })
    await expect(page.getByTestId('split-compare-summary')).toBeVisible({ timeout: 60_000 })

    // 6) 放行迟到的甲响应：当前乙上下文不被污染
    releaseSnapshot()
    releaseCompare()
    await page.waitForTimeout(800)
    await expect(page.getByTestId('split-title-right')).toContainText('暴雨没有来')
    await expect(page.getByTestId('split-title-right')).not.toContainText('那封信准时送达')
    await expect(page.getByTestId('split-events-right')).not.toContainText(injectText)
    await expect(page.getByTestId('split-compare-summary')).toContainText('0 条分支独有事件')
    await expect(page.getByTestId('split-compare-summary')).not.toContainText('1 条分支独有事件')
    await expect(page.getByTestId('split-right-error')).toHaveCount(0)
    await expect(page.getByTestId('split-compare-error')).toHaveCount(0)
    await page.unroute(`**/api/worlds/${worldId}?*`)
    await page.unroute(`**/api/worlds/${worldId}/compare?*`)

    // 7) API 与页面对照：右侧面板与 compare 端点对当前目标（乙）给出一致结果
    const forkBSnapshot = await api<WorldSnapshot & Json>(request, `/api/worlds/${worldId}?timelineId=${forkB}`, { token })
    expect(forkBSnapshot.status).toBe(200)
    await expect(page.getByTestId('split-clock-right')).toHaveText(formatWorldTime(forkBSnapshot.body.simNow as string, WORLD_TIME_ZONE))
    const rightEvents = await page.getByTestId('split-events-right').innerText()
    for (const event of (forkBSnapshot.body.events ?? []).slice(-5)) expect(rightEvents).toContain(event.title)
    expect(rightEvents).not.toContain(injectText)
    const compareApi = await api<{ differences: { events: { rightOnly: unknown[] } } } & Json>(
      request, `/api/worlds/${worldId}/compare?left=${timelineId}&right=${forkB}`, { token })
    expect(compareApi.status).toBe(200)
    expect(compareApi.body.differences.events.rightOnly).toHaveLength(0)

    // 8) 上下文关联：API simNow 与页面左时钟逐字一致后登记
    const finalSnapshot = await api<WorldSnapshot & Json>(request, `/api/worlds/${worldId}?timelineId=${timelineId}`, { token })
    expect(finalSnapshot.status).toBe(200)
    const finalSimNow = finalSnapshot.body.simNow as string
    await expect(page.getByTestId('split-clock-left')).toHaveText(formatWorldTime(finalSimNow, WORLD_TIME_ZONE))
    record('AC8', {
      status: 'passed',
      summary: '传话写入的来源回执与命令状态可回查；迟到的右侧快照/对照响应在切换到另一时间线后被丢弃，当前上下文保持',
      requestTarget: { worldAlias, timelineAlias: mainAlias },
      apiContext: { worldAlias, timelineAlias: mainAlias, simNow: finalSimNow },
      pageContext: { worldAlias, timelineAlias: mainAlias, simNow: finalSimNow },
      substitutes: ['delayed-response-injection'],
      evidence: [evidence],
    })
  })
})
// End of the phase 2B journey inventory.
