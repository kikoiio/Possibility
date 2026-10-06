import { expect, test, type Page, type Locator, type Response as PlaywrightResponse } from '@playwright/test'

/**
 * A1 场景兼容真实持久 E2E（W28–W44，桌面项目 compatibility-desktop）。
 *
 * 环境：冻结 CLI 启动的隔离 API（scene-compatibility-legacy 数据模式，迁移 0000–0036
 * 旧资料 → 完整迁移 + 测试发布策略），前端独立 dev server；场景/生活 API 走真实 HTTP，
 * 电话回复仅由显式隔离 E2E 环境变量启用的确定性提供者返回。
 *
 * 执行模型（workers=1，describe.serial）：单次整套运行的用例按声明顺序共享同一
 * 隔离 D1 持久目录。原始 a1-legacy-world 没有完整 universe evidence，可能只读；
 * 需要确认恢复/重试的旅程使用带完整证据的 a1-e01-demo-copy。该副本初始 v1 保持
 * invalid，首次需要时先确认 repair-current，再重复以 v1 为目标的 restore-history。
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
const E01_WORLD = 'a1-e01-demo-copy' // E01 独立原始多空间保存演示副本
const BOOKSHELF_WORLD = 'a1-bookshelf-world' // 家具内部格误判与保存几何对照
const MISSING_SCENE_WORLD = 'a1-missing-scene-world'
const CORRUPT_SCENE_WORLD = 'a1-corrupt-scene-world'
const UNSUPPORTED_SCENE_WORLD = 'a1-unsupported-scene-world'
const UNSUPPORTED_VERSION_WORLD = 'a1-unsupported-version-world'

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

async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** 真实路由快照：场景历史行。 */
async function revisionRows(page: Page, worldId: string): Promise<Array<{ version: number; parentVersion: number | null; summary: string; kind: string; contentHash: string }>> {
  const res = await page.request.get(`/api/worlds/${worldId}/scene/revisions`, { headers: await bearer(page) })
  expect(res.ok()).toBeTruthy()
  return (await res.json() as { revisions: Array<{ version: number; parentVersion: number | null; summary: string; kind: string; contentHash: string }> }).revisions
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
async function startRestoreV1Journey(page: Page, worldId = LEGACY_WORLD): Promise<Locator> {
  await expect(page).toHaveURL(new RegExp(`/worlds/${worldId}`))
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

// ── E01：同一多空间演示副本的连续真实持久旅程 ────────────────────

test('E01 同一多空间旧副本连续完成修复、AI/手动编辑、刷新与历史恢复', async ({ page }) => {
  await login(page)
  await enterWorld(page, E01_WORLD, { editor: true })
  const headers = await bearer(page)
  const compatibilityRequestWorlds = new Set<string>()
  page.on('request', request => {
    const match = request.url().match(/\/api\/worlds\/([^/]+)\/scene\/compatibility\//)
    if (match) compatibilityRequestWorlds.add(decodeURIComponent(match[1]!))
  })
  const unrelatedScenesBefore = new Map<string, { document: unknown; revisions: Awaited<ReturnType<typeof revisionRows>> }>()
  for (const worldId of [LEGACY_WORLD, SPACES_WORLD]) {
    unrelatedScenesBefore.set(worldId, { document: await sceneDocument(page, worldId), revisions: await revisionRows(page, worldId) })
  }
  const timelineId = 'a1-e01-main'
  const branchTimelineId = 'a1-e01-branch'
  const snapshot = async () => {
    const response = await page.request.get(`/api/worlds/${E01_WORLD}/scene`, { headers })
    expect(response.ok()).toBeTruthy()
    return await response.json() as { status: string; version?: number; document?: unknown }
  }
  const worldSnapshot = async (id: string) => {
    const response = await page.request.get(`/api/worlds/${E01_WORLD}?timelineId=${id}`, { headers })
    expect(response.ok()).toBeTruthy()
    return await response.json() as {
      world: { id: string; locations: Array<{ id?: string; name: string }> }
      timelines: Array<{ id: string }>
      currentTimelineId: string
      locationBoard: Array<{ location: string; persons: Array<{ id: string }> }>
    }
  }
  const identitySnapshot = (snapshot: Awaited<ReturnType<typeof worldSnapshot>>) => ({
    worldId: snapshot.world.id,
    locationIds: snapshot.world.locations.map(location => location.id ?? location.name).sort(),
    timelineIds: snapshot.timelines.map(timeline => timeline.id).sort(),
    residentIds: snapshot.locationBoard.flatMap(location => location.persons.map(person => person.id)).sort(),
  })
  const revisions = async () => revisionRows(page, E01_WORLD)
  // Capture original invalid multi-space revision/content and identities before any write.
  const h0 = await snapshot()
  expect(h0.status).toBe('ready')
  expect(h0.version).toBe(1)
  const h0Document = h0.document
  const h0Spaces = (h0Document as { spaces: Array<{ id: string; document: unknown }> }).spaces
  const h0Hall = h0Spaces.find(space => space.id === 'hall')?.document
  expect(h0Hall).toBeTruthy()
  expect(JSON.stringify(h0Hall)).toContain('fixture-legacy-asset')
  const historyBefore = await revisions()
  expect(historyBefore).toHaveLength(1)
  expect(historyBefore[0]?.version).toBe(1)
  expect(historyBefore[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/)
  const branchLifeBeforeRes = await page.request.get(`/api/worlds/${E01_WORLD}/state?timelineId=${branchTimelineId}`, { headers })
  expect(branchLifeBeforeRes.ok()).toBeTruthy()
  const branchLifeBefore = await branchLifeBeforeRes.json()
  const mainIdentityBefore = identitySnapshot(await worldSnapshot(timelineId))
  const branchIdentityBefore = identitySnapshot(await worldSnapshot(branchTimelineId))
  const personBeforeRes = await page.request.get('/api/persons/a1-e01-resident-ada', { headers })
  expect(personBeforeRes.ok()).toBeTruthy()
  const personBefore = await personBeforeRes.json() as { person: { id: string; name: string }; world: { id: string } | null; timelines: { id: string }[]; state: { personId: string; timelineId: string } | null }
  expect(personBefore.world?.id).toBe(E01_WORLD)
  expect(personBefore.timelines.map(timeline => timeline.id)).toContain(timelineId)
  expect(personBefore.timelines.map(timeline => timeline.id)).toContain(branchTimelineId)

  // 1. A real editor AI request is gated before provider planning and preserves intent.
  const intent = '在外景空位加一座新石灯'
  let planResponse: { status: number; body: string } | null = null
  page.on('response', async response => {
    if (!response.url().includes('/api/voxel/edit-plan')) return
    planResponse = { status: response.status(), body: await response.text().catch(() => '') }
  })
  await page.getByTestId('voxel-tool-ai').click()
  await page.getByTestId('voxel-ai-input').fill(intent)
  await page.getByTestId('voxel-ai-preview').click()
  await expect(page.getByTestId('voxel-ai-error')).toContainText('当前场景存在既存问题', { timeout: 30_000 })
  const dialog = compatDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('检查完成', { timeout: 30_000 })
  await expect.poll(() => planResponse).not.toBeNull()
  expect(planResponse?.status).toBe(422)
  expect(planResponse?.body).toContain('compatibility-required')
  await expect(page.getByTestId('voxel-ai-input')).toHaveValue(intent)

  // 2. Inspect both spaces/read-only preview and append life data through authenticated APIs.
  await buildRepairPreview(dialog)
  await expect(dialog).toContainText('空间 hall')
  await expect(dialog).toContainText(/本次修复变化（\d+ 项）/)
  await dialog.getByRole('tab', { name: '老花房' }).click()
  await expect(dialog.getByRole('tab', { name: '老花房' })).toHaveAttribute('aria-selected', 'true')
  await dialog.getByRole('tab', { name: '修复前' }).click()
  await expect(dialog.getByRole('tab', { name: '石灯外景' })).toBeVisible()
  await expect(dialog).toContainText('预览为只读，不会触发编辑或自动保存。')
  const conversationRes = await page.request.post('/api/persons/a1-e01-resident-ada/conversations', {
    headers, data: { timelineId },
  })
  const conversationBody = await conversationRes.text()
  expect(conversationRes.ok(), `conversation create failed (${conversationRes.status()}): ${conversationBody}`).toBeTruthy()
  const conversation = JSON.parse(conversationBody) as { id: string; timelineId: string; personId: string }
  expect(conversation).toMatchObject({ personId: 'a1-e01-resident-ada', timelineId })
  const chatRequestId = `a1-e01-life-${crypto.randomUUID()}`
  const chatText = '请记下庭院修复期间收到的维护消息。'
  const chatRes = await page.request.post(`/api/conversations/${conversation.id}/messages`, {
    headers, data: { requestId: chatRequestId, content: chatText },
  })
  const chatStream = await chatRes.text()
  expect(chatRes.ok(), `chat message failed (${chatRes.status()}): ${chatStream}`).toBeTruthy()
  expect(chatStream).toContain('我收到了庭院维护的消息')
  const chatReceiptRes = await page.request.get(`/api/conversations/${conversation.id}/requests/${chatRequestId}`, { headers })
  expect(chatReceiptRes.ok()).toBeTruthy()
  const chatReceipt = await chatReceiptRes.json() as { status: string; reply: { content: string } | null }
  expect(chatReceipt).toMatchObject({ status: 'completed', reply: { content: '我收到了庭院维护的消息，会把这段经历记下来。' } })
  const stateBeforeLife = await (await page.request.get(`/api/worlds/${E01_WORLD}/state?timelineId=${timelineId}`, { headers })).json() as { version: number }
  const lifeCommandId = `a1-e01-life-${crypto.randomUUID()}`
  const factRes = await page.request.post(`/api/worlds/${E01_WORLD}/actions`, {
    headers,
    data: { id: lifeCommandId, timelineId, expectedVersion: stateBeforeLife.version,
      action: { type: 'inform', recipientId: 'a1-e01-resident-ada', topic: '场景修复期间的生活记录', content: '阿澜在修复期间收到庭院维护消息。' } },
  })
  expect(factRes.ok()).toBeTruthy()
  const factResult = await factRes.json() as { commandId: string; factId: string; version: number }
  expect(factResult.commandId).toBe(lifeCommandId)
  const lifeAfterAppend = await (await page.request.get(`/api/worlds/${E01_WORLD}/state?timelineId=${timelineId}`, { headers })).json() as { version: number; facts: Array<{ id?: string; value?: unknown; content?: string }> }
  expect(lifeAfterAppend.version).toBe(factResult.version)
  expect(JSON.stringify(lifeAfterAppend.facts)).toContain('庭院维护消息')
  const lifeEvidence = async () => {
    const [messagesResponse, stateResponse, eventResponse] = await Promise.all([
      page.request.get(`/api/conversations/${conversation.id}/messages`, { headers }),
      page.request.get(`/api/worlds/${E01_WORLD}/state?timelineId=${timelineId}`, { headers }),
      page.request.get(`/api/worlds/${E01_WORLD}/events/command:${lifeCommandId}/evidence?timelineId=${timelineId}`, { headers }),
    ])
    expect(messagesResponse.ok()).toBeTruthy()
    expect(stateResponse.ok()).toBeTruthy()
    expect(eventResponse.ok()).toBeTruthy()
    const messageBody = await messagesResponse.json() as { messages: Array<{ id: string; role: string; content: string; conversationId: string }> }
    expect(messageBody.messages).toHaveLength(2)
    expect(messageBody.messages.map(message => message.role)).toEqual(['user', 'person'])
    expect(messageBody.messages.every(message => message.conversationId === conversation.id)).toBe(true)
    expect(messageBody.messages.map(message => message.content)).toContain(chatText)
    expect(messageBody.messages.map(message => message.content)).toContain('我收到了庭院维护的消息，会把这段经历记下来。')
    const state = await stateResponse.json() as { facts: Array<{ id?: string; value?: unknown; content?: string }> }
    expect(JSON.stringify(state.facts)).toContain('庭院维护消息')
    const evidence = await eventResponse.json() as {
      event: { id: string }; facts: Array<{ id: string; value: { content?: string } }>
    }
    expect(evidence.event.id).toBe(`command:${lifeCommandId}`)
    expect(evidence.facts.some(fact => fact.id === factResult.factId && fact.value.content?.includes('庭院维护消息'))).toBe(true)
  }
  await lifeEvidence()

  // 3. Confirm repair exactly once; current r1 is valid and h0 remains unchanged.
  await confirmToCompleted(dialog, '场景修复')
  const r1 = await snapshot()
  expect(r1.version).toBeGreaterThan(1)
  const r1Hall = (r1.document as { spaces: Array<{ id: string; document: { assetPlacements?: Array<{ id?: string; anchor: number[] }> } }> }).spaces
    .find(space => space.id === 'hall')?.document
  const r1Asset = r1Hall?.assetPlacements?.find(placement => placement.id === 'fixture-legacy-asset')
  expect(r1Asset?.anchor).not.toEqual([4, 1, 4])
  expect((await revisions()).some(row => row.version === 1 && row.summary === '隔离 fixture 原始旧场景')).toBe(true)
  expect((await revisions()).find(row => row.version === 1)?.contentHash).toMatch(/^[a-f0-9]{64}$/)
  const inspectR1 = await page.request.get(`/api/worlds/${E01_WORLD}/scene/compatibility/inspection`, { headers })
  expect(inspectR1.ok()).toBeTruthy()
  expect((await inspectR1.json() as { report: { status: string } }).report.status).toBe('valid')
  await lifeEvidence()
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  await expect(page.getByTestId('voxel-ai-input')).toHaveValue(intent)

  // 4. Reload from persisted r1, re-plan the retained intent and confirm the distinct AI edit r2.
  await page.reload()
  await expect(page.getByTestId('voxel-editor-toolbar')).toBeVisible({ timeout: 120_000 })
  await page.getByTestId('voxel-tool-ai').click()
  await page.getByTestId('voxel-ai-input').fill(intent)
  await page.getByTestId('voxel-ai-preview').click()
  await expect(page.getByTestId('voxel-ai-pending')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('voxel-ai-confirm').click()
  await expect.poll(() => sceneVersion(page, E01_WORLD), { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(r1.version! + 1)
  const r2 = await snapshot()
  expect(JSON.stringify(r2.document)).toContain('fixture-plan-lantern')
  await lifeEvidence()

  // Reload the persisted AI revision before a separate world-panel edit; the editor
  // must not build the next candidate from its pre-confirm in-memory document.
  await page.reload()
  await expect(page.getByTestId('voxel-editor-toolbar')).toBeVisible({ timeout: 120_000 })

  // 5. Real world-panel style edit is preflighted and saved as separate revision r3.
  await page.getByTestId('voxel-tool-world').click()
  await expect(page.getByTestId('voxel-terrain-none')).toBeVisible()
  await page.getByTestId('voxel-style-preset-bright-pastoral').click()
  await expect.poll(() => sceneVersion(page, E01_WORLD), { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(r2.version! + 1)
  const r3 = await snapshot()
  expect(JSON.stringify(r3.document)).toContain('fixture-plan-lantern')
  expect((await revisions()).some(row => row.version === r3.version && row.kind === 'voxel-edit')).toBe(true)
  await lifeEvidence()

  // 6. Refresh reads the exact persisted r3 document/history; no pending compatibility task resumes.
  await page.reload()
  await expect(page.getByTestId('scene-check-entry')).toBeVisible({ timeout: 120_000 })
  expect(await sceneVersion(page, E01_WORLD)).toBe(r3.version)
  expect(await hash(await sceneDocument(page, E01_WORLD))).toBe(await hash(r3.document))
  expect(await revisions()).toHaveLength(historyBefore.length + 3)
  await expect(compatDialog(page)).toHaveCount(0)

  // 7. Select original invalid h0, preview repair, and confirm to a new current version r4.
  const history = await openHistory(page)
  const rowV1 = history.locator('li').filter({ hasText: '隔离 fixture 原始旧场景' })
  await expect(rowV1).toBeVisible()
  await rowV1.getByRole('button', { name: '恢复到此版本' }).click()
  const restore = compatDialog(page)
  await expect(restore).toContainText('历史版本 v1')
  await expect(restore).toContainText('发现阻断问题', { timeout: 30_000 })
  await buildRepairPreview(restore)
  await confirmToCompleted(restore, '历史恢复')
  const r4 = await snapshot()
  expect(r4.version).toBe(r3.version! + 1)
  const r4Hall = (r4.document as { spaces: Array<{ id: string; document: { assetPlacements?: Array<{ id?: string; anchor: number[] }> } }> }).spaces
    .find(space => space.id === 'hall')?.document
  const r4Asset = r4Hall?.assetPlacements?.find(placement => placement.id === 'fixture-legacy-asset')
  expect(r4Asset?.anchor).not.toEqual([4, 1, 4])
  await lifeEvidence()
  await restore.getByRole('button', { name: '关闭兼容检查' }).click()

  // 8. Verify persisted source chain, original h0 bytes, life records, identities and audit rows.
  const allRevisions = await revisions()
  expect(allRevisions).toHaveLength(historyBefore.length + 4)
  expect(allRevisions.find(row => row.version === 1)?.summary).toBe('隔离 fixture 原始旧场景')
  expect(await hash(await sceneDocument(page, E01_WORLD))).toBe(await hash(r4.document))
  const sourceRes = await page.request.get(`/api/worlds/${E01_WORLD}/scene/compatibility/source/1/spaces/hall`, { headers })
  expect(sourceRes.ok()).toBeTruthy()
  expect(await hash((await sourceRes.json() as { document: unknown }).document)).not.toBe('')
  expect(await hash((await sourceRes.json() as { document: unknown }).document)).toBe(await hash(h0Hall))
  expect(JSON.stringify(r2.document)).toContain('fixture-plan-lantern')
  expect(JSON.stringify(r3.document)).toContain('fixture-plan-lantern')
  expect(allRevisions.some(row => row.version === r1.version && row.kind === 'compatibility-repair')).toBe(true)
  expect(allRevisions.some(row => row.version === r4.version && row.kind === 'restore')).toBe(true)
  await lifeEvidence()
  const finalLife = await (await page.request.get(`/api/worlds/${E01_WORLD}/state?timelineId=${timelineId}`, { headers })).json() as { facts: unknown[] }
  expect(JSON.stringify(finalLife.facts)).toContain('庭院维护消息')
  // Scene history belongs to the shared world. Switching timelines after restoring h0
  // must keep that same current geometry while each timeline retains its own life state.
  const timelineSelect = page.getByRole('combobox', { name: '切换时间线' })
  await expect(page.getByText(/场景几何和历史属于整个世界；切换时间线或恢复场景历史不会回滚各自时间线的生活记录。/)).toBeVisible()
  await timelineSelect.selectOption(branchTimelineId)
  await expect(timelineSelect).toHaveValue(branchTimelineId)
  const sceneOnBranch = await snapshot()
  expect(sceneOnBranch.version).toBe(r4.version)
  expect(await hash(sceneOnBranch.document)).toBe(await hash(r4.document))
  const branchLifeAfter = await (await page.request.get(`/api/worlds/${E01_WORLD}/state?timelineId=${branchTimelineId}`, { headers })).json()
  expect(branchLifeAfter).toEqual(branchLifeBefore)
  await timelineSelect.selectOption(timelineId)
  await expect(timelineSelect).toHaveValue(timelineId)
  const mainLifeAfter = await (await page.request.get(`/api/worlds/${E01_WORLD}/state?timelineId=${timelineId}`, { headers })).json() as { facts: unknown[] }
  expect(JSON.stringify(mainLifeAfter.facts)).toContain('庭院维护消息')
  const personAfterRes = await page.request.get('/api/persons/a1-e01-resident-ada', { headers })
  expect(personAfterRes.ok()).toBeTruthy()
  const personAfter = await personAfterRes.json() as typeof personBefore
  expect(personAfter.person).toEqual(personBefore.person)
  expect(personAfter.world?.id).toBe(personBefore.world?.id)
  expect(personAfter.timelines.map(timeline => timeline.id)).toEqual(personBefore.timelines.map(timeline => timeline.id))
  expect(personAfter.state?.personId).toBe(personBefore.state?.personId)
  expect(personAfter.state?.timelineId).toBe(personBefore.state?.timelineId)
  expect(personAfter.timelines.map(timeline => timeline.id)).toEqual(personBefore.timelines.map(timeline => timeline.id))
  expect(identitySnapshot(await worldSnapshot(timelineId))).toEqual(mainIdentityBefore)
  expect(identitySnapshot(await worldSnapshot(branchTimelineId))).toEqual(branchIdentityBefore)
  expect(JSON.stringify(await sceneDocument(page, E01_WORLD))).toContain('exterior')
  expect(JSON.stringify(await sceneDocument(page, E01_WORLD))).toContain('hall')
  expect(compatibilityRequestWorlds.size).toBeGreaterThan(0)
  expect([...compatibilityRequestWorlds]).toEqual([E01_WORLD])
  for (const [worldId, before] of unrelatedScenesBefore) {
    expect(await sceneDocument(page, worldId)).toEqual(before.document)
    expect(await revisionRows(page, worldId)).toEqual(before.revisions)
  }
})

// ── E02：有效单空间用户世界的编辑与历史恢复连续对照 ────────────────

test('E02 有效单空间用户世界连续完成诊断、AI/手动编辑、刷新与有效历史恢复', async ({ page }) => {
  await login(page, SECOND)
  await enterWorld(page, SECOND_WORLD, { editor: true })
  const headers = await bearer(page)
  const snapshot = async () => {
    const response = await page.request.get(`/api/worlds/${SECOND_WORLD}/scene`, { headers })
    expect(response.ok()).toBeTruthy()
    return await response.json() as { status: string; version?: number; document?: unknown }
  }
  const initial = await snapshot()
  expect(initial.status).toBe('ready')
  const initialVersion = initial.version!
  const initialRows = await revisionRows(page, SECOND_WORLD)
  const initialRevision = initialRows.find(row => row.version === initialVersion)
  const initialHash = await hash(initial.document)
  expect(initialRevision?.contentHash).toMatch(/^[a-f0-9]{64}$/)

  // Valid inspection is read-only and leaves the original current version/history intact.
  const diagnosis = await openCurrentDiagnosis(page)
  await expect(diagnosis).toContainText('检查结果：完整有效')
  await expect(diagnosis.getByRole('button', { name: '构建修复预览' })).toHaveCount(0)
  await diagnosis.getByRole('button', { name: '关闭兼容检查' }).click()
  expect(await sceneVersion(page, SECOND_WORLD)).toBe(initialVersion)
  expect((await revisionRows(page, SECOND_WORLD))).toHaveLength(initialRows.length)

  // Commit a real controlled-provider AI edit as the next independent revision.
  await page.getByTestId('voxel-tool-ai').click()
  await page.getByTestId('voxel-ai-input').fill('在空位加一座石灯笼')
  await page.getByTestId('voxel-ai-preview').click()
  await expect(page.getByTestId('voxel-ai-pending')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('voxel-ai-confirm').click()
  await expect.poll(() => sceneVersion(page, SECOND_WORLD), { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(initialVersion + 1)
  const afterAi = await snapshot()
  expect(JSON.stringify(afterAi.document)).toContain('fixture-plan-lantern')

  // Reload persisted AI content before a separate real manual world-panel edit.
  await page.reload()
  await expect(page.getByTestId('voxel-editor-toolbar')).toBeVisible({ timeout: 120_000 })
  await page.getByTestId('voxel-tool-world').click()
  await expect(page.getByTestId('voxel-terrain-none')).toBeVisible()
  await page.getByTestId('voxel-style-preset-bright-pastoral').click()
  await expect.poll(() => sceneVersion(page, SECOND_WORLD), { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(initialVersion + 2)
  const afterManual = await snapshot()
  expect(JSON.stringify(afterManual.document)).toContain('fixture-plan-lantern')
  expect((await revisionRows(page, SECOND_WORLD)).some(row => row.version === afterManual.version && row.kind === 'voxel-edit')).toBe(true)

  // Refresh re-reads r3; restoring valid v1 creates a new current version, never rewrites history.
  await page.reload()
  await expect(page.getByRole('button', { name: '历史', exact: true })).toBeVisible({ timeout: 120_000 })
  expect(await sceneVersion(page, SECOND_WORLD)).toBe(afterManual.version)
  const persisted = await snapshot()
  expect(await hash(persisted.document)).toBe(await hash(afterManual.document))
  const history = await openHistory(page)
  const rowV1 = history.locator('li').filter({ hasText: '隔离 fixture 原始旧场景' })
  await expect(rowV1).toBeVisible()
  await rowV1.getByRole('button', { name: '恢复到此版本' }).click()
  await expect(page.getByRole('dialog', { name: '场景历史' })).toHaveCount(0, { timeout: 30_000 })
  await expect(compatDialog(page)).toHaveCount(0)
  await expect.poll(() => sceneVersion(page, SECOND_WORLD), { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(initialVersion + 3)
  const restored = await snapshot()
  expect(await hash(restored.document)).toBe(initialHash)
  const finalRows = await revisionRows(page, SECOND_WORLD)
  expect(finalRows).toHaveLength(initialRows.length + 3)
  expect(finalRows.find(row => row.version === initialVersion)?.contentHash).toBe(initialRevision?.contentHash)
  expect(finalRows.find(row => row.version === restored.version)?.contentHash).toMatch(/^[a-f0-9]{64}$/)
  expect(finalRows.some(row => row.version === restored.version && row.kind === 'restore')).toBe(true)
})

test('旧资料分类：缺场景、损坏 JSON、未知格式和未知版本均明确拒绝且不写历史', async ({ page }) => {
  await login(page)
  const headers = await bearer(page)
  const cases = [
    { worldId: MISSING_SCENE_WORLD, status: 404, code: 'scene-missing', message: '请求的场景版本不存在', revisions: 0 },
    { worldId: CORRUPT_SCENE_WORLD, status: 422, code: 'scene-corrupt', message: '场景文档损坏：无法解析已保存版本', revisions: 1 },
    { worldId: UNSUPPORTED_SCENE_WORLD, status: 422, code: 'format-unsupported', message: '场景表现格式不受当前体素适配器支持', revisions: 1 },
    { worldId: UNSUPPORTED_VERSION_WORLD, status: 422, code: 'format-unsupported', message: '场景文档版本不受支持', revisions: 1 },
  ]

  for (const scenario of cases) {
    const before = await revisionRows(page, scenario.worldId)
    expect(before).toHaveLength(scenario.revisions)
    const response = await page.request.get(`/api/worlds/${scenario.worldId}/scene/compatibility/inspection`, { headers })
    expect(response.status(), scenario.worldId).toBe(scenario.status)
    expect(await response.json()).toMatchObject({ errorCode: scenario.code, error: scenario.message })
    expect(await revisionRows(page, scenario.worldId)).toEqual(before)
  }
})

test('A2.2 书架开放格分类说明且真实修复保存不改动书架几何', async ({ page }) => {
  await login(page)
  await enterWorld(page, BOOKSHELF_WORLD, { editor: true })
  const headers = await bearer(page)
  const beforeDocument = await sceneDocument(page, BOOKSHELF_WORLD) as {
    sections: unknown
    objects: Array<{ id: string; objectType: string; anchor: { x: number; y: number; z: number }; rotation: number }>
    objectCells: Array<{ objectId: string; cells: Array<{ x: number; y: number; z: number }> }>
  }
  const shelfBefore = beforeDocument.objects.find(object => object.id === 'fixture-bookshelf')
  const shelfCellsBefore = beforeDocument.objectCells.find(entry => entry.objectId === 'fixture-bookshelf')
  expect(shelfBefore).toMatchObject({ objectType: 'bookshelf', anchor: { x: 8, y: 1, z: 8 }, rotation: 0 })
  expect(shelfCellsBefore?.cells).toHaveLength(8)
  const versionsBefore = await revisionRows(page, BOOKSHELF_WORLD)
  expect(versionsBefore).toHaveLength(1)

  const dialog = await openCurrentDiagnosis(page)
  await expect(dialog).toContainText('发现阻断问题')
  await expect(dialog).toContainText('家具腔体，不是通行入口')
  await expect(dialog).toContainText('(9, 2, 8)')
  await buildRepairPreview(dialog)
  await expect(dialog).toContainText('fixture-bookshelf-collision')
  await expect(dialog).toContainText('家具腔体，不是通行入口')
  await confirmToCompleted(dialog, '场景修复')

  const afterDocument = await sceneDocument(page, BOOKSHELF_WORLD) as typeof beforeDocument
  expect(afterDocument.sections).toEqual(beforeDocument.sections)
  expect(afterDocument.objects.find(object => object.id === 'fixture-bookshelf')).toEqual(shelfBefore)
  expect(afterDocument.objectCells.find(entry => entry.objectId === 'fixture-bookshelf')).toEqual(shelfCellsBefore)
  expect(await revisionRows(page, BOOKSHELF_WORLD)).toHaveLength(versionsBefore.length + 1)
  const inspection = await page.request.get(`/api/worlds/${BOOKSHELF_WORLD}/scene/compatibility/inspection`, { headers })
  expect(inspection.ok()).toBeTruthy()
  expect((await inspection.json() as { report: { status: string } }).report.status).toBe('valid')
})

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

test('A10.3 修复移动装饰后原编辑重新校验失败：显示具体原因、保留输入且不新增编辑版本', async ({ page }) => {
  await login(page)
  await enterWorld(page, SPACES_WORLD, { editor: true })

  // This test must also be runnable alone: create a genuine valid successor so
  // the original invalid v1 is a historical restore target.
  if ((await revisionRows(page, SPACES_WORLD)).length === 1) {
    const setup = await openCurrentDiagnosis(page)
    await buildRepairPreview(setup)
    await confirmToCompleted(setup, '场景修复')
    await setup.getByRole('button', { name: '关闭兼容检查' }).click()
  }

  // 把有重叠装饰的历史版重新作为修复目标；修复只移动老花房装饰，外景石灯身份与基底保留。
  const beforeRestore = await sceneVersion(page, SPACES_WORLD)
  const rowsBeforeRestore = await revisionRows(page, SPACES_WORLD)
  const dialog = await startRestoreV1Journey(page, SPACES_WORLD)
  await buildRepairPreview(dialog)
  await expect(dialog).toContainText(/本次修复变化（\d+ 项）/)
  await confirmToCompleted(dialog, '历史恢复')
  const repairedVersion = await sceneVersion(page, SPACES_WORLD)
  expect(repairedVersion).toBe(beforeRestore + 1)
  expect(await revisionRows(page, SPACES_WORLD)).toHaveLength(rowsBeforeRestore.length + 1)
  const repaired = await sceneDocument(page, SPACES_WORLD) as { spaces: Array<{ id: string; document: { assetPlacements?: Array<{ id?: string; anchor: number[] }> } }> }
  const repairedDecoration = repaired.spaces.find(space => space.id === 'hall')?.document.assetPlacements?.find(item => item.id === 'fixture-legacy-asset')
  expect(repairedDecoration).toBeTruthy()
  expect(repairedDecoration?.anchor).not.toEqual([4, 1, 4])
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  // 修复保存不自动替换画布引擎文档；重新进入后，后续编辑才会基于新版本检查。
  await page.reload()
  await expect(page.getByTestId('voxel-editor-toolbar')).toBeVisible({ timeout: 120_000 })

  // 原编辑意图在修复后的有效场景上会移除 keeper 石灯的支撑。服务端须给出该对象的
  // 具体诊断；失败不得消费旧依据、清空输入或落下一条 voxel-edit 历史。
  const intent = '[fixture-branch:invalid-candidate] 挖掉石灯脚下的支撑'
  const rowsBeforeEdit = await revisionRows(page, SPACES_WORLD)
  await page.getByTestId('voxel-tool-ai').click()
  await page.getByTestId('voxel-ai-input').fill(intent)
  await page.getByTestId('voxel-ai-preview').click()
  const failure = page.getByTestId('voxel-ai-error')
  await expect(failure).toContainText('改造结果未通过完整校验', { timeout: 60_000 })
  await expect(failure).toContainText('fixture-keeper')
  await expect(failure).toContainText('has no support beneath')
  await expect(failure).toContainText('为物体补充可靠支撑')
  await expect(page.getByTestId('voxel-ai-input')).toHaveValue(intent)
  await expect(page.getByTestId('voxel-ai-pending')).toHaveCount(0)
  expect(await sceneVersion(page, SPACES_WORLD)).toBe(repairedVersion)
  expect(await revisionRows(page, SPACES_WORLD)).toEqual(rowsBeforeEdit)
})

test('A14.5 兼容修复预览重复切换和关闭释放视口且无后台请求', async ({ page }) => {
  await login(page)
  await enterWorld(page, SPACES_WORLD)
  if ((await revisionRows(page, SPACES_WORLD)).length === 1) {
    const setup = await openCurrentDiagnosis(page)
    await buildRepairPreview(setup)
    await confirmToCompleted(setup, '场景修复')
    await setup.getByRole('button', { name: '关闭兼容检查' }).click()
  }
  const versionBefore = await sceneVersion(page, SPACES_WORLD)
  const rowsBefore = await revisionRows(page, SPACES_WORLD)
  const worldViewportCount = await page.getByTestId('voxel-viewport-canvas').count()
  const previewEngineIds = () => page.evaluate(() => Object.keys(
    (window as unknown as { __voxelEngines?: Record<string, unknown> }).__voxelEngines ?? {},
  ).filter(instanceId => instanceId.startsWith('repair-preview-')).sort())
  expect(await previewEngineIds()).toEqual([])
  const compatibilityRequests: string[] = []
  page.on('request', request => {
    if (request.url().includes(`/api/worlds/${SPACES_WORLD}/scene/compatibility/`)) {
      compatibilityRequests.push(`${request.method()} ${request.url()}`)
    }
  })

  for (let cycle = 0; cycle < 2; cycle += 1) {
    const dialog = await startRestoreV1Journey(page, SPACES_WORLD)
    await buildRepairPreview(dialog)
    const viewport = dialog.getByTestId('voxel-viewport-canvas')
    await expect(viewport).toHaveCount(1)
    await expect.poll(previewEngineIds).toHaveLength(1)

    // Change both the preview side and the space repeatedly; the page owns one
    // read-only viewport throughout the cycle.
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await dialog.getByRole('tab', { name: '修复前' }).click()
      await dialog.getByRole('tab', { name: '老花房' }).click()
      await expect(viewport).toHaveCount(1)
      await expect.poll(previewEngineIds).toHaveLength(1)
      await dialog.getByRole('tab', { name: '修复后' }).click()
      await dialog.getByRole('tab', { name: '石灯外景' }).click()
      await expect(viewport).toHaveCount(1)
      await expect.poll(previewEngineIds).toHaveLength(1)
    }

    const requestsAtClose = compatibilityRequests.length
    await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
    await expect(compatDialog(page)).toHaveCount(0)
    await expect(page.getByTestId('voxel-viewport-canvas')).toHaveCount(worldViewportCount)
    await expect.poll(previewEngineIds).toEqual([])
    await page.waitForTimeout(1_500)
    expect(compatibilityRequests).toHaveLength(requestsAtClose)
    expect(await sceneVersion(page, SPACES_WORLD)).toBe(versionBefore)
    expect(await revisionRows(page, SPACES_WORLD)).toEqual(rowsBefore)
  }
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
  // The original legacy world lacks complete universe evidence and is read-only.
  // Use the evidence-bearing E01 copy for this write journey.
  await enterWorld(page, E01_WORLD)
  if ((await revisionRows(page, E01_WORLD)).length === 1) {
    const setup = await openCurrentDiagnosis(page)
    await buildRepairPreview(setup)
    await confirmToCompleted(setup, '场景修复')
    await setup.getByRole('button', { name: '关闭兼容检查' }).click()
  }
  const before = await sceneVersion(page, E01_WORLD)
  const restoreCalls = requestCounter(page, '/scene/restore')

  const dialog = await startRestoreV1Journey(page, E01_WORLD)
  await expect(dialog).toContainText('目标：历史版本 v1')
  await buildRepairPreview(dialog)
  await expect(dialog).toContainText(/本次修复变化（\d+ 项）/)
  await confirmToCompleted(dialog, '历史恢复')

  // 原 restore 全程未被调用；新增一个当前版本
  expect(restoreCalls()).toBe(0)
  expect(await sceneVersion(page, E01_WORLD)).toBe(before + 1)
  // 原历史 v1 不被回滚改写
  expect((await revisionRows(page, E01_WORLD)).some(row => row.version === 1 && row.summary === '隔离 fixture 原始旧场景')).toBe(true)
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
})

// ── W37：双击同一草稿确认，幂等只产生一个新版本 ────────────────────

test('重复确认：双击同一草稿确认只提交一次、只产生一个新版本', async ({ page }) => {
  await login(page)
  await enterWorld(page, E01_WORLD)
  if ((await revisionRows(page, E01_WORLD)).length === 1) {
    const setup = await openCurrentDiagnosis(page)
    await buildRepairPreview(setup)
    await confirmToCompleted(setup, '场景修复')
    await setup.getByRole('button', { name: '关闭兼容检查' }).click()
  }
  const before = await sceneVersion(page, E01_WORLD)
  const rowsBefore = await revisionRows(page, E01_WORLD)
  const confirmCount = requestCounter(page, '/scene/compatibility/confirm')
  let submitted: { requestId: string } | null = null
  page.on('request', request => {
    if (request.url().includes(`/api/worlds/${E01_WORLD}/scene/compatibility/confirm`)) {
      submitted = request.postDataJSON() as typeof submitted
    }
  })

  const dialog = await startRestoreV1Journey(page, E01_WORLD)
  await buildRepairPreview(dialog)
  await dialog.getByRole('button', { name: '确认保存为新版本' }).dblclick()
  await expect(dialog).toContainText(/已保存为新版本 v\d+（历史恢复）/, { timeout: 60_000 })

  // 同 requestId 幂等：只有一次 confirm 请求，只有一个新版本
  expect(confirmCount()).toBe(1)
  expect(await sceneVersion(page, E01_WORLD)).toBe(before + 1)
  expect(await revisionRows(page, E01_WORLD)).toHaveLength(rowsBefore.length + 1)
  const request = await page.request.get(`/api/worlds/${E01_WORLD}/scene/compatibility/requests/${submitted!.requestId}`, { headers: await bearer(page) })
  expect(request.ok()).toBeTruthy()
  expect(await request.json()).toMatchObject({ status: 'completed' })
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
})

// ── W39：预览后另一真实客户端更新 current → 冲突 → 重新检查后完成 ──

test('并发与依据变化：预览后另一客户端更新 current，确认冲突并可重新检查完成', async ({ page }) => {
  await login(page)
  await enterWorld(page, E01_WORLD)
  if ((await revisionRows(page, E01_WORLD)).length === 1) {
    const setup = await openCurrentDiagnosis(page)
    await buildRepairPreview(setup)
    await confirmToCompleted(setup, '场景修复')
    await setup.getByRole('button', { name: '关闭兼容检查' }).click()
  }
  const before = await sceneVersion(page, E01_WORLD)
  const rowsBefore = await revisionRows(page, E01_WORLD)

  const dialog = await startRestoreV1Journey(page, E01_WORLD)
  await buildRepairPreview(dialog)

  // 另一真实客户端（同账号、直连 API）完成同一目标的恢复，current 前进一版
  const headers = await bearer(page)
  const draftRes = await page.request.post(`/api/worlds/${E01_WORLD}/scene/compatibility/drafts`, {
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
  const otherRequestId = crypto.randomUUID()
  const otherConfirm = await page.request.post(`/api/worlds/${E01_WORLD}/scene/compatibility/confirm`, {
    headers,
    data: {
      draftId: otherDraft.id,
      requestId: otherRequestId,
      expectedCurrentVersion: before,
      expectedAttempt: 0,
    },
  })
  expect(otherConfirm.ok()).toBeTruthy()
  expect((await otherConfirm.json() as { status: string }).status).toBe('completed')
  expect(await sceneVersion(page, E01_WORLD)).toBe(before + 1)
  const otherRequest = await page.request.get(`/api/worlds/${E01_WORLD}/scene/compatibility/requests/${otherRequestId}`, { headers })
  expect(otherRequest.ok()).toBeTruthy()
  expect(await otherRequest.json()).toMatchObject({ status: 'completed' })

  const uiRequestIds: string[] = []
  page.on('request', request => {
    if (request.url().includes(`/api/worlds/${E01_WORLD}/scene/compatibility/confirm`)) {
      uiRequestIds.push((request.postDataJSON() as { requestId: string }).requestId)
    }
  })

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
  expect(await sceneVersion(page, E01_WORLD)).toBe(before + 2)
  expect(await revisionRows(page, E01_WORLD)).toHaveLength(rowsBefore.length + 2)
  expect(uiRequestIds.length).toBeGreaterThan(0)
  const retryRequest = await page.request.get(`/api/worlds/${E01_WORLD}/scene/compatibility/requests/${uiRequestIds.at(-1)}`, { headers })
  expect(retryRequest.ok()).toBeTruthy()
  expect(await retryRequest.json()).toMatchObject({ status: 'completed' })
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
})

// ── W40：真实 confirm 落库但丢弃响应，刷新后经查询恢复 completed ──

test('响应丢失刷新：confirm 落库但响应丢弃，刷新后经查询恢复 completed 回执', async ({ page }) => {
  await login(page)
  await enterWorld(page, E01_WORLD)
  if ((await revisionRows(page, E01_WORLD)).length === 1) {
    const setup = await openCurrentDiagnosis(page)
    await buildRepairPreview(setup)
    await confirmToCompleted(setup, '场景修复')
    await setup.getByRole('button', { name: '关闭兼容检查' }).click()
  }
  const before = await sceneVersion(page, E01_WORLD)
  const rowsBefore = await revisionRows(page, E01_WORLD)
  const confirmCount = requestCounter(page, '/scene/compatibility/confirm')
  let requestId: string | null = null
  page.on('request', request => {
    if (request.url().includes(`/api/worlds/${E01_WORLD}/scene/compatibility/confirm`)) {
      requestId = (request.postDataJSON() as { requestId: string }).requestId
    }
  })
  await dropNextConfirmResponse(page)

  const dialog = await startRestoreV1Journey(page, E01_WORLD)
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
  expect(await sceneVersion(page, E01_WORLD)).toBe(before + 1)
  expect(await revisionRows(page, E01_WORLD)).toHaveLength(rowsBefore.length + 1)
  expect(confirmCount()).toBe(1)
  const request = await page.request.get(`/api/worlds/${E01_WORLD}/scene/compatibility/requests/${requestId}`, { headers: await bearer(page) })
  expect(request.ok()).toBeTruthy()
  expect(await request.json()).toMatchObject({ status: 'completed' })
  await restored.getByRole('button', { name: '关闭兼容检查' }).click()
})

// ── W41：延迟旧 attempt 查询保持 unknown，不开放新提交 ─────────────

test('未知结果经恢复授权同一请求重试，旧 attempt 被封后仅新增一版', async ({ page }) => {
  await login(page)
  // The legacy world is intentionally read-only without universe evidence.
  // Exercise this real journey on the evidence-bearing saved demo copy.
  await enterWorld(page, E01_WORLD)
  if ((await revisionRows(page, E01_WORLD)).length === 1) {
    const setup = await openCurrentDiagnosis(page)
    await buildRepairPreview(setup)
    await confirmToCompleted(setup, '场景修复')
    await setup.getByRole('button', { name: '关闭兼容检查' }).click()
  }
  const before = await sceneVersion(page, E01_WORLD)
  const rowsBefore = await revisionRows(page, E01_WORLD)
  const confirmCount = requestCounter(page, '/scene/compatibility/confirm')
  let firstAttempt: { draftId: string; requestId: string; expectedCurrentVersion: number; expectedAttempt: number } | null = null
  let held = false
  await page.route('**/api/worlds/*/scene/compatibility/confirm', async route => {
    if (held) return route.continue()
    held = true
    firstAttempt = route.request().postDataJSON() as typeof firstAttempt
    // 丢弃第一次真实浏览器提交；随后由服务端 recover 封住该 attempt。
    await route.abort()
  })

  const dialog = await startRestoreV1Journey(page, E01_WORLD)
  await buildRepairPreview(dialog)
  await dialog.getByRole('button', { name: '确认保存为新版本' }).click()
  await expect(dialog).toContainText('结果未知', { timeout: 30_000 })
  expect(firstAttempt).toMatchObject({ expectedCurrentVersion: before, expectedAttempt: 0 })
  const originalRequestId = firstAttempt!.requestId

  // Query reports missing; the session calls recover, which persists a tombstone and grants attempt 1.
  await dialog.getByRole('button', { name: '查询提交结果' }).click()
  await expect(dialog.getByRole('button', { name: '确认保存为新版本' })).toBeVisible({ timeout: 30_000 })
  await expect(dialog).toContainText('重试')
  expect(await sceneVersion(page, E01_WORLD)).toBe(before)
  expect(await revisionRows(page, E01_WORLD)).toHaveLength(rowsBefore.length)

  // A late replay of attempt 0 is rejected after recovery has fenced it.
  const late = await page.request.post(`/api/worlds/${E01_WORLD}/scene/compatibility/confirm`, {
    headers: await bearer(page),
    data: { ...firstAttempt!, expectedAttempt: 0 },
  })
  expect(late.status()).toBeGreaterThanOrEqual(400)
  expect(await sceneVersion(page, E01_WORLD)).toBe(before)
  expect(await revisionRows(page, E01_WORLD)).toHaveLength(rowsBefore.length)

  // Explicit user action retries the same request with the server-granted next attempt.
  await dialog.getByRole('button', { name: '确认保存为新版本' }).click()
  await expect(dialog).toContainText(/已保存为新版本 v\d+（历史恢复）/, { timeout: 60_000 })
  expect(await sceneVersion(page, E01_WORLD)).toBe(before + 1)
  expect((await revisionRows(page, E01_WORLD))).toHaveLength(rowsBefore.length + 1)
  expect(confirmCount()).toBe(2)
  const request = await page.request.get(`/api/worlds/${E01_WORLD}/scene/compatibility/requests/${originalRequestId}`, { headers: await bearer(page) })
  expect(request.ok()).toBeTruthy()
  expect(await request.json()).toMatchObject({ status: 'completed', attempt: 1 })
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
})

test('R08 提交仍在处理时前台自动查询，最多查询不自动重交', async ({ page }) => {
  await login(page)
  await enterWorld(page, E01_WORLD)
  if ((await revisionRows(page, E01_WORLD)).length === 1) {
    const setup = await openCurrentDiagnosis(page)
    await buildRepairPreview(setup)
    await confirmToCompleted(setup, '场景修复')
    await setup.getByRole('button', { name: '关闭兼容检查' }).click()
  }
  const before = await sceneVersion(page, E01_WORLD)
  const rowsBefore = await revisionRows(page, E01_WORLD)
  const confirmCount = requestCounter(page, '/scene/compatibility/confirm')
  const queryCount = requestCounter(page, '/scene/compatibility/requests/')
  let finishDelayedConfirm!: () => void
  const delayedConfirmFinished = new Promise<void>(resolve => { finishDelayedConfirm = resolve })
  await page.route('**/api/worlds/*/scene/compatibility/confirm', async route => {
    const response = await route.fetch()
    await new Promise(resolve => setTimeout(resolve, 3_000))
    await route.fulfill({ response })
    finishDelayedConfirm()
  })

  const dialog = await startRestoreV1Journey(page, E01_WORLD)
  await buildRepairPreview(dialog)
  await dialog.getByRole('button', { name: '确认保存为新版本' }).click()
  await expect(dialog).toContainText(/已保存为新版本 v\d+（历史恢复）/, { timeout: 60_000 })
  await delayedConfirmFinished
  await expect.poll(queryCount).toBeGreaterThanOrEqual(1)
  expect(confirmCount()).toBe(1)
  expect(await sceneVersion(page, E01_WORLD)).toBe(before + 1)
  expect(await revisionRows(page, E01_WORLD)).toHaveLength(rowsBefore.length + 1)
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
})

// ── E04：确认前会话撤销后拒绝保存 ────────────────────────────────

test('撤销会话后拒绝预览确认，场景与历史不变', async ({ page }) => {
  await login(page)
  await enterWorld(page, E01_WORLD)
  // Isolated runs start with only the invalid v1 as current; create a genuine
  // valid successor first so the logout check can target the historical v1.
  if ((await revisionRows(page, E01_WORLD)).length === 1) {
    const setup = await openCurrentDiagnosis(page)
    await buildRepairPreview(setup)
    await confirmToCompleted(setup, '场景修复')
    await setup.getByRole('button', { name: '关闭兼容检查' }).click()
  }
  const before = await sceneVersion(page, E01_WORLD)
  const rowsBefore = await revisionRows(page, E01_WORLD)
  const headers = await bearer(page)
  const dialog = await startRestoreV1Journey(page, E01_WORLD)
  let previewDraftId: string | null = null
  const captureDraft = async (response: PlaywrightResponse) => {
    if (response.request().method() !== 'POST' || !response.url().includes(`/worlds/${E01_WORLD}/scene/compatibility/drafts`)) return
    const body = await response.json().catch(() => null) as { id?: string } | null
    if (body?.id) previewDraftId = body.id
  }
  page.on('response', captureDraft)
  await buildRepairPreview(dialog)
  page.off('response', captureDraft)
  expect(previewDraftId).toBeTruthy()

  const logout = await page.request.post('/api/auth/logout', { headers })
  expect(logout.ok()).toBeTruthy()
  // Logout invalidates the page session and may route the preview UI to /login.
  // Send the user's explicit confirm against the actual preview draft with a
  // browser-generated requestId so the test still observes the real 401 boundary.
  const requestId = await page.evaluate(() => crypto.randomUUID())
  const confirm = await page.request.post(`/api/worlds/${E01_WORLD}/scene/compatibility/confirm`, {
    headers,
    data: { draftId: previewDraftId, requestId, expectedCurrentVersion: before, expectedAttempt: 0 },
  })
  expect(confirm.status()).toBe(401)
  const request = await page.request.get(`/api/worlds/${E01_WORLD}/scene/compatibility/requests/${requestId}`, { headers })
  expect(request.status()).toBe(401)

  // Reauthenticate through the UI, then verify the persisted scene and history.
  const verifier = await page.context().newPage()
  await login(verifier)
  expect(await sceneVersion(verifier, E01_WORLD)).toBe(before)
  expect(await revisionRows(verifier, E01_WORLD)).toEqual(rowsBefore)
  await verifier.close()
})

// ── W42：修复旅程前后生活资料原样保留 ─────────────────────────────

test('保留生活进度：修复旅程前后居民行程与人物身份原样保留', async ({ page }) => {
  await login(page)
  const headers = await bearer(page)
  const residentId = 'a1-e01-resident-ada'
  interface PersonDetail {
    person: { id: string; name: string }
    world: { id: string } | null
    state: { personId: string; timelineId: string; simTime: string; location: string; activity: string } | null
    timelines: Array<{ id: string }>
  }
  const readPerson = async () => {
    const res = await page.request.get(`/api/persons/${residentId}`, { headers })
    expect(res.ok()).toBeTruthy()
    return await res.json() as PersonDetail
  }
  const before = await readPerson()
  expect(before.world?.id).toBe(E01_WORLD)
  expect(before.state).not.toBeNull()

  // 真实修复旅程（restore-history v1）
  // The source legacy world is read-only; the E01 copy carries valid universe evidence.
  await enterWorld(page, E01_WORLD)
  if ((await revisionRows(page, E01_WORLD)).length === 1) {
    const setup = await openCurrentDiagnosis(page)
    await buildRepairPreview(setup)
    await confirmToCompleted(setup, '场景修复')
    await setup.getByRole('button', { name: '关闭兼容检查' }).click()
  }
  const versionBefore = await sceneVersion(page, E01_WORLD)
  const dialog = await startRestoreV1Journey(page, E01_WORLD)
  await buildRepairPreview(dialog)
  await confirmToCompleted(dialog, '历史恢复')
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  expect(await sceneVersion(page, E01_WORLD)).toBe(versionBefore + 1)

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
  // 缺口（如实记录）：fixture 记忆行（a1-e01-memory-1）没有 HTTP 列表/读取端点
  // （/api/memories 只有校正/删除），记忆内容保留无法经公开路由核对；
  // 任务书的“修复期间追加真实 conversation/事件”依赖生活 LLM 链路，本环境不确定，未覆盖。
})

test('A9.4 登出期间迟到的旧世界诊断不进入新账号页面', async ({ page }) => {
  await login(page)
  await enterWorld(page, E01_WORLD)
  const ownerId = (await (await page.request.get('/api/auth/me', { headers: await bearer(page) })).json() as { user: { id: string } }).user.id

  let releaseInspection!: () => void
  let markInspectionEntered!: () => void
  const inspectionEntered = new Promise<void>(resolve => { markInspectionEntered = resolve })
  const inspectionGate = new Promise<void>(resolve => { releaseInspection = resolve })
  await page.route(`**/api/worlds/${E01_WORLD}/scene/compatibility/inspection**`, async route => {
    const response = await route.fetch()
    markInspectionEntered()
    await inspectionGate
    await route.fulfill({ response })
  })

  await page.getByTestId('scene-check-entry').click()
  await inspectionEntered
  // The compatibility dialog covers the map header while the inspection is pending.
  // Open the real settings disclosure and invoke its logout control during the request.
  await page.locator('details summary[aria-label="设置"]').evaluate(summary => (summary as HTMLElement).click())
  await page.getByRole('button', { name: '退出登录' }).evaluate(button => (button as HTMLButtonElement).click())
  await page.waitForURL(/\/login/)
  const afterLogout = await page.evaluate(() => localStorage.getItem('possibility:scene-compatibility:v1'))
  expect(afterLogout ?? '').not.toContain(`${ownerId}\u0000${E01_WORLD}`)

  await login(page, SECOND)
  await enterWorld(page, SECOND_WORLD)
  releaseInspection()
  await expect(page.getByTestId('scene-check-entry')).toBeVisible()
  await expect(compatDialog(page)).toHaveCount(0)
  const newActorId = (await (await page.request.get('/api/auth/me', { headers: await bearer(page) })).json() as { user: { id: string } }).user.id
  expect(newActorId).not.toBe(ownerId)
  const records = await page.evaluate(() => {
    const raw = localStorage.getItem('possibility:scene-compatibility:v1')
    return raw ? Object.keys((JSON.parse(raw) as { records: Record<string, unknown> }).records) : []
  })
  expect(records).not.toContain(`${ownerId}\u0000${E01_WORLD}`)
  expect(records.some(key => key.startsWith(`${newActorId}\u0000`))).toBe(false)
})
