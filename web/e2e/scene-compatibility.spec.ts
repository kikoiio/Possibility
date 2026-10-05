import { expect, test, type Page, type Locator } from '@playwright/test'

/**
 * A1 场景兼容真实持久 E2E（W28–W44，桌面项目 compatibility-desktop）。
 *
 * 环境：冻结 CLI 启动的隔离 API（scene-compatibility-legacy 数据模式，迁移 0000–0036
 * 旧资料 → 完整迁移 + 测试发布策略），前端独立 dev server；全部真实 HTTP，无 stub。
 *
 * 执行模型（workers=1，describe.serial）：本文件全部用例共享同一隔离 D1 持久目录，
 * 测试按声明顺序串行且相互有状态依赖，勿重排：
 *  - a1-legacy-world（旧单空间，invalid 可修复）的 repair-current 旅程只能确认一次：
 *    W32（取消）、W34（AI 闸门）必须在 W31（确认修复 → 当前转 valid）之前。
 *  - a1-legacy-spaces-world（旧双空间，hall invalid）同理：W33/W30 只诊断不确认，
 *    W38 才确认修复（并继续做原 AI 编辑）。
 *  - a1-legacy-world 的历史 v1 永远是 invalid → W36/W37/W39–W42 的 restore-history
 *    旅程（历史 → v1 → 恢复到此版本）可重复使用，不受一次性修复影响。
 *  - 版本号一律相对断言（N → N+1），不硬编码绝对版本：持久目录在多次运行间复用。
 *
 * 已知取舍（详见汇报）：W31/W33 的“手动编辑”走「世界」面板的风格预设（真实服务端
 * 整包预检），因为画布射线拾取坐标在 e2e 中不稳定；该路径不产生 voxel-edit-rejected
 * toast（blocked 由 WorldPanel 本地消化 + onEditBlocked 直接打开旅程），故不断言 toast。
 */

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

// ── W28：真实认证 / 世界选择 / 状态快照 / 网络故障辅助 ──────────────

const LEGACY_WORLD = 'a1-legacy-world' // 旧石灯庭院：单空间 invalid 可修复
const SECOND_WORLD = 'a1-second-world' // 对照世界：单空间 valid
const DEMO_WORLD = 'a1-demo-world' // 演示基线世界：valid，active baseline → 全员只读
const SPACES_WORLD = 'a1-legacy-spaces-world' // 旧双空间庭院：exterior valid + hall invalid

const OWNER = { username: 'a1-legacy-owner', password: 'a1-legacy-pass-7' }
const SECOND = { username: 'a1-second-owner', password: 'a1-second-pass-7' }

/** 真实登录页登录（无 token 绕过）。 */
async function login(page: Page, account: { username: string; password: string } = OWNER) {
  await page.goto('/login')
  await page.getByLabel('用户名').fill(account.username)
  await page.getByLabel('密码').fill(account.password)
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 30_000 })
}

/** 进入真实世界页；editor=true 时等体素编辑器装配完成（SwiftShader 较慢）。 */
async function enterWorld(page: Page, worldId: string, options: { editor?: boolean } = {}) {
  await page.goto(`/worlds/${worldId}`)
  await expect(page.getByTestId('scene-check-entry')).toBeVisible({ timeout: 120_000 })
  if (options.editor) await expect(page.getByTestId('voxel-editor-toolbar')).toBeVisible({ timeout: 120_000 })
}

/** 登录态请求头（page.request 直打真实 API 的第二客户端场景用）。 */
async function bearer(page: Page): Promise<Record<string, string>> {
  const token = await page.evaluate(() => localStorage.getItem('possibility_token'))
  if (!token) throw new Error('本地没有登录 token，请先 login()')
  return { Authorization: `Bearer ${token}` }
}

/** 真实路由快照：当前场景版本（未就绪视为 0）。 */
async function sceneVersion(page: Page, worldId: string): Promise<number> {
  const res = await page.request.get(`/api/worlds/${worldId}/scene`, { headers: await bearer(page) })
  expect(res.ok()).toBeTruthy()
  const body = await res.json() as { status: string; version?: number }
  return body.status === 'ready' ? body.version ?? 0 : 0
}

/** 真实路由快照：当前场景文档（可能为单空间或多空间信封）。 */
async function sceneDocument(page: Page, worldId: string): Promise<unknown> {
  const res = await page.request.get(`/api/worlds/${worldId}/scene`, { headers: await bearer(page) })
  expect(res.ok()).toBeTruthy()
  return (await res.json() as { document?: unknown }).document
}

/** 真实路由快照：场景历史行。 */
async function revisionRows(page: Page, worldId: string): Promise<Array<{ version: number; summary: string; kind: string }>> {
  const res = await page.request.get(`/api/worlds/${worldId}/scene/revisions`, { headers: await bearer(page) })
  expect(res.ok()).toBeTruthy()
  return (await res.json() as { revisions: Array<{ version: number; summary: string; kind: string }> }).revisions
}

