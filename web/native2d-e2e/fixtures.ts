/**
 * N2D1 T48：浏览器读取夹具与拾取辅助。
 *
 * 供 native2d-desktop / native2d-mobile / native2d-live 三项目的 Playwright 用例
 * （T49–T53）消费。本文件只做轻量装配，不启动服务、不跑浏览器：
 *
 * 1. 公开响应夹具：把 T04 的固定 WorldReadModel 转成 WorldSnapshot 形态的
 *    公开 GET 响应体（身份与 PUBLIC_DEMO_SCOPE 对齐），覆盖刷新（地点变化 /
 *    stateVersion 递增）、读取失败（500 / 网络错误）、昼夜与未知时间用例。
 *    固定用例通过 Playwright route 拦截实现，不依赖运行中的 API。
 * 2. 隔离浏览器存储 context：每个用例干净的 localStorage；并支持向
 *    localStorage 预置指定记录（供 T51 损坏 / 不兼容记录用例）。
 * 3. 冻结 DOM testid 契约（TESTIDS）：页面任务 T42–T45 以此为准实现 DOM。
 * 4. 只读 objectBounds 拾取：视口内对象是 canvas 绘制，定位走开发限定挂钩
 *    window.__native2dDiagnostics（T36/T41 实现），读屏幕边界转可点击坐标。
 * 5. API 请求记录与只读断言：记录页面发出的所有 /api 请求（方法+URL），
 *    断言无任何写请求（POST/PUT/PATCH/DELETE）与模型调用。
 *
 * 约束：所有状态变化通过真实点击/输入/存储预置完成，本文件不提供任何
 * 直接修改控制器状态的入口。
 */

import type { Browser, BrowserContext, BrowserContextOptions, Page, Route } from '@playwright/test'

import {
  PUBLIC_DEMO_SCOPE,
  createFixtureReadModel,
} from '../src/native2d/fixtures'
import { ASSET_MANIFEST } from '../src/native2d/assets'
import type { SampleScope, ViewportDiagnostics, WorldReadModel } from '../src/native2d/types'
import type {
  DemoInfo,
  LocationBoardEntry,
  WorldFact,
  WorldSnapshot,
} from '../src/api/types'

/* =====================================================================
 * 1. 冻结 DOM testid 契约
 *
 * 页面任务 T42–T45 必须按本表实现 data-testid；用例 T49–T53 只通过本表定位。
 * 命名固定，任何改动都属于契约变更，须与页面 owner 协调。
 * =================================================================== */

