import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const voxelDoc = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))
const now = '2026-10-01T00:00:00.000Z'
const snapshot = {
  world: { id: 'world-1', name: '雾影庄', description: '白雾町的旧宅。', status: 'paused', pauseReason: 'manual', isDemo: false, callsToday: 0, timeZone: 'UTC', locations: [{ name: '主楼', description: '旧宅' }] },
  timelines: [{ id: 'timeline-1', parentTimelineId: null, simNow: now }], currentTimelineId: 'timeline-1', simNow: now,
  stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] },
  currentFacts: [], locationBoard: [{ location: '主楼', persons: [{ id: 'person-1', name: 'Ada', activity: '正在安顿' }] }], events: [],
}
const revisions = [
  { version: 2, parentVersion: 1, summary: '庭院加入石灯', kind: 'voxel-edit', createdAt: '2026-10-01T01:00:00.000Z' },
  { version: 1, parentVersion: null, summary: '开始生活时的场景', kind: 'initial', createdAt: '2026-10-01T00:00:00.000Z' },
]

/** A1(W46):历史恢复前的真实 precheck——有效目标走原快速通道。 */
const inspectionValid = {
  status: 'ready',
  source: { worldId: 'world-1', version: 1, contentHash: 'hash-v1' },
  basis: {
    expectedCurrentVersion: 2,
    currentContentHash: 'hash-v2',
    contextFingerprint: 'ctx',
    bindingHash: 'bind',
    rulesVersion: 'rules-1',
    assetManifestHash: 'assets-1',
    templateCatalogHash: 'templates-1',
    baseline: null,
    source: { worldId: 'world-1', version: 1, contentHash: 'hash-v1' },
    candidateHash: null,
  },
  report: {
    status: 'valid', issues: [], issueCount: 0, countIsExact: true,
    ruleNotes: { items: [], total: 0, hasMore: false },
    checkedSpaceIds: ['exterior'], pendingSpaceIds: [], rulesVersion: 'rules-1',
  },
  canCreateRepairDraft: false,
}

/** A1(W46):无效历史目标——不再直接恢复,而是打开独立修复预览旅程。 */
const inspectionInvalid = {
  ...inspectionValid,
  report: {
    status: 'invalid',
    issues: {
      items: [{ id: 'issue-1', code: 'unsupported-object', severity: 'blocker', origin: 'existing', spaceId: 'exterior', at: { x: 4, y: 5, z: 4 }, objectId: 'stone-lantern-1', summary: '石灯悬空，缺少支撑。', suggestion: '移除或放回地面。' }],
      offset: 0, limit: 20, total: 1, countIsExact: true, hasMore: false,
    },
    issueCount: 1, countIsExact: true,
    ruleNotes: { items: [], total: 0, hasMore: false },
    checkedSpaceIds: ['exterior'], pendingSpaceIds: [], rulesVersion: 'rules-1',
  },
  canCreateRepairDraft: true,
}

async function openWorld(page: Page) {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: { id: 'user-1', username: 'tester', role: 'user' } } }))
  await page.route('**/api/worlds/world-1/scene', route => route.fulfill({ json: { status: 'ready', version: 2, document: voxelDoc } }))
  await page.route('**/api/worlds/world-1/map/bootstrap**', route => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
    world: snapshot, scene: { status: 'ready', document: voxelDoc },
    presentation: { timelineId: 'timeline-1', stateVersion: 1, simNow: now, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
    theme: { id: 'mist-manor', assetVersion: 'fixture' },
    resume: { worldId: 'world-1', timelineId: 'timeline-1', spaceId: 'exterior', mode: 'life', updatedAt: now },
  } }))
  await page.route('**/api/worlds/world-1/map/resume', route => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/worlds/world-1/stream**', route => route.fulfill({ contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }))
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [{ id: 'world-1', name: '雾影庄', hasScene: true }] } }))
  await page.goto('/worlds/world-1')
  await expect(page.getByTestId('world-canvas-page')).toBeVisible()
}

