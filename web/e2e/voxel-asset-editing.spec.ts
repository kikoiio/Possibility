import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

/**
 * S2b 资产拖拽编辑 e2e（AC1-AC6/AC9）。
 * ① 拖放放置：合法落地 + 重叠拒绝（asset-overlap）
 * ② 点选移动 / R 旋转 / 删除 / Esc 解除
 * ③ 产品页：放置 → 防抖保存 voxel-revision → 刷新后仍在
 * ④ guest 无编辑入口
 * 坐标已用契约包反序列化 fixture 验证：候选格 y0 实、y1/y2 空。
 */

const voxelDoc = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))

interface Placement { id?: string; assetId: string; anchor: [number, number, number] | { x: number; y: number; z: number }; rotation: number }
interface WorldProbe { getAssetPlacements(): Placement[]; getAssetInstanceCount(): number }
interface PerfProbe { timedEdit(ops: unknown[]): number }
interface EngineProbe {
  worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null
  feedback: { assetGhostActive: boolean }
  world: { doc: { assetPlacements?: Placement[] } }
}

declare global {
  interface Window { __voxelWorld?: WorldProbe; __voxelPerf?: PerfProbe; __voxelEngine?: EngineProbe }
}

async function openDev(page: Page) {
  await page.goto('/dev/voxel')
  await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 15000 })
  await page.waitForTimeout(400)
}

function placements(page: Page): Promise<Placement[]> {
  return page.evaluate(() => window.__voxelWorld!.getAssetPlacements())
}

async function toScreen(page: Page, at: { x: number; y: number; z: number }) {
  return page.evaluate((cell) => window.__voxelEngine!.worldToScreen(cell)!, at)
}

/** 经引擎探针直接落一个资产（选择/移动/旋转/删除用例的前置，不经 UI）；等 GLB 原型异步加载出实例 */
async function seedAsset(page: Page, assetId: string, anchor: { x: number; y: number; z: number }) {
  const before = await page.evaluate(() => window.__voxelWorld!.getAssetInstanceCount())
  await page.evaluate(([id, at]) => {
    window.__voxelPerf!.timedEdit([{ kind: 'place-asset', assetId: id, anchor: at, rotation: 0 }])
  }, [assetId, anchor] as const)
  await expect.poll(() => page.evaluate(() => window.__voxelWorld!.getAssetInstanceCount())).toBe(before + 1)
}

async function armFlower(page: Page) {
  await page.getByTestId('voxel-tool-asset').click()
  await page.getByTestId('voxel-asset-item-veg-flower-a').click()
}

/** 点击已放置的小屋（锚点 34,1,40，2×2 实心建筑，瞄几何中心；树干太细点不中，勿用植被做选择用例） */
async function clickHut(page: Page) {
  const at = await toScreen(page, { x: 34.5, y: 1.3, z: 40.5 })
  await page.mouse.click(at.x, at.y)
}

test.describe('S2b 资产摆放编辑（dev 页）', () => {
  test('拖放放置：合法落地，重叠拒绝', async ({ page }) => {
    await openDev(page)
    const before = (await placements(page)).length
    await page.getByTestId('voxel-tool-asset').click()

    // 合法：拖到空地 (24,1,42)
    const dropAt = await toScreen(page, { x: 24, y: 1, z: 42 })
    await page.dragAndDrop('[data-testid="voxel-asset-item-veg-flower-a"]', '[data-testid="voxel-canvas"]', { targetPosition: { x: dropAt.x, y: dropAt.y } })
    await expect.poll(async () => (await placements(page)).length).toBe(before + 1)

    // 非法：同一位置再拖一棵 → asset-overlap 拒绝，计数不变
    await page.dragAndDrop('[data-testid="voxel-asset-item-veg-flower-a"]', '[data-testid="voxel-canvas"]', { targetPosition: { x: dropAt.x, y: dropAt.y } })
    await expect(page.getByTestId('voxel-edit-rejected')).toBeVisible()
    expect((await placements(page)).length).toBe(before + 1)
  })

  test('armed 点击放置后保持 armed，Esc 解除', async ({ page }) => {
    await openDev(page)
    const before = (await placements(page)).length
    await armFlower(page)

    // 悬停出 ghost → Esc 解除 armed 与 ghost
    const hover = await toScreen(page, { x: 24, y: 1, z: 44 })
    await page.mouse.move(hover.x, hover.y)
    await expect.poll(() => page.evaluate(() => window.__voxelEngine!.feedback.assetGhostActive)).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => window.__voxelEngine!.feedback.assetGhostActive)).toBe(false)

    // 解除后点击空地不产生摆放
    await page.mouse.click(hover.x, hover.y)
    await page.waitForTimeout(300)
    expect((await placements(page)).length).toBe(before)
  })

  test('点选移动：选中小屋 → 点空地搬过去', async ({ page }) => {
    await openDev(page)
    await seedAsset(page, 'bld-hut-a', { x: 34, y: 1, z: 40 })
    const before = (await placements(page)).length
    await page.getByTestId('voxel-tool-asset').click()

    await clickHut(page)
    await expect(page.getByTestId('voxel-asset-actions')).toBeVisible()

    const target = await toScreen(page, { x: 38, y: 1, z: 44 })
    await page.mouse.click(target.x, target.y)
    await expect.poll(async () => {
      const tree = (await placements(page)).find((p) => p.assetId === 'bld-hut-a')
      if (!tree) return null
      const anchor = Array.isArray(tree.anchor) ? { x: tree.anchor[0], z: tree.anchor[2] } : { x: tree.anchor.x, z: tree.anchor.z }
      return `${anchor.x},${anchor.z}`
    }).toBe('38,44')
    expect((await placements(page)).length).toBe(before)
  })

  test('R 旋转 90° 步进', async ({ page }) => {
    await openDev(page)
    await seedAsset(page, 'bld-hut-a', { x: 34, y: 1, z: 40 })
    await page.getByTestId('voxel-tool-asset').click()
    await clickHut(page)
    await expect(page.getByTestId('voxel-asset-actions')).toBeVisible()

    const rotationOf = async () => (await placements(page)).find((p) => p.assetId === 'bld-hut-a')?.rotation ?? -1
    const before = await rotationOf()
    await page.keyboard.press('r')
    await expect.poll(rotationOf).toBe((before + 1) % 4)
  })

  test('删除选中摆放', async ({ page }) => {
    await openDev(page)
    await seedAsset(page, 'bld-hut-a', { x: 34, y: 1, z: 40 })
    const before = (await placements(page)).length
    await page.getByTestId('voxel-tool-asset').click()
    await clickHut(page)
    await expect(page.getByTestId('voxel-asset-actions')).toBeVisible()
    await page.getByTestId('voxel-asset-remove').click()
    await expect.poll(async () => (await placements(page)).length).toBe(before - 1)
  })
})