export const TESTIDS = {
  /* 视口 host（canvas 容器；objectBounds 以此为坐标原点） */
  viewportHost: 'native2d-viewport',

  /* 来源与读取面（T42） */
  sourceLabel: 'native2d-source-label', // 当前来源/世界/时间线身份标签
  sourceKindFixture: 'native2d-source-fixture', // 选择固定来源
  sourceKindPublic: 'native2d-source-public', // 选择公开来源
  sourceFixtureSelect: 'native2d-source-fixture-select', // 固定用例下拉
  sourceApply: 'native2d-source-apply', // 切换来源
  refresh: 'native2d-refresh', // 手动刷新
  worldTime: 'native2d-world-time', // 世界时间文本
  worldTimeZone: 'native2d-world-timezone', // 世界时区文本
  stateVersion: 'native2d-state-version', // stateVersion 文本
  readStatus: 'native2d-read-status', // 读取状态（loading/ready/error）
  staleBadge: 'native2d-stale', // 陈旧标记（刷新失败保留旧画面）
  readError: 'native2d-read-error', // 无旧数据时的读取错误
  readRetry: 'native2d-read-retry', // 读取失败重试

  /* 居民（T42）：列表 + 事实信息卡 */
  residentList: 'native2d-resident-list',
  residentCard: 'native2d-resident-card',
  residentCardName: 'native2d-resident-name',
  residentCardLocation: 'native2d-resident-location', // 含 unknown/未提供内景说明
  residentCardActivity: 'native2d-resident-activity', // 活动原文

  /* 地点（T42）：列表 + 信息卡 */
  locationList: 'native2d-location-list',
  locationCard: 'native2d-location-card',
  locationCardDescription: 'native2d-location-description',

  /* 大厅往返与跟随（T42/T39） */
  hallEnter: 'native2d-hall-enter', // 大厅入口
  hallExit: 'native2d-hall-exit', // 返回外景
  spaceLabel: 'native2d-space-label', // 当前空间标签（外景/大厅）
  followToggle: 'native2d-follow-toggle', // 跟随开关/取消
  followStatus: 'native2d-follow-status', // 跟随意图状态（含暂停说明）
  overview: 'native2d-overview', // 返回全景

  /* 建筑编辑（T43） */
  buildingList: 'native2d-building-list', // 建筑选择列表
  moveStart: 'native2d-move', // 进入移动
  moveStatus: 'native2d-move-status', // 预览合法/非法状态
  conflictReasons: 'native2d-conflict-reasons', // 冲突原因提示
  moveApply: 'native2d-apply', // 应用
  moveCancel: 'native2d-cancel', // 取消预览
  undo: 'native2d-undo', // 逐步撤销
  saveStatus: 'native2d-save-status', // 未保存/保存失败状态
  saveRetry: 'native2d-save-retry', // 保存重试
  reset: 'native2d-reset', // 重置入口
  resetConfirm: 'native2d-reset-confirm', // 重置确认
  resetCancel: 'native2d-reset-cancel', // 重置取消

  /* 本地存档恢复（T43/T38）：损坏/不兼容记录的显式选择 */
  restoreStatus: 'native2d-restore-status', // damaged/incompatible/error 说明
  restoreRetry: 'native2d-restore-retry', // 读取异常重试
  restoreBaseline: 'native2d-restore-baseline', // 放弃旧记录使用初始布局
  restoreReset: 'native2d-restore-reset', // 清除损坏记录

  /* 视口故障与重试（T41/T36） */
  viewportError: 'native2d-viewport-error',
  viewportRetry: 'native2d-viewport-retry',
  assetError: 'native2d-asset-error',
  assetRetry: 'native2d-asset-retry',

  /* 移动端面板（T45）：信息卡/编辑面板展开收起 */
  panelToggle: 'native2d-panel-toggle',
  editPanelToggle: 'native2d-edit-panel-toggle',
} as const

export type TestId = (typeof TESTIDS)[keyof typeof TESTIDS]

/** 带身份的 testid 派生（列表项与来源选项）。 */
export const testId = {
  /** 固定来源下拉中的单个用例选项。 */
  fixtureOption: (fixtureId: string): string => `native2d-source-fixture-${fixtureId}`,
  /** 居民列表项。 */
  residentItem: (personId: string): string => `native2d-resident-${personId}`,
  /** 居民行内跟随按钮；选中居民时页面也提供兼容的单值 TESTIDS.followToggle。 */
  followToggle: (personId: string): string => `native2d-follow-toggle-${personId}`,
  /** 地点列表项（按真实地点名）。 */
  locationItem: (locationName: string): string => `native2d-location-${locationName}`,
  /** 建筑选择列表项。 */
  buildingItem: (buildingId: string): string => `native2d-building-${buildingId}`,
} as const

/* =====================================================================
 * 2. 只读诊断挂钩契约（T36 提供 onDiagnostics，T41 暴露到 window）
 *
 * 冻结：页面在开发/测试环境把最近一次 ViewportDiagnostics 挂到
 * window.__native2dDiagnostics —— 一个零参函数，调用返回最新快照。
 * objectBounds 的坐标是「视口 host 元素左上角为原点的 CSS 像素」，
 * 不是设备像素，也不是页面坐标。该挂钩只读，不提供任何状态修改入口。
 * =================================================================== */

export const DIAGNOSTICS_HOOK = '__native2dDiagnostics'

declare global {
  interface Window {
    __native2dDiagnostics?: () => ViewportDiagnostics | undefined
  }
}

/** 读取最近一次视口诊断；页面尚未产生诊断时返回 null。 */
export async function readDiagnostics(page: Page): Promise<ViewportDiagnostics | null> {
  return page.evaluate(() => {
    const hook = window.__native2dDiagnostics
    if (typeof hook !== 'function') return null
    return hook() ?? null
  })
}

export interface ScreenRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** 取某对象在视口 host 内的屏幕边界；不存在返回 null。 */
export async function getObjectScreenRect(page: Page, objectId: string): Promise<ScreenRect | null> {
  const diagnostics = await readDiagnostics(page)
  const rect = diagnostics?.objectBounds[objectId]
  return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
}

export interface PagePoint {
  readonly x: number
  readonly y: number
}