test('scene history opens as a modal and distinguishes an empty list from saved versions', async ({ page }) => {
  await openWorld(page)
  let revisionRows = revisions
  await page.route('**/api/worlds/world-1/scene', route => route.fulfill({ json: { status: 'ready', version: 2, document: voxelDoc } }))
  await page.route('**/api/worlds/world-1/scene/revisions', route => route.fulfill({ json: { revisions: revisionRows } }))

  await page.getByRole('button', { name: '历史' }).click()
  const dialog = page.getByRole('dialog', { name: '场景历史' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(dialog.getByText(/v2 · 庭院加入石灯 · 当前版本/)).toBeVisible()
  await expect(dialog.getByText(/v1 · 开始生活时的场景/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: '恢复到此版本' })).toBeVisible()

  await page.getByRole('button', { name: '关闭历史' }).click()
  revisionRows = []
  await page.getByRole('button', { name: '历史' }).click()
  await expect(dialog.getByText('还没有已保存版本。')).toBeVisible()
})

test('history read failures stay in the panel, can retry, and close without leaking', async ({ page }) => {
  await openWorld(page)
  let sceneFails = true
  let historyFails = false
  await page.route('**/api/worlds/world-1/scene', route => sceneFails
    ? route.fulfill({ status: 500, json: { error: 'private database detail' } })
    : route.fulfill({ json: { status: 'missing' } }))
  await page.route('**/api/worlds/world-1/scene/revisions', route => historyFails
    ? route.fulfill({ status: 500, json: { error: 'private database detail' } })
    : route.fulfill({ json: { revisions: [] } }))

  await page.getByRole('button', { name: '历史' }).click()
  const dialog = page.getByRole('dialog', { name: '场景历史' })
  await expect(dialog.getByRole('alert')).toContainText('场景历史暂时无法读取，请重试。')
  await expect(dialog).not.toContainText('private database detail')
  await expect(dialog.getByRole('button', { name: '重试读取历史' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(1)

  sceneFails = false
  historyFails = true
  await dialog.getByRole('button', { name: '重试读取历史' }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  historyFails = false
  await dialog.getByRole('button', { name: '重试读取历史' }).click()
  await expect(dialog.getByText('还没有已保存版本。')).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveCount(0)

  sceneFails = true
  await page.getByRole('button', { name: '关闭历史' }).click()
  await page.getByRole('button', { name: '历史' }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: '关闭历史' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('restore failures are identified separately from history read failures', async ({ page }) => {
  await openWorld(page)
  let restoreFails = true
  await page.route('**/api/worlds/world-1/scene', route => route.fulfill({ json: { status: 'ready', version: 2, document: voxelDoc } }))
  await page.route('**/api/worlds/world-1/scene/revisions', route => route.fulfill({ json: { revisions } }))
  await page.route('**/api/worlds/world-1/scene/compatibility/inspection**', route => route.fulfill({ json: inspectionValid }))
  await page.route('**/api/worlds/world-1/scene/restore', route => restoreFails
    ? route.fulfill({ status: 500, json: { error: 'internal restore detail' } })
    : route.fulfill({ json: { version: 3 } }))

  await page.getByRole('button', { name: '历史' }).click()
  const dialog = page.getByRole('dialog', { name: '场景历史' })
  await dialog.getByRole('button', { name: '恢复到此版本' }).click()
  await expect(dialog.getByRole('alert')).toContainText('恢复失败：无法恢复到所选版本，请重试。')
  await expect(dialog.getByRole('alert')).not.toContainText('读取历史')

  restoreFails = false
  await dialog.getByRole('button', { name: '恢复到此版本' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('an invalid history target opens the repair preview journey instead of restoring directly', async ({ page }) => {
  await openWorld(page)
  let restoreCalls = 0
  await page.route('**/api/worlds/world-1/scene', route => route.fulfill({ json: { status: 'ready', version: 2, document: voxelDoc } }))
  await page.route('**/api/worlds/world-1/scene/revisions', route => route.fulfill({ json: { revisions } }))
  await page.route('**/api/worlds/world-1/scene/compatibility/inspection**', route => route.fulfill({ json: inspectionInvalid }))
  await page.route('**/api/worlds/world-1/scene/restore', route => { restoreCalls += 1; return route.fulfill({ json: { version: 3 } }) })

  await page.getByRole('button', { name: '历史' }).click()
  const dialog = page.getByRole('dialog', { name: '场景历史' })
  await dialog.getByRole('button', { name: '恢复到此版本' }).click()

  // A1(W19/W46):无效目标不调用原 restore,历史面板关闭,打开独立兼容修复旅程。
  const compatDialog = page.getByRole('dialog', { name: '场景兼容检查' })
  await expect(compatDialog).toBeVisible()
  await expect(compatDialog).toContainText('恢复历史场景')
  await expect(compatDialog).toContainText('历史版本 v1')
  await expect(compatDialog).toContainText('发现阻断问题')
  await expect(compatDialog).toContainText('石灯悬空，缺少支撑。')
  await expect(compatDialog.getByRole('button', { name: '构建修复预览' })).toBeVisible()
  expect(restoreCalls).toBe(0)

  // 取消保留当前场景:关闭旅程不 reset 出任何新版本请求,也不触发 restore。
  await compatDialog.getByRole('button', { name: '关闭兼容检查' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(restoreCalls).toBe(0)
})

test('an incomplete history target check stays in the history panel with a retryable message', async ({ page }) => {
  await openWorld(page)
  let restoreCalls = 0
  await page.route('**/api/worlds/world-1/scene', route => route.fulfill({ json: { status: 'ready', version: 2, document: voxelDoc } }))
  await page.route('**/api/worlds/world-1/scene/revisions', route => route.fulfill({ json: { revisions } }))
  await page.route('**/api/worlds/world-1/scene/compatibility/inspection**', route => route.fulfill({ json: {
    ...inspectionValid,
    report: { ...inspectionValid.report, status: 'incomplete', pendingSpaceIds: ['greenhouse'] },
  } }))
  await page.route('**/api/worlds/world-1/scene/restore', route => { restoreCalls += 1; return route.fulfill({ json: { version: 3 } }) })

  await page.getByRole('button', { name: '历史' }).click()
  const dialog = page.getByRole('dialog', { name: '场景历史' })
  await dialog.getByRole('button', { name: '恢复到此版本' }).click()
  await expect(dialog.getByRole('alert')).toContainText('所选版本检查未完成，暂时不能恢复')
  expect(restoreCalls).toBe(0)
})

test('closing history ignores a delayed response from the previous open request', async ({ page }) => {
  await openWorld(page)
  let sceneReads = 0
  let revisionReads = 0
  await page.route('**/api/worlds/world-1/scene', async route => {
    sceneReads += 1
    if (sceneReads === 1) await new Promise(resolve => setTimeout(resolve, 700))
    return route.fulfill({ json: { status: 'ready', version: sceneReads === 1 ? 1 : 2, document: voxelDoc } })
  })
  await page.route('**/api/worlds/world-1/scene/revisions', async route => {
    revisionReads += 1
    if (revisionReads === 1) await new Promise(resolve => setTimeout(resolve, 700))
    return route.fulfill({ json: { revisions: revisionReads === 1 ? revisions.slice(1) : revisions } })
  })

  await page.getByRole('button', { name: '历史' }).click()
  const dialog = page.getByRole('dialog', { name: '场景历史' })
  await expect(dialog.getByRole('status')).toBeVisible()
  await page.getByRole('button', { name: '关闭历史' }).click()
  await page.getByRole('button', { name: '历史' }).click()
  await expect(dialog.getByText(/v2 · 庭院加入石灯 · 当前版本/)).toBeVisible()
  await page.waitForTimeout(800)
  await expect(dialog.getByText(/v2 · 庭院加入石灯 · 当前版本/)).toBeVisible()
  await expect(dialog.getByText(/v1 · 开始生活时的场景/)).toBeVisible()
})