/** 请求计数器（只观察，不拦截）。 */
function requestCounter(page: Page, pattern: string): () => number {
  let count = 0
  page.on('request', request => { if (request.url().includes(pattern)) count += 1 })
  return () => count
}

/**
 * 网络故障助手（W40/W41）：真实 confirm 请求到达服务端（可能已落库），
 * 仅丢弃浏览器侧响应——不构造任何假成功/失败载荷。
 */
async function dropNextConfirmResponse(page: Page) {
  let used = false
  await page.route('**/api/worlds/*/scene/compatibility/confirm', async route => {
    if (used) return route.continue()
    used = true
    await route.fetch() // 真实请求：服务端照实处理（落库或拒绝都由它决定）
    await route.abort() // 只丢弃响应，模拟网络故障
  })
}

/** 网络故障助手（W41）：结果查询延迟返回真实响应（转发，不改写）。 */
async function delayRequestQueries(page: Page, delayMs: number) {
  await page.route('**/api/worlds/*/scene/compatibility/requests/*', async route => {
    const response = await route.fetch()
    await new Promise(resolve => setTimeout(resolve, delayMs))
    await route.fulfill({ response })
  })
}

// ── 兼容旅程辅助 ────────────────────────────────────────────────

function compatDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: '场景兼容检查' })
}

/** 从「场景检查」入口打开当前场景诊断并等到 diagnosed。 */
async function openCurrentDiagnosis(page: Page): Promise<Locator> {
  await page.getByTestId('scene-check-entry').click()
  const dialog = compatDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('检查完成', { timeout: 30_000 })
  return dialog
}

/** diagnosed → 构建修复预览 → preview（变化清单与只读预览可见）。 */
async function buildRepairPreview(dialog: Locator) {
  await dialog.getByRole('button', { name: '构建修复预览' }).click()
  await expect(dialog).toContainText('修复预览', { timeout: 30_000 })
  await expect(dialog.getByRole('button', { name: '确认保存为新版本' })).toBeVisible()
}

/** 打开场景历史（单空间工具栏 / 多空间头部共用入口）。 */
async function openHistory(page: Page): Promise<Locator> {
  const entry = page.getByTestId('scene-history-entry')
  if (await entry.count()) await entry.click()
  else await page.getByRole('button', { name: '历史', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '场景历史' })
  await expect(dialog).toBeVisible()
  return dialog
}

/**
 * 历史 → v1（fixture 原始旧场景，永远 invalid）→ 恢复到此版本 →
 * 原 restore 不被调用，打开「恢复历史场景」兼容旅程并等到 diagnosed。
 */
async function startRestoreV1Journey(page: Page): Promise<Locator> {
  const history = await openHistory(page)
  const rowV1 = history.locator('li').filter({ hasText: '隔离 fixture 原始旧场景' })
  await expect(rowV1).toBeVisible({ timeout: 30_000 })
  await rowV1.getByRole('button', { name: '恢复到此版本' }).click()
  const dialog = compatDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('恢复历史场景')
  await expect(dialog).toContainText('历史版本 v1')
  await expect(dialog).toContainText('检查完成', { timeout: 30_000 })
  await expect(dialog).toContainText('发现阻断问题')
  return dialog
}

/** preview → 确认保存为新版本 → completed 回执。 */
async function confirmToCompleted(dialog: Locator, outcome: '场景修复' | '历史恢复') {
  await dialog.getByRole('button', { name: '确认保存为新版本' }).click()
  await expect(dialog).toContainText(new RegExp(`已保存为新版本 v\\d+（${outcome}）`), { timeout: 60_000 })
}

// ── W29：原始管理员演示基线诊断（只读） ──────────────────────────

test('原始演示基线只读诊断：demo 世界可查看完整有效诊断但不能提交修复', async ({ page }) => {
  await login(page)
  await enterWorld(page, DEMO_WORLD)
  // 基线只读：画布在，但没有任何编辑工具入口
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('voxel-editor-toolbar')).toHaveCount(0)

  const confirmCount = requestCounter(page, '/scene/compatibility/confirm')
  const dialog = await openCurrentDiagnosis(page)
  await expect(dialog).toContainText('修复当前场景')
  await expect(dialog).toContainText('检查结果：完整有效')
  await expect(dialog).toContainText('当前检查结果不能创建修复草稿。')
  await expect(dialog).toContainText('当前身份只能查看诊断，不能提交修复。')
  await expect(dialog.getByRole('button', { name: '构建修复预览' })).toHaveCount(0)
  await expect(dialog).toContainText('未确认前不会改动场景')
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  await expect(compatDialog(page)).toHaveCount(0)

  // 基线对照：active baseline 指向首版，诊断全程无任何写请求
  expect(await sceneVersion(page, DEMO_WORLD)).toBe(1)
  expect(await revisionRows(page, DEMO_WORLD)).toHaveLength(1)
  expect(confirmCount()).toBe(0)
})