/**
 * 把对象的 host 内屏幕边界中心换算为页面坐标（可点击点）。
 * 对象未呈现或 host 不可见时返回 null；调用方可用 expect.poll 轮询。
 */
export async function getObjectClickPoint(page: Page, objectId: string): Promise<PagePoint | null> {
  const host = page.getByTestId(TESTIDS.viewportHost)
  const hostBox = await host.boundingBox()
  const rect = await getObjectScreenRect(page, objectId)
  if (!hostBox || !rect) return null
  const assetId = objectId.startsWith('building:') ? objectId.slice('building:'.length) : null
  const layer = assetId ? ASSET_MANIFEST[assetId]?.layers[0] : null
  if (layer && rect.width > 0) {
    const zoom = rect.width / layer.pixelWidth
    return {
      x: hostBox.x + rect.x + layer.anchorPx.x * zoom,
      y: hostBox.y + rect.y + layer.anchorPx.y * zoom,
    }
  }
  return {
    x: hostBox.x + rect.x + rect.width / 2,
    y: hostBox.y + rect.y + rect.height / 2,
  }
}

/** 通过 objectBounds 真实点击 canvas 内对象；对象不存在时抛错。 */
export async function clickViewportObject(page: Page, objectId: string): Promise<void> {
  const point = await getObjectClickPoint(page, objectId)
  if (!point) {
    throw new Error(`native2d 视口中找不到对象「${objectId}」的屏幕边界（diagnostics/objectBounds 缺失）`)
  }
  await page.mouse.click(point.x, point.y)
}

/* =====================================================================
 * 3. 公开响应夹具（WorldSnapshot 形态，身份与 T04 PUBLIC_DEMO_SCOPE 对齐）
 * =================================================================== */

export const PUBLIC_DEMO_PATH = '/api/public/demo'
export const publicWorldPath = (worldId: string): string => `/api/public/worlds/${worldId}`

/**
 * 把固定 WorldReadModel 转成模拟的公开 GET 响应体。
 * simNow 为 null 的未知时间用例以空字符串表示（适配层须视为未知时间）。
 */
export function buildPublicWorldSnapshot(model: WorldReadModel): WorldSnapshot {
  const simNow = model.simNow ?? ''
  const stateVersion = model.stateVersion ?? 0
  const located = model.residents.filter((r) => r.locationName !== null)

  const currentFacts: Omit<WorldFact, 'timelineId' | 'visibility'>[] = located.map((r) => ({
    id: `fact-location-${r.personId}`,
    version: stateVersion,
    simTime: simNow,
    factType: 'location',
    subjectId: r.personId,
    value: { location: r.locationName },
    sourceCommandId: 'native2d-e2e-fixture',
  }))

  const boardByLocation = new Map<string, { id: string; name: string; activity: string }[]>()
  for (const resident of located) {
    const key = resident.locationName as string
    const persons = boardByLocation.get(key) ?? []
    persons.push({
      id: resident.personId,
      name: resident.name,
      activity: resident.activity ?? '',
    })
    boardByLocation.set(key, persons)
  }
  const locationBoard: LocationBoardEntry[] = model.locations
    .filter((location) => boardByLocation.has(location.name))
    .map((location) => ({
      location: location.name,
      persons: boardByLocation.get(location.name) ?? [],
    }))

  return {
    world: {
      id: model.scope.worldId,
      name: model.worldName,
      description: '雾影庄公开演示世界（N2D1 浏览器夹具响应）。',
      status: 'running',
      pauseReason: null,
      isDemo: true,
      callsToday: 0,
      locations: model.locations.map((l) => ({ name: l.name, description: l.description })),
      timeZone: model.timeZone,
    },
    timelines: [
      {
        id: model.scope.timelineId,
        parentTimelineId: null,
        status: 'active',
        simNow,
        createdAt: '2026-01-01T00:00:00.000Z',
        forkScenario: null,
        timeZone: model.timeZone,
      },
    ],
    currentTimelineId: model.scope.timelineId,
    simNow,
    timeZone: model.timeZone,
    stateVersion,
    worldModelVersion: null,
    evidenceStatus: 'legacy',
    evidence: { level: 'unassessed', reasonCodes: [] },
    currentFacts,
    locationBoard,
    events: [],
  }
}

/** 以固定快照为底，改换 scope 与 stateVersion（公开响应身份对齐用）。 */
export function withScope(
  model: WorldReadModel,
  scope: SampleScope,
  stateVersion: number,
): WorldReadModel {
  return { ...model, scope, stateVersion }
}

