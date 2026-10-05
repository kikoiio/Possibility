import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const voxelDoc = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))
const simNow = '2026-09-19T12:00:00.000Z'
const snapshot = {
  world: { id: 'world-1', name: '雾影庄', description: '体素世界', status: 'running', pauseReason: null, isDemo: false, callsToday: 0, locations: [{ name: '主楼', description: '庄园主楼' }] },
  timelines: [{ id: 'timeline-main', parentTimelineId: null, status: 'active', simNow }],
  currentTimelineId: 'timeline-main', simNow, stateVersion: 1, worldModelVersion: 1,
  evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [],
  locationBoard: [{ location: '主楼', persons: [{ id: 'person-1', name: '小夜', activity: '读书' }] }], events: [],
}

declare global {
  interface Window { __voxelEngine?: { world: { doc: { sections: Record<string, { nonAirCount: number }> } } } }
}

/** A1(W47):服务端 preflight 的真实形状——valid 候选携带完整依据。 */
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

function preflightInvalid(summary: string) {
  return {
    status: 'invalid',
    report: {
      status: 'invalid',
      issues: [{ id: 'issue-1', code: 'asset-unsupported', origin: 'edit', category: 'structure', spaceId: null, summary, suggestion: '调整后再试', blocking: true }],
      issueCount: 1, countIsExact: true, stopReason: null,
      checkedSpaceIds: ['exterior'], pendingSpaceIds: [], workUnitsUsed: 1, elapsedMs: 1,
      ruleNotes: { items: [], total: 0, hasMore: false },
    },
  }
}

async function setupWorld(page: Page, editScene: boolean, getSceneDocument: () => typeof voxelDoc = () => voxelDoc) {
  await page.addInitScript(() => {
    localStorage.setItem('possibility_token', 'e2e-token')
    localStorage.setItem('possibility:flag:voxel', '1')
  })
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [{ id: 'world-1', name: '雾影庄' }] } }))
  await page.route('**/api/worlds/world-1/stream**', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }))
  await page.route('**/api/worlds/world-1/map/bootstrap**', route => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene, fork: true, compare: true, persist: editScene, resetDemo: false },
    world: snapshot,
    scene: { status: 'ready', document: getSceneDocument() },
    presentation: { timelineId: 'timeline-main', stateVersion: 1, simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
    theme: { id: 'mist-manor', assetVersion: 'e2e' },
    resume: { worldId: 'world-1', timelineId: 'timeline-main', spaceId: 'exterior', mode: 'life', updatedAt: simNow },
  } }))
  await page.route('**/api/worlds/world-1/map/resume', route => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/worlds/world-1/persona**', route => route.fulfill({ json: { persona: null, unread: 0 } }))
  await page.route('**/api/worlds/world-1/state**', route => route.fulfill({ json: { timelineId: 'timeline-main', version: 1, worldModelVersion: 1, evidenceStatus: 'structured', current: [], facts: [] } }))
  await page.route('**/api/worlds/world-1/return**', route => route.fulfill({ json: { timelineId: 'timeline-main', simNow, firstVisit: false, cursor: 0, events: [], commitments: [], unread: 0 } }))
}