// ── W44：边界与中文诊断（fixture 只有 valid / invalid-repairable 两种旧资料） ──

test('边界与中文诊断：有效与可修复旧资料的中文阶段、退出可操作且无后台轮询', async ({ page }) => {
  // 有效对照世界：完整有效，不开放修复草稿
  await login(page, SECOND)
  await enterWorld(page, SECOND_WORLD)
  let dialog = await openCurrentDiagnosis(page)
  await expect(dialog).toContainText('检查结果：完整有效')
  await expect(dialog).toContainText('全部空间已检查')
  await expect(dialog).toContainText('当前检查结果不能创建修复草稿。')
  await expect(dialog.getByRole('button', { name: '构建修复预览' })).toHaveCount(0)
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  await expect(compatDialog(page)).toHaveCount(0)

  // 可修复旧世界：中文阻断清单（既存问题来源）；关闭后无后台持续轮询
  await login(page, OWNER)
  await enterWorld(page, LEGACY_WORLD)
  dialog = await openCurrentDiagnosis(page)
  await expect(dialog).toContainText('检查结果：发现阻断问题')
  await expect(dialog).toContainText(/阻断问题（\d+ 条）/)
  await expect(dialog).toContainText('既存问题')
  await expect(dialog).toContainText('未确认前不会改动场景')
  const inspectionCount = requestCounter(page, '/scene/compatibility/inspection')
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  await expect(compatDialog(page)).toHaveCount(0)
  await page.waitForTimeout(1500)
  expect(inspectionCount()).toBe(0)
  // 缺口（如实记录）：fixture 无 unsupported / corrupt / incomplete 种子资料，
  // 这三种诊断分支与问题分页 hasMore 在本文件无法真实覆盖。
})

// ── W43：访客 401 / 他账号 404 / 私有草稿隔离 ────────────────────