/* ===== 产品页：保存-刷新-保持 ===== */

const snapshot = {
  world: { id: 'world-1', name: '雾影庄', description: '体素世界', status: 'running', pauseReason: null, isDemo: false, callsToday: 0, locations: [{ name: '主楼', description: '庄园主楼' }] },
  timelines: [{ id: 'timeline-main', parentTimelineId: null, status: 'active', simNow: '2026-09-19T12:00:00.000Z' }],
  currentTimelineId: 'timeline-main',
  simNow: '2026-09-19T12:00:00.000Z',
  stateVersion: 1,
  worldModelVersion: 1,
  evidenceStatus: 'structured',
  evidence: { level: 'complete', reasonCodes: [] },
  currentFacts: [],
  locationBoard: [{ location: '主楼', persons: [{ id: 'person-1', name: '小夜', activity: '读书' }] }],
  events: [],
}

/** A1:服务端 preflight 的真实形状——valid 候选携带完整依据。 */
function preflightValid(version: number) {
  return {
    status: 'valid',
    basis: {
      expectedCurrentVersion: version,
      currentContentHash: 'e2e-hash',
      source: { worldId: 'world-1', version, contentHash: 'e2e-hash' },
      candidateHash: 'sha256:e2e-candidate',
      rulesVersion: 'rules-1', assetManifestHash: 'assets-1', templateCatalogHash: 'templates-1',
      bindingHash: 'bindings-1', contextFingerprint: 'context-1', baseline: null,
    },
    report: {
      status: 'valid', issues: [], issueCount: 0, countIsExact: true, stopReason: null,
      checkedSpaceIds: ['exterior'], pendingSpaceIds: [], workUnitsUsed: 1, elapsedMs: 1,
      ruleNotes: { items: [], total: 0, hasMore: false },
    },
  }
}