test('saved editable world keeps intent after failure, previews without writes, and saves only on confirm', async ({ page }) => {
  let currentDoc = structuredClone(voxelDoc)
  let currentVersion = 5
  let savedCount = 0
  let calls = 0
  const planningRequests: { body: { worldId: string; requestId: string; intent: string }; authorization: string | undefined }[] = []
  let savedDocument: typeof voxelDoc | null = null
  await setupWorld(page, true, () => currentDoc)
  await page.route('**/api/worlds/world-1/scene**', route => route.fulfill({ json: { status: 'ready', document: currentDoc, version: currentVersion, contentHash: 'e2e-hash', createdAt: simNow } }))
  await page.route('**/api/worlds/world-1/scene/voxel-revision', route => {
    const body = route.request().postDataJSON() as { expectedVersion: number; document: typeof voxelDoc }
    expect(body.expectedVersion).toBe(currentVersion)
    currentDoc = body.document
    savedDocument = body.document
    currentVersion += 1
    savedCount += 1
    return route.fulfill({ json: { document: currentDoc, version: currentVersion, contentHash: 'e2e-hash', createdAt: simNow } })
  })
  await page.route('**/api/voxel/edit-plan', route => {
    calls += 1
    planningRequests.push({ body: route.request().postDataJSON() as { worldId: string; requestId: string; intent: string }, authorization: route.request().headers().authorization })
    if (calls === 1) return route.fulfill({ status: 503, json: { error: '规划服务暂时不可用。', kind: 'service', retryable: true, nextStep: '请点击重试生成预览。' } })
    return route.fulfill({ json: { ops: [{ kind: 'set-block', at: { x: 2, y: 1, z: 42 }, block: 'lantern' }] } })
  })
  // A1(W47):确认应用前先过服务端完整 preflight;规划 stub 不带 previewBasis,客户端必须走这条真实预检。
  const preflightRequests: unknown[] = []
  await page.route('**/api/worlds/world-1/scene/compatibility/preflight', route => {
    preflightRequests.push(route.request().postDataJSON())
    return route.fulfill({ json: preflightValid(currentVersion) })
  })

  await page.goto('/worlds/world-1')
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  await expect(page.getByTestId('voxel-tool-ai')).toBeVisible()
  await page.getByTestId('voxel-tool-ai').click()
  await page.getByTestId('voxel-ai-input').fill('在庭院里加一座石灯笼')
  const initialCount = await page.evaluate(() => Object.values(window.__voxelEngine!.world.doc.sections).reduce((total, section) => total + section.nonAirCount, 0))

  await page.getByTestId('voxel-ai-preview').click()
  await expect(page.getByTestId('voxel-ai-error')).toContainText('规划服务暂时不可用')
  await expect(page.getByTestId('voxel-ai-input')).toHaveValue('在庭院里加一座石灯笼')
  await expect(page.getByTestId('voxel-ai-preview')).toHaveText('重试生成预览')

  await page.getByTestId('voxel-ai-preview').click()
  await expect(page.getByTestId('voxel-ai-pending')).toBeVisible()
  await expect.poll(() => page.evaluate(() => Object.values(window.__voxelEngine!.world.doc.sections).reduce((total, section) => total + section.nonAirCount, 0))).toBe(initialCount)
  await page.getByTestId('voxel-ai-cancel').click()
  expect(savedCount).toBe(0)
  await page.getByTestId('voxel-ai-preview').click()
  await expect(page.getByTestId('voxel-ai-pending')).toBeVisible()
  await page.getByTestId('voxel-ai-confirm').click()
  await expect.poll(() => savedCount, { timeout: 5000 }).toBe(1)
  expect(currentVersion).toBe(6)
  expect(JSON.stringify(savedDocument)).not.toBe(JSON.stringify(voxelDoc))
  await page.reload()
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  const reloadedCount = await page.evaluate(() => Object.values(window.__voxelEngine!.world.doc.sections).reduce((total, section) => total + section.nonAirCount, 0))
  expect(reloadedCount).toBeGreaterThan(initialCount)
  expect(planningRequests).toHaveLength(3)
  for (const request of planningRequests) {
    expect(request.body.worldId).toBe('world-1')
    expect(request.body.intent).toBe('在庭院里加一座石灯笼')
    expect(request.body.requestId).toBeTruthy()
    expect(request.authorization).toBe('Bearer e2e-token')
  }
  expect(new Set(planningRequests.map(request => request.body.requestId)).size).toBe(3)
  // A1(W47):确认路径真实经过了完整 preflight(候选为 operations 形态)
  expect(preflightRequests).toHaveLength(1)
  expect((preflightRequests[0] as { candidate: { kind: string } }).candidate.kind).toBe('operations')
})