test('权限与账号隔离：访客 401、他账号 404、私有草稿不可跨账号读取', async ({ page }) => {
  // 未登录访客：兼容接口一律 401
  expect((await page.request.get(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/inspection`)).status()).toBe(401)
  expect((await page.request.post(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/preflight`, {
    data: { candidate: { kind: 'operations', operations: [] } },
  })).status()).toBe(401)
  expect((await page.request.post(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/drafts`, {
    data: { draftRequestId: crypto.randomUUID(), purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 1 },
  })).status()).toBe(401)
  expect((await page.request.post(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/confirm`, {
    data: { draftId: 'x', requestId: 'x', expectedCurrentVersion: 1, expectedAttempt: 0 },
  })).status()).toBe(401)
  expect((await page.request.get(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/requests/some-request`)).status()).toBe(401)

  // 他账号（a1-second-owner 不拥有 a1-legacy-world）：一律 404，世界列表也不可见
  const secondLogin = await page.request.post('/api/auth/login', { data: SECOND })
  expect(secondLogin.ok()).toBeTruthy()
  const secondHeaders = { Authorization: `Bearer ${(await secondLogin.json() as { token: string }).token}` }
  expect((await page.request.get(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/inspection`, { headers: secondHeaders })).status()).toBe(404)
  expect((await page.request.post(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/preflight`, {
    headers: secondHeaders, data: { candidate: { kind: 'operations', operations: [] } },
  })).status()).toBe(404)
  expect((await page.request.post(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/drafts`, {
    headers: secondHeaders,
    data: { draftRequestId: crypto.randomUUID(), purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 1 },
  })).status()).toBe(404)
  expect((await page.request.get(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/requests/some-request`, { headers: secondHeaders })).status()).toBe(404)
  expect((await page.request.get(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/source/1/spaces/single`, { headers: secondHeaders })).status()).toBe(404)
  const worlds = await (await page.request.get('/api/worlds', { headers: secondHeaders })).json() as { worlds: Array<{ id: string }> }
  expect(worlds.worlds.some(world => world.id === LEGACY_WORLD)).toBe(false)

  // 物主真实草稿：跨账号读取 404，物主本人可读（须在 W31 修复前跑，世界仍为 invalid）
  await login(page, OWNER)
  const ownerHeaders = await bearer(page)
  const version = await sceneVersion(page, LEGACY_WORLD)
  const draftRes = await page.request.post(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/drafts`, {
    headers: ownerHeaders,
    data: { draftRequestId: crypto.randomUUID(), purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: version },
  })
  expect(draftRes.ok()).toBeTruthy()
  const draft = await draftRes.json() as { id: string }
  expect((await page.request.get(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/drafts/${draft.id}`, { headers: secondHeaders })).status()).toBe(404)
  expect((await page.request.get(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/drafts/${draft.id}`, { headers: ownerHeaders })).status()).toBe(200)
})

// ── W32：打开草稿未提交取消，场景与历史不变 ──────────────────────

test('取消未提交：打开修复草稿后关闭，版本与历史保持不变', async ({ page }) => {
  await login(page)
  await enterWorld(page, LEGACY_WORLD)
  const beforeVersion = await sceneVersion(page, LEGACY_WORLD)
  const beforeRows = (await revisionRows(page, LEGACY_WORLD)).length
  const confirmCount = requestCounter(page, '/scene/compatibility/confirm')

  const dialog = await openCurrentDiagnosis(page)
  await expect(dialog).toContainText('发现阻断问题')
  await buildRepairPreview(dialog)
  await expect(dialog).toContainText(/本次修复变化（\d+ 项）/)
  await expect(dialog).toContainText('预览为只读，不会触发编辑或自动保存。')

  // 未提交直接关闭：草稿不成为场景历史
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  await expect(compatDialog(page)).toHaveCount(0)
  expect(await sceneVersion(page, LEGACY_WORLD)).toBe(beforeVersion)
  expect((await revisionRows(page, LEGACY_WORLD)).length).toBe(beforeRows)
  expect(confirmCount()).toBe(0)
})

// ── W34：AI 编辑预检（模型前闸门 + 受控非法候选 B69 阻断） ──────────

test('AI编辑预检：旧无效场景模型前拒绝并自动打开修复旅程；受控非法候选被阻断且不落库', async ({ page }) => {
  // (a) 旧无效场景：模型前闸门 422 compatibility-required → 自动打开修复旅程，输入保留
  await login(page, OWNER)
  await enterWorld(page, LEGACY_WORLD, { editor: true })
  const legacyBefore = await sceneVersion(page, LEGACY_WORLD)
  await page.getByTestId('voxel-tool-ai').click()
  await page.getByTestId('voxel-ai-input').fill('在庭院里加一座石灯笼')
  await page.getByTestId('voxel-ai-preview').click()
  const aiError = page.getByTestId('voxel-ai-error')
  await expect(aiError).toContainText('场景兼容检查', { timeout: 30_000 })
  await expect(aiError).toContainText('当前场景存在既存问题，请先完成兼容修复')
  await expect(page.getByTestId('voxel-ai-input')).toHaveValue('在庭院里加一座石灯笼')
  await expect(page.getByTestId('voxel-ai-pending')).toHaveCount(0)
  const dialog = compatDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('检查完成', { timeout: 30_000 })
  await expect(dialog).toContainText('发现阻断问题')
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  expect(await sceneVersion(page, LEGACY_WORLD)).toBe(legacyBefore)
  // 说明：确定性 provider 的调用计数在服务端进程内，HTTP 侧不可读；闸门证据是
  // 422 compatibility-required 在模型配置解析之前返回（api/src/voxel/routes.ts）。

  // (b) 有效场景 + [fixture-branch:invalid-candidate]：操作级合法但完整校验失败 → 422，不落库
  await login(page, SECOND)
  await enterWorld(page, SECOND_WORLD, { editor: true })
  const secondBefore = await sceneVersion(page, SECOND_WORLD)
  await page.getByTestId('voxel-tool-ai').click()
  await page.getByTestId('voxel-ai-input').fill('[fixture-branch:invalid-candidate] 挖掉石灯脚下的支撑')
  await page.getByTestId('voxel-ai-preview').click()
  const planError = page.getByTestId('voxel-ai-error')
  await expect(planError).toContainText('规划', { timeout: 30_000 })
  await expect(planError).toContainText('改造结果未通过完整校验')
  await expect(compatDialog(page)).toHaveCount(0) // 编辑自身问题不打开修复旅程
  await expect(page.getByTestId('voxel-ai-pending')).toHaveCount(0)
  expect(await sceneVersion(page, SECOND_WORLD)).toBe(secondBefore)
})

// ── W33：有效空间手动编辑被另一空间既存缺陷整包阻断 ────────────────

test('手动多空间预检：在有效 exterior 编辑被 hall 既存缺陷整包阻断并打开修复旅程', async ({ page }) => {
  await login(page)
  await enterWorld(page, SPACES_WORLD, { editor: true })
  const before = await sceneVersion(page, SPACES_WORLD)

  // 真实编辑入口：「世界」面板风格预设（整包服务端预检；fixture 世界非参数化地形）
  await page.getByTestId('voxel-tool-world').click()
  await expect(page.getByTestId('voxel-terrain-none')).toBeVisible()
  await page.getByTestId('voxel-style-preset-bright-pastoral').click()

  // 整包校验发现 hall 的既存碰撞 → 不应用编辑，直接打开修复旅程
  const dialog = compatDialog(page)
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await expect(dialog).toContainText('检查完成', { timeout: 30_000 })
  await expect(dialog).toContainText('发现阻断问题')
  await expect(dialog).toContainText('空间 hall')
  await expect(dialog).toContainText('既存问题')
  await expect(dialog).toContainText('已检查空间')
  await expect(dialog).toContainText('exterior')
  // 当前编辑态与存储不变
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible()
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  expect(await sceneVersion(page, SPACES_WORLD)).toBe(before)
})

// ── W30：多空间旧世界从真实世界进入诊断（预览后取消，确认留给 W38/W45） ──

test('演示副本路径：多空间旧世界从真实世界进入诊断并展开修复预览', async ({ page }) => {
  await login(page)
  await enterWorld(page, SPACES_WORLD)
  const before = await sceneVersion(page, SPACES_WORLD)

  const dialog = await openCurrentDiagnosis(page)
  await expect(dialog).toContainText('修复当前场景')
  await expect(dialog).toContainText('检查结果：发现阻断问题')
  await expect(dialog).toContainText('空间 hall')

  await buildRepairPreview(dialog)
  await expect(dialog).toContainText(/本次修复变化（\d+ 项）/)
  // 空间 tab 与修复前/后 tab 都可切换；预览只读
  await dialog.getByRole('tab', { name: '老花房' }).click()
  await expect(dialog.getByRole('tab', { name: '老花房' })).toHaveAttribute('aria-selected', 'true')
  await dialog.getByRole('tab', { name: '修复前' }).click()
  await expect(dialog.getByRole('tab', { name: '修复前' })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByRole('tab', { name: '石灯外景' })).toBeVisible()
  await expect(dialog).toContainText('预览为只读，不会触发编辑或自动保存。')

  // 本用例不确认（多空间一次性修复确认由 W38/W45 覆盖），来源与历史保持不变
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  await expect(compatDialog(page)).toHaveCount(0)
  expect(await sceneVersion(page, SPACES_WORLD)).toBe(before)
})

// ── W31：用户自建旧单空间经真实编辑入口诊断并完成修复 ──────────────

test('用户自建旧场景经真实编辑入口（手动编辑被既存问题阻断）进入诊断并完成修复', async ({ page }) => {
  await login(page)
  await enterWorld(page, LEGACY_WORLD, { editor: true })
  const before = await sceneVersion(page, LEGACY_WORLD)
  const rowsBefore = (await revisionRows(page, LEGACY_WORLD)).length

  // 手动编辑入口：「世界」面板切换风格 → 服务端预检命中既存碰撞 → 不应用并打开旅程
  await page.getByTestId('voxel-tool-world').click()
  await expect(page.getByTestId('voxel-terrain-none')).toBeVisible()
  await page.getByTestId('voxel-style-preset-bright-pastoral').click()
  const dialog = compatDialog(page)
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await expect(dialog).toContainText('检查完成', { timeout: 30_000 })
  await expect(dialog).toContainText('发现阻断问题')
  await expect(dialog).toContainText('既存问题')

  // 预览明确确认：变化清单 + 只读前后预览（同一预览实例切修复前/后）
  await buildRepairPreview(dialog)
  await expect(dialog).toContainText(/本次修复变化（\d+ 项）/)
  await dialog.getByRole('tab', { name: '修复前' }).click()
  await expect(dialog.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 120_000 })
  await dialog.getByRole('tab', { name: '修复后' }).click()
  await expect(dialog).toContainText('预览为只读，不会触发编辑或自动保存。')
  await confirmToCompleted(dialog, '场景修复')

  // 新增一个有效当前版本；未涉及对象（石灯 fixture-keeper）保留
  expect(await sceneVersion(page, LEGACY_WORLD)).toBe(before + 1)
  expect((await revisionRows(page, LEGACY_WORLD)).length).toBe(rowsBefore + 1)
  expect(JSON.stringify(await sceneDocument(page, LEGACY_WORLD))).toContain('fixture-keeper')

  // 修复后的当前场景再次诊断：完整有效
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  const followUp = await openCurrentDiagnosis(page)
  await expect(followUp).toContainText('检查结果：完整有效')
  await followUp.getByRole('button', { name: '关闭兼容检查' }).click()
})

// ── W38：AI 原输入因旧场景进入独立修复，修复后就原意图重新规划 ──────

test('修复后继续原编辑：AI 原输入因旧场景进入独立修复，完成后可就原意图重新规划', async ({ page }) => {
  await login(page)
  await enterWorld(page, SPACES_WORLD, { editor: true })
  const before = await sceneVersion(page, SPACES_WORLD)
  const intent = '在外景加一座新石灯'

  // AI 规划命中模型前闸门：自动打开独立修复旅程，原输入保留在面板里
  await page.getByTestId('voxel-tool-ai').click()
  await page.getByTestId('voxel-ai-input').fill(intent)
  await page.getByTestId('voxel-ai-preview').click()
  await expect(page.getByTestId('voxel-ai-error')).toContainText('当前场景存在既存问题', { timeout: 30_000 })
  const dialog = compatDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('检查完成', { timeout: 30_000 })

  // 完成修复：这只是几何修复，不标记原 AI 编辑已保存
  await buildRepairPreview(dialog)
  await confirmToCompleted(dialog, '场景修复')
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  expect(await sceneVersion(page, SPACES_WORLD)).toBe(before + 1)
  expect(JSON.stringify(await sceneDocument(page, SPACES_WORLD))).not.toContain('fixture-plan-lantern')
  await expect(page.getByTestId('voxel-ai-input')).toHaveValue(intent)

  // 真实行为：修复确认后画布不会自动重取场景（引擎内仍是旧文档，重新规划会
  // 命中文档哈希不一致），真实用户路径是重进世界。按真实行为 reload 后续写原意图。
  await page.reload()
  await expect(page.getByTestId('scene-check-entry')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('voxel-editor-toolbar')).toBeVisible({ timeout: 120_000 })
  await page.getByTestId('voxel-tool-ai').click()
  await page.getByTestId('voxel-ai-input').fill(intent)
  await page.getByTestId('voxel-ai-preview').click()
  // 修复后的场景重新 preflight：原意图现在可以规划出预览
  await expect(page.getByTestId('voxel-ai-pending')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('voxel-ai-confirm').click()
  // 再确认原编辑才出现另一版（防抖保存 → 真实 commit）
  await expect.poll(() => sceneVersion(page, SPACES_WORLD), { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(before + 2)
  expect(JSON.stringify(await sceneDocument(page, SPACES_WORLD))).toContain('fixture-plan-lantern')
})

// ── W35：有效历史目标，预检后快速恢复为新版本 ──────────────────────

test('有效历史恢复：预检有效目标直接恢复为新增当前版本，原历史不变', async ({ page }) => {
  // 先用确定性 AI provider 在对照世界做出 v2（普通意图：空位放有支撑石灯）
  await login(page, SECOND)
  await enterWorld(page, SECOND_WORLD, { editor: true })
  const base = await sceneVersion(page, SECOND_WORLD)
  await page.getByTestId('voxel-tool-ai').click()
  await page.getByTestId('voxel-ai-input').fill('在空位加一座石灯笼')
  await page.getByTestId('voxel-ai-preview').click()
  await expect(page.getByTestId('voxel-ai-pending')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('voxel-ai-confirm').click()
  await expect.poll(() => sceneVersion(page, SECOND_WORLD), { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(base + 1)
  const rowsBefore = (await revisionRows(page, SECOND_WORLD)).length

  // 历史 → v1（有效）→ 恢复到此版本：预检有效，走快速通道直接恢复
  const history = await openHistory(page)
  const rowV1 = history.locator('li').filter({ hasText: '隔离 fixture 原始旧场景' })
  await expect(rowV1).toBeVisible({ timeout: 30_000 })
  await rowV1.getByRole('button', { name: '恢复到此版本' }).click()
  // 有效目标不打开兼容旅程，恢复完成后历史面板关闭
  await expect(compatDialog(page)).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: '场景历史' })).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => sceneVersion(page, SECOND_WORLD), { timeout: 30_000, intervals: [500, 1000] }).toBe(base + 2)

  // 新增当前版本，目标 v1 原文仍在历史中
  const rowsAfter = await revisionRows(page, SECOND_WORLD)
  expect(rowsAfter.length).toBe(rowsBefore + 1)
  expect(rowsAfter.some(row => row.version === 1 && row.summary === '隔离 fixture 原始旧场景')).toBe(true)
})

// ── W36：无效历史目标，先修复预览，不启用原无效目标 ────────────────

test('无效历史恢复：先修复预览，原 restore 不被调用，确认后新增有效版本', async ({ page }) => {
  await login(page)
  await enterWorld(page, LEGACY_WORLD)
  const before = await sceneVersion(page, LEGACY_WORLD)
  const restoreCalls = requestCounter(page, '/scene/restore')

  const dialog = await startRestoreV1Journey(page)
  await expect(dialog).toContainText('目标：历史版本 v1')
  await buildRepairPreview(dialog)
  await expect(dialog).toContainText(/本次修复变化（\d+ 项）/)
  await confirmToCompleted(dialog, '历史恢复')

  // 原 restore 全程未被调用；新增一个当前版本
  expect(restoreCalls()).toBe(0)
  expect(await sceneVersion(page, LEGACY_WORLD)).toBe(before + 1)
  // 原历史 v1 不被回滚改写
  expect((await revisionRows(page, LEGACY_WORLD)).some(row => row.version === 1 && row.summary === '隔离 fixture 原始旧场景')).toBe(true)
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
})

// ── W37：双击同一草稿确认，幂等只产生一个新版本 ────────────────────

test('重复确认：双击同一草稿确认只提交一次、只产生一个新版本', async ({ page }) => {
  await login(page)
  await enterWorld(page, LEGACY_WORLD)
  const before = await sceneVersion(page, LEGACY_WORLD)
  const rowsBefore = (await revisionRows(page, LEGACY_WORLD)).length
  const confirmCount = requestCounter(page, '/scene/compatibility/confirm')

  const dialog = await startRestoreV1Journey(page)
  await buildRepairPreview(dialog)
  await dialog.getByRole('button', { name: '确认保存为新版本' }).dblclick()
  await expect(dialog).toContainText(/已保存为新版本 v\d+（历史恢复）/, { timeout: 60_000 })

  // 同 requestId 幂等：只有一次 confirm 请求，只有一个新版本
  expect(confirmCount()).toBe(1)
  expect(await sceneVersion(page, LEGACY_WORLD)).toBe(before + 1)
  expect((await revisionRows(page, LEGACY_WORLD)).length).toBe(rowsBefore + 1)
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
})

// ── W39：预览后另一真实客户端更新 current → 冲突 → 重新检查后完成 ──

test('并发与依据变化：预览后另一客户端更新 current，确认冲突并可重新检查完成', async ({ page }) => {
  await login(page)
  await enterWorld(page, LEGACY_WORLD)
  const before = await sceneVersion(page, LEGACY_WORLD)

  const dialog = await startRestoreV1Journey(page)
  await buildRepairPreview(dialog)

  // 另一真实客户端（同账号、直连 API）完成同一目标的恢复，current 前进一版
  const headers = await bearer(page)
  const draftRes = await page.request.post(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/drafts`, {
    headers,
    data: {
      draftRequestId: crypto.randomUUID(),
      purpose: 'restore-history',
      target: { kind: 'history', version: 1 },
      expectedCurrentVersion: before,
    },
  })
  expect(draftRes.ok()).toBeTruthy()
  const otherDraft = await draftRes.json() as { id: string }
  const otherConfirm = await page.request.post(`/api/worlds/${LEGACY_WORLD}/scene/compatibility/confirm`, {
    headers,
    data: {
      draftId: otherDraft.id,
      requestId: crypto.randomUUID(),
      expectedCurrentVersion: before,
      expectedAttempt: 0,
    },
  })
  expect(otherConfirm.ok()).toBeTruthy()
  expect((await otherConfirm.json() as { status: string }).status).toBe('completed')
  expect(await sceneVersion(page, LEGACY_WORLD)).toBe(before + 1)

  // 原确认拒绝覆盖：conflict「依据已变化」，目标保留
  await dialog.getByRole('button', { name: '确认保存为新版本' }).click()
  await expect(dialog).toContainText('依据已变化', { timeout: 30_000 })
  await expect(dialog).toContainText('场景已更新，请重新检查并预览')
  await expect(dialog).toContainText('历史版本 v1')

  // 重新检查和预览确认后才能继续；新基线不被旧草稿覆盖
  await dialog.getByRole('button', { name: '重新检查' }).click()
  await expect(dialog).toContainText('检查完成', { timeout: 30_000 })
  await expect(dialog).toContainText('发现阻断问题') // v1 仍是 invalid 目标
  await buildRepairPreview(dialog)
  await confirmToCompleted(dialog, '历史恢复')
  expect(await sceneVersion(page, LEGACY_WORLD)).toBe(before + 2)
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
})