test('产品页：放置资产 → 保存 → 刷新仍在；guest 无编辑入口', async ({ page }) => {
  // 可变存档:bootstrap/GET scene 读它,voxel-revision 写它
  let currentDoc = structuredClone(voxelDoc)
  let currentVersion = 5
  let lastExpectedVersion: number | null = null

  await page.addInitScript(() => {
    localStorage.setItem('possibility_token', 'e2e-token')
    localStorage.setItem('possibility:flag:voxel', '1')
  })
  await page.route('**/api/worlds', (route) => route.fulfill({ json: { worlds: [{ id: 'world-1', name: '雾影庄' }] } }))
  await page.route('**/api/worlds/world-1/stream**', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }))
  await page.route('**/api/worlds/world-1/map/bootstrap**', (route) => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
    world: snapshot,
    scene: { status: 'ready', document: currentDoc },
    presentation: { timelineId: 'timeline-main', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
    theme: { id: 'mist-manor', assetVersion: 'e2e' },
    resume: { worldId: 'world-1', timelineId: 'timeline-main', spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow },
  } }))
  await page.route('**/api/worlds/world-1/map/resume', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/worlds/world-1/persona**', (route) => route.fulfill({ json: { persona: null, unread: 0 } }))
  await page.route('**/api/worlds/world-1/state**', (route) => route.fulfill({ json: { timelineId: 'timeline-main', version: 1, worldModelVersion: 1, evidenceStatus: 'structured', current: [], facts: [] } }))
  await page.route('**/api/worlds/world-1/return**', (route) => route.fulfill({ json: { timelineId: 'timeline-main', simNow: snapshot.simNow, firstVisit: false, cursor: 0, events: [], commitments: [], unread: 0 } }))
  await page.route('**/api/worlds/world-1/scene**', (route) => route.fulfill({ json: { status: 'ready', document: currentDoc, version: currentVersion, contentHash: 'e2e-hash', createdAt: snapshot.simNow } }))
  // 注意:Playwright 后注册的路由优先,voxel-revision 必须排在通用 scene** 之后注册
  await page.route('**/api/worlds/world-1/scene/voxel-revision', (route) => {
    const body = route.request().postDataJSON() as { expectedVersion: number; document: typeof voxelDoc }
    lastExpectedVersion = body.expectedVersion
    currentDoc = body.document
    currentVersion += 1
    return route.fulfill({ json: { document: currentDoc, version: currentVersion, contentHash: 'e2e-hash', createdAt: snapshot.simNow } })
  })
  // A1:放置资产先经服务端完整 preflight 再落引擎;显式 stub 排在通用 scene** 之后注册
  const preflightRequests: unknown[] = []
  await page.route('**/api/worlds/world-1/scene/compatibility/preflight', (route) => {
    preflightRequests.push(route.request().postDataJSON())
    return route.fulfill({ json: preflightValid(currentVersion) })
  })

  await page.goto('/worlds/world-1')
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  await expect(page.getByTestId('voxel-editor-toolbar')).toBeVisible()

  // 放一盆花到 (24,1,42)
  await page.getByTestId('voxel-tool-asset').click()
  await page.getByTestId('voxel-asset-item-veg-flower-a').click()
  const dropAt = await toScreen(page, { x: 24, y: 1, z: 42 })
  await page.mouse.click(dropAt.x, dropAt.y)
  await page.keyboard.press('Escape')

  // 防抖保存(800ms)落盘:版本对齐 GET scene 的 5,存档里多出 1 条摆放
  await expect.poll(() => lastExpectedVersion, { timeout: 5000 }).toBe(5)
  expect((currentDoc.assetPlacements ?? []).length).toBe(1)
  // A1:保存前先经过完整候选预检(operations 形态)
  expect(preflightRequests.length).toBeGreaterThanOrEqual(1)
  expect((preflightRequests[0] as { candidate: { kind: string } }).candidate.kind).toBe('operations')

  // 刷新:bootstrap 返回已保存文档,摆放仍在
  await page.reload()
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  await expect.poll(() => page.evaluate(() => window.__voxelEngine!.world.doc.assetPlacements?.length ?? 0)).toBe(1)
})

test('guest 演示世界无编辑入口', async ({ page }) => {
  const guestSession = {
    token: 'guest-voxel-token', sessionId: 'session-voxel', worldId: 'demo', timelineId: 'main',
    generation: 1, expiresAt: '2026-09-29T12:00:00.000Z',
  }
  const guestSnapshot = {
    world: { id: 'demo', name: '雾影庄', description: '白雾町的旧宅', status: 'running', pauseReason: null, isDemo: true, callsToday: 0, locations: [{ name: '主楼', description: '主楼' }] },
    timelines: [{ id: 'main', parentTimelineId: null, simNow: '2026-09-28T12:00:00.000Z' }], currentTimelineId: 'main', simNow: '2026-09-28T12:00:00.000Z',
    stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [],
    locationBoard: [{ location: '主楼', persons: [{ id: 'person-host', name: '主人', activity: '读书' }] }],
    events: [],
  }
  await page.addInitScript(() => localStorage.setItem('possibility:flag:voxel', '1'))
  await page.route('**/api/demo/session', (route) => route.fulfill({ json: guestSession }))
  await page.route('**/api/worlds/demo/map/bootstrap**', (route) => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: false, resetDemo: true },
    world: guestSnapshot,
    scene: { status: 'ready', document: voxelDoc },
    presentation: { timelineId: 'main', stateVersion: 1, simNow: guestSnapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
    theme: { id: 'mist-manor', assetVersion: 'fixture' },
    resume: { worldId: 'demo', timelineId: 'main', spaceId: 'exterior', mode: 'life', updatedAt: guestSnapshot.simNow },
  } }))
  await page.route('**/api/worlds/demo/map/resume', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/worlds/demo/persona**', (route) => route.fulfill({ json: { persona: null, unread: 0 } }))
  await page.route('**/api/worlds/demo/state**', (route) => route.fulfill({ json: { version: 1 } }))

  await page.goto('/')
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  // 只读:不渲染编辑工具栏与资产面板入口
  await expect(page.getByTestId('voxel-editor-toolbar')).toHaveCount(0)
  await expect(page.getByTestId('voxel-tool-asset')).toHaveCount(0)
})
