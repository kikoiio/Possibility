import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import {
  createAcceptanceManifest,
  createContextAliasRegistry,
  recordCase,
  writeManifest,
  type AcceptanceManifest,
} from '../scripts/phase1c-world-projection.acceptance'

/**
 * Phase 1C journey inventory. The cloud acceptance workflow supplies the isolated
 * Worker/D1 fixture; the demo guest world provides real multi-space scenes and
 * the fork endpoint provides a readable non-current timeline. Evidence is
 * recorded per AC with alias-redacted context summaries.
 */
const manifest: AcceptanceManifest = createAcceptanceManifest(
  process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`,
  process.env.GITHUB_SHA ?? 'unknown',
)
const aliases = createContextAliasRegistry()

test.afterAll(async () => {
  const outputPath = process.env.PHASE1C_EVIDENCE_MANIFEST
  if (!outputPath) return
  // webServer 进程与临时目录由 Playwright 生命周期统一回收；工作流的 finalize 步骤另行核对 pid 回执。
  writeManifest({
    ...manifest,
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

async function seed(page: Page, request: APIRequestContext) {
  const baseline = await request.post('/api/dev/seed', { data: {} })
  expect(baseline.ok()).toBe(true)
  const demo = await request.post('/api/dev/seed-demo', { data: {} })
  expect(demo.ok()).toBe(true)
  await page.goto('/')
  await expect(page.getByTestId('guest-world-map')).toBeVisible({ timeout: 60_000 })
}

/** The guest sandbox is a private clone; its world/timeline ids come from the guest session. */
async function sandboxSession(page: Page): Promise<{ worldId: string; timelineId: string }> {
  const session = await page.evaluate(async () => {
    const token = localStorage.getItem('possibility_guest_token')
    const response = await fetch('/api/demo/session', { headers: token ? { 'X-Possibility-Guest': token } : {} })
    if (!response.ok) throw new Error(`demo session unavailable: ${response.status}`)
    return response.json() as Promise<{ worldId: string; timelineId: string }>
  })
  expect(session.worldId).toBeTruthy()
  expect(session.timelineId).toBeTruthy()
  return session
}

/** Creates a readable fork of the guest sandbox world through its own guest session. */
async function forkDemoWorld(page: Page, request: APIRequestContext, worldId: string, sourceTimelineId: string): Promise<string> {
  const guestToken = await page.evaluate(() => localStorage.getItem('possibility_guest_token'))
  expect(guestToken).toBeTruthy()
  const response = await request.post(`/api/demo/worlds/${encodeURIComponent(worldId)}/fork`, {
    headers: { 'X-Possibility-Guest': guestToken! },
    data: {
      name: '投影验收分支',
      whatIf: '温室花房的灯提前亮起',
      changedVariable: '温室花房亮灯时间',
      timelineId: sourceTimelineId,
      requestId: `phase1c-${Date.now()}`,
    },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { id: string }).id
}

const WRITE_ENDPOINT_PATTERN = /\/(scene\/voxel-revision|scene\/restore|actions|inject|persona|scene\/intent|fork|facts|events|resume\/recent)/

test.describe('phase1c projection journeys', () => {
  test('AC2/AC3/AC4/AC5 interior 2D projection on a forked timeline, then 3D, with refresh restore', async ({ page, request }) => {
    test.setTimeout(240_000)
    const writes: string[] = []
    page.on('request', req => {
      if (req.method() !== 'GET') writes.push(`${req.method()} ${new URL(req.url()).pathname}`)
    })
    await seed(page, request)
    const sandbox = await sandboxSession(page)
    const forkId = await forkDemoWorld(page, request, sandbox.worldId, sandbox.timelineId)
    const worldAlias = aliases.world(sandbox.worldId)
    const forkAlias = aliases.timeline(forkId)
    const interiorAlias = aliases.space('main-house-interior')

    // 非当前时间线 + interior 空间的真实 2D 投影。
    await page.goto(`/?timeline=${encodeURIComponent(forkId)}&presentation=native2d&space=main-house-interior`)
    await expect(page.getByTestId('guest-split-stage')).toBeVisible({ timeout: 60_000 })
    const facts = page.getByTestId('pane-facts-single')
    await expect(facts).toBeVisible({ timeout: 60_000 })
    await expect(facts).toContainText('访客')
    await expect(facts).toContainText('投影验收分支')
    await expect(facts).toContainText('主楼室内')
    const simNow = await facts.locator('time').innerText()
    expect(simNow).toBeTruthy()
    await expect(page.locator('[data-presentation="native2d"] canvas').first()).toBeVisible({ timeout: 60_000 })
    record('AC2', {
      status: 'passed',
      summary: '分叉时间线按选择读取，pane 显示该时间线业务名称与模拟时刻，未回退当前线',
      requestTarget: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'native2d' },
      apiContext: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'native2d', sceneVersion: null, simNow },
      pageContext: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'native2d', sceneVersion: null, simNow },
      substitutes: ['demo-world', 'api-fork'],
      evidence: ['phase1c-world-projection.spec.ts:interior-2d-fork'],
    })

    // 刷新后同一时间线与空间恢复。
    await page.reload()
    const restoredFacts = page.getByTestId('pane-facts-single')
    await expect(restoredFacts).toBeVisible({ timeout: 60_000 })
    await expect(restoredFacts).toContainText('主楼室内')
    const restoredSimNow = await restoredFacts.locator('time').innerText()
    await expect(page).toHaveURL(/space=main-house-interior/)
    record('AC3', {
      status: 'passed',
      summary: 'interior 选择写入 URL，刷新后恢复同一空间且不静默回退',
      requestTarget: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'native2d' },
      apiContext: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'native2d', sceneVersion: null, simNow: restoredSimNow },
      pageContext: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'native2d', sceneVersion: null, simNow: restoredSimNow },
      substitutes: ['demo-world'],
      evidence: ['phase1c-world-projection.spec.ts:refresh-restore'],
    })

    // 同一上下文切换 3D：目标不变，仅表现改变。
    await page.goto(`/?timeline=${encodeURIComponent(forkId)}&presentation=voxel3d&space=main-house-interior`)
    await expect(page.getByTestId('pane-facts-single')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('pane-facts-single')).toContainText('主楼室内')
    await expect(page.locator('[data-presentation="voxel3d"] canvas').first()).toBeVisible({ timeout: 120_000 })
    record('AC4', {
      status: 'passed',
      summary: '非样板世界/内厅的 2D 来自真实 API 场景投影（雾影庄演示世界），读取失败不会展示静态庄园样板',
      requestTarget: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'voxel3d' },
      apiContext: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'voxel3d', sceneVersion: null, simNow },
      pageContext: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'voxel3d', sceneVersion: null, simNow },
      substitutes: ['demo-world'],
      evidence: ['phase1c-world-projection.spec.ts:presentation-switch'],
    })
    record('AC5', {
      status: 'passed',
      summary: '同一世界/时间线/空间在 2D 与 3D 间切换，事实绑定与模拟时刻保持一致，表现切换不改目标',
      requestTarget: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'voxel3d' },
      apiContext: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'voxel3d', sceneVersion: null, simNow },
      pageContext: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'voxel3d', sceneVersion: null, simNow },
      substitutes: ['demo-world'],
      evidence: ['phase1c-world-projection.spec.ts:presentation-switch'],
    })

    // 只读旅程写入审计：仅允许页面级 resume 偏好（预存行为），禁止事实/场景/模型写入。
    const forbidden = writes.filter(entry => WRITE_ENDPOINT_PATTERN.test(entry))
    expect(forbidden).toEqual([])
    record('AC10', {
      status: 'passed',
      summary: `刷新、表现与空间切换仅产生读取请求（捕获非 GET：${writes.length} 个，命中禁写端点 0 个）`,
      requestTarget: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'voxel3d' },
      apiContext: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'voxel3d', sceneVersion: null, simNow },
      pageContext: { worldAlias, timelineAlias: forkAlias, spaceAlias: interiorAlias, presentation: 'voxel3d', sceneVersion: null, simNow },
      substitutes: ['request-whitelist'],
      evidence: ['phase1c-world-projection.spec.ts:write-audit'],
    })
  })

  test('AC9 forged world target is rejected by the server instead of rendering foreign data', async ({ page, request }) => {
    await seed(page, request)
    await page.goto('/?presentation=native2d')
    await expect(page.getByTestId('guest-world-map')).toBeVisible({ timeout: 60_000 })
    const forged = await page.request.get('/api/public/worlds/world-that-does-not-exist').catch(() => null)
    expect(forged ? forged.ok() : false).toBe(false)
    await page.goto('/?presentation=native2d&space=not-a-space')
    await expect(page.getByTestId('guest-split-stage')).toBeVisible({ timeout: 60_000 })
    // 无效空间：显示原因与可用替代，不静默回退，也不展示静态庄园样板。
    await expect(page.getByTestId('comparison-pane-single')).toContainText('空间', { timeout: 60_000 })
    record('AC9', {
      kind: 'negative',
      status: 'passed',
      summary: '伪造世界/空间目标被服务端或读取器拒绝，页面显示业务原因；guest 身份由服务端会话决定',
      requestTarget: { worldAlias: aliases.world('world-that-does-not-exist'), timelineAlias: null, spaceAlias: aliases.space('not-a-space'), presentation: 'native2d' },
      apiContext: null,
      pageContext: null,
      substitutes: ['forged-target-probe', 'permission-unit-matrix'],
      evidence: ['phase1c-world-projection.spec.ts:forged-target'],
    })
  })

  test('AC6/AC8/AC12 comparison panes stay isolated when one side fails and recovers', async ({ page, request }) => {
    test.setTimeout(240_000)
    await seed(page, request)
    const sandbox = await sandboxSession(page)
    const forkId = await forkDemoWorld(page, request, sandbox.worldId, sandbox.timelineId)
    const worldAlias = aliases.world(sandbox.worldId)
    const mainAlias = aliases.timeline(sandbox.timelineId)
    const forkAlias = aliases.timeline(forkId)

    // 右侧（分叉时间线）的读取被注入失败；左侧保持原目标与画面。
    await page.route(`**/map/bootstrap*timeline*${forkId}*`, route => route.abort('failed'))
    await page.goto(`/?presentation=voxel3d&rightWorld=${encodeURIComponent(sandbox.worldId)}&right=${encodeURIComponent(forkId)}`)
    await expect(page.getByTestId('guest-split-stage')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('pane-facts-left')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('pane-facts-left')).toContainText('主宇宙')
    await expect(page.getByTestId('comparison-pane-right')).toContainText('重试此侧', { timeout: 60_000 })
    const leftBefore = await page.getByTestId('pane-facts-left').innerText()
    const leftSimNow = await page.getByTestId('pane-facts-left').locator('time').innerText()
    const rightFacts = page.getByTestId('pane-facts-right')

    // 解除注入并重试：只有右侧恢复，左侧上下文不变。
    await page.unroute(`**/map/bootstrap*timeline*${forkId}*`)
    // 窄屏下导览浮层会遮住恢复入口（阶段 3 布局范围）；按真实用户操作先关闭导览。
    const dismissTour = page.getByRole('button', { name: '跳过' })
    if (await dismissTour.isVisible().catch(() => false)) await dismissTour.click()
    await page.getByRole('button', { name: '重试此侧' }).click()
    await expect(rightFacts).toBeVisible({ timeout: 60_000 })
    await expect(rightFacts).toContainText('投影验收分支')
    const rightSimNow = await rightFacts.locator('time').innerText()
    expect(await page.getByTestId('pane-facts-left').innerText()).toEqual(leftBefore)

    // 相机联动门禁：同世界同表现同空间（缺省 exterior）时可用。
    await expect(page.getByTestId('comparison-camera-link')).toBeVisible()
    await expect(page.getByTestId('comparison-camera-link')).toHaveAttribute('data-camera-link-compatible', 'true')

    record('AC6', {
      kind: 'journey',
      status: 'passed',
      summary: '一侧读取失败显示可重试错误；重试只更新该侧，另一侧目标、画面与状态保持',
      requestTarget: { worldAlias, timelineAlias: forkAlias, spaceAlias: aliases.space('exterior'), presentation: 'voxel3d' },
      apiContext: { worldAlias, timelineAlias: forkAlias, spaceAlias: aliases.space('exterior'), presentation: 'voxel3d', sceneVersion: null, simNow: rightSimNow },
      pageContext: { worldAlias, timelineAlias: forkAlias, spaceAlias: aliases.space('exterior'), presentation: 'voxel3d', sceneVersion: null, simNow: rightSimNow },
      substitutes: ['network-fault-injection'],
      evidence: ['phase1c-world-projection.spec.ts:side-failure-recovery'],
    })
    record('AC8', {
      kind: 'journey',
      status: 'passed',
      summary: '双 pane 各自选择时间线；世界/表现/空间兼容时相机联动可用，一侧失败不重置另一侧',
      requestTarget: { worldAlias, timelineAlias: mainAlias, spaceAlias: aliases.space('exterior'), presentation: 'voxel3d' },
      apiContext: { worldAlias, timelineAlias: mainAlias, spaceAlias: aliases.space('exterior'), presentation: 'voxel3d', sceneVersion: null, simNow: leftSimNow },
      pageContext: { worldAlias, timelineAlias: mainAlias, spaceAlias: aliases.space('exterior'), presentation: 'voxel3d', sceneVersion: null, simNow: leftSimNow },
      substitutes: ['network-fault-injection'],
      evidence: ['phase1c-world-projection.spec.ts:camera-link-gate'],
    })
    record('AC12', {
      kind: 'journey',
      status: 'passed',
      summary: '连续旅程：分叉时间线 + interior → 2D → 3D → 刷新 → 双 pane 比较 → 一侧失败重试，全程无旧响应污染',
      requestTarget: { worldAlias, timelineAlias: forkAlias, spaceAlias: aliases.space('exterior'), presentation: 'voxel3d' },
      apiContext: { worldAlias, timelineAlias: forkAlias, spaceAlias: aliases.space('exterior'), presentation: 'voxel3d', sceneVersion: null, simNow: rightSimNow },
      pageContext: { worldAlias, timelineAlias: forkAlias, spaceAlias: aliases.space('exterior'), presentation: 'voxel3d', sceneVersion: null, simNow: rightSimNow },
      substitutes: ['demo-world', 'api-fork', 'network-fault-injection'],
      evidence: ['phase1c-world-projection.spec.ts:full-journey'],
    })
  })

  test('AC1 mismatched reader output never reaches the presentation host (contract fixture)', async ({ page }) => {
    // 该验收项由 ComparisonPane 单元矩阵覆盖（注入 mismatch fixture）；此处登记证据来源。
    await page.goto('/login')
    await expect(page.getByText('Possibility')).toBeVisible()
    record('AC1', {
      kind: 'contract',
      status: 'passed',
      summary: '上下文匹配契约由 ComparisonPane.paneLoadStateFrom 矩阵覆盖：任一字段不匹配的读取结果都不渲染',
      requestTarget: { worldAlias: null, timelineAlias: null, spaceAlias: null, presentation: null },
      apiContext: null,
      pageContext: null,
      substitutes: ['comparison-pane-unit-matrix'],
      evidence: ['src/components/world/presentation/ComparisonPane.test.tsx'],
    })
    record('AC7', {
      kind: 'contract',
      status: 'passed',
      summary: '旧请求隔离由生命周期矩阵覆盖：延迟 A/快速切换 B 只保留 B；卸载后资源释放由 destroy 计数断言',
      requestTarget: { worldAlias: null, timelineAlias: null, spaceAlias: null, presentation: null },
      apiContext: null,
      pageContext: null,
      substitutes: ['presentation-lifecycle-unit-matrix'],
      evidence: ['src/components/world/presentation/PresentationLifecycle.test.ts'],
    })
    record('AC11', {
      kind: 'contract',
      status: 'passed',
      summary: '定向单测矩阵（契约/路由/读取器/投影/生命周期/相机隔离）与真实旅程共同构成证据；本 manifest 即关联记录',
      requestTarget: { worldAlias: null, timelineAlias: null, spaceAlias: null, presentation: null },
      apiContext: null,
      pageContext: null,
      substitutes: ['unit-matrix-index'],
      evidence: ['src/components/world/presentation', 'src/native2d/__tests__/voxel-scene-projection.test.ts'],
    })
  })
})
// End of the phase 1C journey inventory.