// ── W40：真实 confirm 落库但丢弃响应，刷新后经查询恢复 completed ──

test('响应丢失刷新：confirm 落库但响应丢弃，刷新后经查询恢复 completed 回执', async ({ page }) => {
  await login(page)
  await enterWorld(page, LEGACY_WORLD)
  const before = await sceneVersion(page, LEGACY_WORLD)
  const rowsBefore = (await revisionRows(page, LEGACY_WORLD)).length
  const confirmCount = requestCounter(page, '/scene/compatibility/confirm')
  await dropNextConfirmResponse(page)

  const dialog = await startRestoreV1Journey(page)
  await buildRepairPreview(dialog)
  await dialog.getByRole('button', { name: '确认保存为新版本' }).click()
  await expect(dialog).toContainText('结果未知', { timeout: 30_000 })
  await expect(dialog.getByRole('button', { name: '查询提交结果' })).toBeVisible()

  // 刷新浏览器：已持久 request 身份恢复（localStorage continuation），先查结果
  await page.reload()
  const restored = compatDialog(page)
  await expect(restored).toBeVisible({ timeout: 120_000 })
  await expect(restored).toContainText('结果未知')
  await restored.getByRole('button', { name: '查询提交结果' }).click()
  await expect(restored).toContainText(/已保存为新版本 v\d+（历史恢复）/, { timeout: 60_000 })

  // 新版/history 各一次：无新增 request，也没有自动重交
  expect(await sceneVersion(page, LEGACY_WORLD)).toBe(before + 1)
  expect((await revisionRows(page, LEGACY_WORLD)).length).toBe(rowsBefore + 1)
  expect(confirmCount()).toBe(1)
  await restored.getByRole('button', { name: '关闭兼容检查' }).click()
})