/** 公开发现接口响应：指向 PUBLIC_DEMO_SCOPE 的雾影庄。 */
export function publicDemoDiscoveryResponse(): DemoInfo {
  return {
    id: PUBLIC_DEMO_SCOPE.worldId,
    name: '雾影庄',
    description: 'N2D1 浏览器夹具：公开演示发现响应。',
  }
}

/** 昼：13:00 JST，stateVersion 7（直接取自 T04 public-mist-manor-day）。 */
export function publicDayResponse(): WorldSnapshot {
  return buildPublicWorldSnapshot(createFixtureReadModel('public-mist-manor-day'))
}

/** 夜：23:00 JST，公开 scope，stateVersion 8（居民作息位置不同）。 */
export function publicNightResponse(): WorldSnapshot {
  return buildPublicWorldSnapshot(
    withScope(createFixtureReadModel('mist-manor-night'), PUBLIC_DEMO_SCOPE, 8),
  )
}

/**
 * 刷新后快照：同一公开 worldId/timelineId，stateVersion 9，
 * 多名居民地点变化，柊一成（person-hiiragi-kazunari）从快照消失。
 */
export function publicRefreshResponse(): WorldSnapshot {
  return buildPublicWorldSnapshot(
    withScope(createFixtureReadModel('mist-manor-refresh'), PUBLIC_DEMO_SCOPE, 9),
  )
}

/** 未知时间：simNow 缺失，stateVersion 10；表现层须把时间标为 unknown。 */
export function publicUnknownTimeResponse(): WorldSnapshot {
  return buildPublicWorldSnapshot(
    withScope(createFixtureReadModel('mist-manor-unknown-time'), PUBLIC_DEMO_SCOPE, 10),
  )
}

/* =====================================================================
 * 4. 公开 API route 拦截（固定用例不依赖运行中的 API）
 * =================================================================== */

export type PublicStubResponse =
  | { readonly kind: 'json'; readonly body: unknown; readonly status?: number }
  | { readonly kind: 'error'; readonly status: number; readonly message?: string }
  | { readonly kind: 'abort'; readonly errorCode?: string }

export interface PublicApiStubScript {
  /** /api/public/demo 的响应；缺省为 publicDemoDiscoveryResponse()。 */
  readonly demo?: PublicStubResponse
  /**
   * /api/public/worlds/:id 的响应序列：每次 GET 按序消费一条，
   * 序列耗尽后重复最后一条（刷新用例可写 [day, refresh, error...]）。
   */
  readonly worlds: readonly PublicStubResponse[]
}

async function fulfillStub(route: Route, response: PublicStubResponse): Promise<void> {
  if (response.kind === 'abort') {
    await route.abort(response.errorCode ?? 'failed')
    return
  }
  if (response.kind === 'error') {
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: JSON.stringify({ error: response.message ?? 'native2d 夹具错误响应' }),
    })
    return
  }
  await route.fulfill({
    status: response.status ?? 200,
    contentType: 'application/json',
    body: JSON.stringify(response.body),
  })
}

/**
 * 安装公开 API 拦截：
 * - `GET /api/public/demo` 与 `GET /api/public/worlds/:id` 按脚本响应；
 * - 其余 `/api/**` 请求一律 abort（固定用例不允许触碰真实 API，意外调用会立刻暴露）；
 * - 非 API 请求（静态素材等）照常继续。
 */
export async function installPublicApiStub(page: Page, script: PublicApiStubScript): Promise<void> {
  const demoResponse: PublicStubResponse = script.demo ?? {
    kind: 'json',
    body: publicDemoDiscoveryResponse(),
  }
  if (script.worlds.length === 0) {
    throw new Error('installPublicApiStub: worlds 响应序列不能为空')
  }
  let worldIndex = 0

  // Playwright 路由按注册的逆序匹配（后注册者优先），
  // 故兜底拦截必须最先注册，具体公开路径在其后注册才能生效。
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (!pathname.startsWith('/api/')) {
      await route.continue()
      return
    }
    await route.abort('failed')
  })

  await page.route('**/api/public/demo', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.abort('failed')
      return
    }
    await fulfillStub(route, demoResponse)
  })

  await page.route('**/api/public/worlds/*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.abort('failed')
      return
    }
    const entry = script.worlds[Math.min(worldIndex, script.worlds.length - 1)]
    worldIndex += 1
    await fulfillStub(route, entry)
  })
}