test('a blocked preflight neither applies nor saves, and keeps the original scene', async ({ page }) => {
  let savedCount = 0
  await setupWorld(page, true)
  await page.route('**/api/worlds/world-1/scene**', route => route.fulfill({ json: { status: 'ready', document: voxelDoc, version: 5, contentHash: 'e2e-hash', createdAt: simNow } }))
  await page.route('**/api/worlds/world-1/scene/voxel-revision', route => {
    savedCount += 1
    return route.fulfill({ json: { document: voxelDoc, version: 6, contentHash: 'e2e-hash', createdAt: simNow } })
  })
  await page.route('**/api/voxel/edit-plan', route => route.fulfill({ json: { ops: [{ kind: 'set-block', at: { x: 2, y: 1, z: 42 }, block: 'lantern' }] } }))
  // A1(W47):预检 invalid——确认不 apply、不 autosave,原场景保留
  await page.route('**/api/worlds/world-1/scene/compatibility/preflight', route => route.fulfill({ json: preflightInvalid('庭院净空不足') }))

  await page.goto('/worlds/world-1')
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  await page.getByTestId('voxel-tool-ai').click()
  await page.getByTestId('voxel-ai-input').fill('在庭院里加一座石灯笼')
  const initialCount = await page.evaluate(() => Object.values(window.__voxelEngine!.world.doc.sections).reduce((total, section) => total + section.nonAirCount, 0))
  await page.getByTestId('voxel-ai-preview').click()
  await expect(page.getByTestId('voxel-ai-pending')).toBeVisible()
  await page.getByTestId('voxel-ai-confirm').click()
  await expect(page.getByTestId('voxel-edit-rejected')).toContainText('未通过完整校验')
  await expect(page.getByTestId('voxel-edit-rejected')).toContainText('庭院净空不足')
  // 阻断后幽灵预览仍在、可取消;场景与保存均未发生
  await page.getByTestId('voxel-ai-cancel').click()
  expect(savedCount).toBe(0)
  const afterCount = await page.evaluate(() => Object.values(window.__voxelEngine!.world.doc.sections).reduce((total, section) => total + section.nonAirCount, 0))
  expect(afterCount).toBe(initialCount)
})

test('read-only saved world has no AI editing entry point', async ({ page }) => {
  await setupWorld(page, false)
  await page.goto('/worlds/world-1')
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  await expect(page.getByTestId('voxel-editor-toolbar')).toHaveCount(0)
  await expect(page.getByTestId('voxel-tool-ai')).toHaveCount(0)
})

test('scene repair planner stays bound to the original saved world', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('possibility_token', 'e2e-token')
    localStorage.setItem('possibility:flag:voxel', '1')
  })
  await page.route('**/api/worlds/world-1/scene/repair-context', route => route.fulfill({ json: {
    world: { id: 'world-1', name: '雾影庄', description: '体素世界', locations: [{ name: '主楼', description: '庄园主楼' }] },
    residents: [{ id: 'person-1', name: '小夜' }], sceneStatus: 'missing',
  } }))
  await page.route('**/api/worlds/world-1/scene/repair-draft', route => route.fulfill({ json: {
    worldId: 'world-1', document: voxelDoc, explanation: '已准备场景草稿。', warnings: [], callsUsed: 1,
  } }))
  let request: { worldId: string; intent: string } | null = null
  await page.route('**/api/voxel/edit-plan', route => {
    request = route.request().postDataJSON() as { worldId: string; intent: string }
    return route.fulfill({ json: { ops: [{ kind: 'set-block', at: { x: 2, y: 1, z: 42 }, block: 'lantern' }] } })
  })

  await page.goto('/worlds/world-1/scene/repair')
  await page.getByTestId('repair-scene-prompt').fill('补上庭院与温室之间的小径')
  await page.getByTestId('generate-repair-scene').click()
  await expect(page.getByTestId('save-repair-scene')).toBeVisible()
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  await page.getByTestId('voxel-tool-ai').click()
  await page.getByTestId('voxel-ai-input').fill('在庭院里加一座石灯笼')
  await page.getByTestId('voxel-ai-preview').click()
  await expect(page.getByTestId('voxel-ai-pending')).toBeVisible()
  expect(request).toMatchObject({ worldId: 'world-1', intent: '在庭院里加一座石灯笼' })
})