// ── W41：延迟旧 attempt 查询保持 unknown，不开放新提交 ─────────────

test('未知结果与明确重试：查询延迟期间保持 unknown，不开放新提交', async ({ page }) => {
  await login(page)
  await enterWorld(page, LEGACY_WORLD)
  const before = await sceneVersion(page, LEGACY_WORLD)
  const confirmCount = requestCounter(page, '/scene/compatibility/confirm')
  await dropNextConfirmResponse(page)
  await delayRequestQueries(page, 2000)

  const dialog = await startRestoreV1Journey(page)
  await buildRepairPreview(dialog)
  await dialog.getByRole('button', { name: '确认保存为新版本' }).click()
  await expect(dialog).toContainText('结果未知', { timeout: 30_000 })

  // 点查询：响应被延迟期间保持 unknown——不开放新提交，「查询提交结果」仍可再点
  await dialog.getByRole('button', { name: '查询提交结果' }).click()
  await page.waitForTimeout(500)
  await expect(dialog).toContainText('结果未知')
  await expect(dialog.getByRole('button', { name: '确认保存为新版本' })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '构建修复预览' })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '查询提交结果' })).toBeEnabled()

  // 延迟的真实响应到达：completed 回执；旧 attempt 不会写出第二版
  await expect(dialog).toContainText(/已保存为新版本 v\d+（历史恢复）/, { timeout: 60_000 })
  expect(await sceneVersion(page, LEGACY_WORLD)).toBe(before + 1)
  expect(confirmCount()).toBe(1)
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  // 缺口（如实记录）：任务书的 recover 退休执行权 / nextAttempt 重试路径在 UI 不可达
  // （前端会话未暴露 recover 调用），本用例只覆盖「unknown 不自动重试、不开放新提交」。
})