/* =====================================================================
 * 5. 隔离浏览器存储 context 与 localStorage 预置
 * =================================================================== */

export interface IsolatedSampleContext {
  readonly context: BrowserContext
  readonly page: Page
}

/**
 * 每个用例一个全新 context：localStorage 干净、无共享 cookie/缓存。
 * 用例结束须自行 `await context.close()`（或在 fixture 中包 afterEach）。
 */
export async function createIsolatedSampleContext(browser: Browser, options: BrowserContextOptions = {}): Promise<IsolatedSampleContext> {
  const context = await browser.newContext({ storageState: undefined, ...options })
  const page = await context.newPage()
  return { context, page }
}

/**
 * 向 localStorage 预置指定记录（T51 损坏/不兼容记录用例）。
 * 通过 addInitScript 实现：必须在 page.goto 之前调用，且在后续每次
 * 导航/刷新前都会重放，刷新后记录仍在（与真实用户存档语义一致）。
 */
export async function seedLocalStorage(page: Page, entries: Readonly<Record<string, string>>): Promise<void> {
  await page.addInitScript((records) => {
    for (const [key, value] of Object.entries(records)) {
      window.localStorage.setItem(key, value)
    }
  }, entries)
}

/** 读取当前页面 localStorage 全量记录（断言存档隔离/保留用）。 */
export async function readLocalStorage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {}
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (key !== null) out[key] = window.localStorage.getItem(key) ?? ''
    }
    return out
  })
}

/* =====================================================================
 * 6. API 请求记录与只读断言
 * =================================================================== */

export interface ApiRequestRecord {
  readonly method: string
  readonly url: string
  /** URL 路径部分（便于断言，不含 query）。 */
  readonly path: string
}

export interface ApiRequestRecorder {
  /** 已记录的 /api 请求快照（方法+URL），随页面请求实时增长。 */
  records(): readonly ApiRequestRecord[]
  /** 停止记录并解绑监听。 */
  stop(): void
}

/** 记录页面发出的所有 /api 请求（方法+URL）。 */
export function createApiRequestRecorder(page: Page): ApiRequestRecorder {
  const records: ApiRequestRecord[] = []
  const onRequest = (request: { method(): string; url(): string }): void => {
    const url = request.url()
    let path = url
    try {
      path = new URL(url).pathname
    } catch {
      /* 保留原始 url */
    }
    if (!path.startsWith('/api/')) return
    records.push({ method: request.method(), url, path })
  }
  page.on('request', onRequest)
  return {
    records: () => [...records],
    stop: () => {
      page.off('request', onRequest)
    },
  }
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** 找出全部写请求（POST/PUT/PATCH/DELETE）。 */
export function findWriteRequests(records: readonly ApiRequestRecord[]): ApiRequestRecord[] {
  return records.filter((r) => WRITE_METHODS.has(r.method.toUpperCase()))
}

/** 可能触发模型调用的路径模式（即使以 GET 出现也视为违规）。 */
export const MODEL_CALL_PATTERNS: readonly RegExp[] = [
  /\/api\/.*\/scene(\?|$)/i,
  /\/api\/.*\/chat/i,
  /\/api\/.*\/model/i,
  /\/api\/.*\/actions/i,
  /\/api\/.*\/fork/i,
]

/** 找出疑似模型调用请求。 */
export function findModelCallRequests(records: readonly ApiRequestRecord[]): ApiRequestRecord[] {
  return records.filter((r) => MODEL_CALL_PATTERNS.some((pattern) => pattern.test(r.path)))
}

/**
 * 只读断言：无任何写请求与模型调用。违规时抛出带明细的错误。
 * T49–T53 每个固定/真实用例收尾调用。
 */
export function assertReadOnlyApiRequests(records: readonly ApiRequestRecord[]): void {
  const writes = findWriteRequests(records)
  const modelCalls = findModelCallRequests(records)
  if (writes.length === 0 && modelCalls.length === 0) return
  const lines: string[] = []
  for (const r of writes) lines.push(`写请求: ${r.method} ${r.url}`)
  for (const r of modelCalls) lines.push(`模型调用: ${r.method} ${r.url}`)
  throw new Error(`native2d 样板只允许公开 GET 读取，检测到违规请求：\n${lines.join('\n')}`)
}