// ── W42：修复旅程前后生活资料原样保留 ─────────────────────────────

test('保留生活进度：修复旅程前后居民行程与人物身份原样保留', async ({ page }) => {
  await login(page)
  const headers = await bearer(page)
  interface PersonDetail {
    person: { id: string; name: string }
    world: { id: string } | null
    state: { personId: string; timelineId: string; simTime: string; location: string; activity: string } | null
    timelines: Array<{ id: string }>
  }
  const readPerson = async () => {
    const res = await page.request.get('/api/persons/a1-resident-ada', { headers })
    expect(res.ok()).toBeTruthy()
    return await res.json() as PersonDetail
  }
  const before = await readPerson()
  expect(before.world?.id).toBe(LEGACY_WORLD)
  expect(before.state).not.toBeNull()

  // 真实修复旅程（restore-history v1）
  await enterWorld(page, LEGACY_WORLD)
  const versionBefore = await sceneVersion(page, LEGACY_WORLD)
  const dialog = await startRestoreV1Journey(page)
  await buildRepairPreview(dialog)
  await confirmToCompleted(dialog, '历史恢复')
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  expect(await sceneVersion(page, LEGACY_WORLD)).toBe(versionBefore + 1)

  // 几何确认不清除/回滚生活资料：人物、世界、时间线身份与行程状态不变
  const after = await readPerson()
  expect(after.person.id).toBe(before.person.id)
  expect(after.person.name).toBe('阿澜')
  expect(after.world?.id).toBe(before.world?.id)
  expect(after.timelines.map(t => t.id)).toEqual(before.timelines.map(t => t.id))
  expect(after.state?.personId).toBe(before.state?.personId)
  expect(after.state?.timelineId).toBe(before.state?.timelineId)
  expect(after.state?.location).toBe(before.state?.location)
  expect(after.state?.activity).toBe(before.state?.activity)
  expect(after.state?.simTime ?? '').toBe(before.state?.simTime ?? '')
  // 缺口（如实记录）：fixture 记忆行（a1-memory-1）没有 HTTP 列表/读取端点
  // （/api/memories 只有校正/删除），记忆内容保留无法经公开路由核对；
  // 任务书的“修复期间追加真实 conversation/事件”依赖生活 LLM 链路，本环境不确定，未覆盖。
})
