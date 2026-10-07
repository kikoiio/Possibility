import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const voxelDoc = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))

async function mockRepairSnapshot(page: Page) {
  await page.route('**/api/worlds/world-1', route => route.fulfill({ json: {
    world: { id: 'world-1', name: '雾影庄', description: '白雾町的旧宅。' },
    timelines: [{ id: 'timeline-1', parentTimelineId: null }], currentTimelineId: 'timeline-1',
  } }))
}

test('repairs the original world and keeps the draft available after a failed save', async ({ page }) => {
  const saves: Array<{ url: string; body: Record<string, unknown> }> = []
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await mockRepairSnapshot(page)
  await page.route('**/api/worlds/world-1/scene/repair-context*', route => route.fulfill({ json: {
    world: { id: 'world-1', name: '雾影庄', description: '白雾町的旧宅。', locations: [{ name: '主楼', description: '旧宅' }, { name: '庭院', description: '石灯庭院' }] },
    residents: [{ id: 'person-1', name: 'Ada' }], sceneStatus: 'missing',
  } }))
  await page.route('**/api/worlds/world-1/scene/repair-draft', route => route.fulfill({ json: {
    worldId: 'world-1', document: voxelDoc, explanation: '主楼和庭院已经就位。', warnings: [], callsUsed: 1,
  } }))
  await page.route('**/api/worlds/world-1/scene/voxel-revision', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    saves.push({ url: route.request().url(), body })
    if (saves.length === 1) return route.fulfill({ status: 503, json: { error: '暂时无法保存' } })
    return route.fulfill({ json: { version: 1, document: body.document, contentHash: 'saved', createdAt: '2026-10-01T00:00:00Z' } })
  })
  await page.route('**/api/worlds/world-1/scene', route => route.fulfill({ json: { status: 'ready', version: 1, document: voxelDoc } }))

  await page.goto('/worlds/world-1/scene/repair')
  await expect(page.getByRole('heading', { name: '让「雾影庄」回到可进入的状态' })).toBeVisible()
  await expect(page.getByRole('button', { name: '创建独立新世界' })).toHaveCount(0)
  await expect(page.getByText('Ada')).toBeVisible()
  await page.getByTestId('repair-scene-prompt').fill('修复原有主楼和庭院之间的石板路。')
  await page.getByTestId('generate-repair-scene').click()
  await expect(page.getByRole('heading', { name: '场景草稿已生成' })).toBeVisible()
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('save-repair-scene').click()
  await expect(page.getByRole('alert')).toContainText('暂时无法保存')
  await expect(page.getByTestId('save-repair-scene')).toHaveText('重试保存')
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible()

  await page.getByTestId('save-repair-scene').click()
  await expect(page).toHaveURL(/\/worlds\/world-1$/)
  expect(saves).toHaveLength(2)
  expect(saves.every(save => save.body.expectedVersion === 0 && save.body.repair === true)).toBe(true)
  expect(saves[0]!.body.requestId).toBe(saves[1]!.body.requestId)
  expect(saves[1]!.body.document).toMatchObject({ format: 'voxel-document' })
})

test('world list opens repair for the selected world id', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await mockRepairSnapshot(page)
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [{
    id: 'world-1', name: '雾影庄', description: '白雾町的旧宅。', status: 'paused', pauseReason: null,
    isDemo: false, hasScene: false, personIds: ['person-1'], personCount: 1, callsToday: 0,
    simNow: '2026-10-01T00:00:00.000Z', timeZone: 'UTC', createdAt: '2026-09-20T10:00:00.000Z',
  }] } }))
  await page.route('**/api/persons', route => route.fulfill({ json: { persons: [{ id: 'person-1', name: 'Ada', createdAt: '2026-09-01T10:00:00Z' }] } }))
  await page.route('**/api/worlds/world-1/scene/repair-context*', route => route.fulfill({ json: {
    world: { id: 'world-1', name: '雾影庄', description: '白雾町的旧宅。', locations: [{ name: '主楼', description: '旧宅' }] },
    residents: [{ id: 'person-1', name: 'Ada' }], sceneStatus: 'missing',
  } }))

  await page.goto('/worlds')
  await page.getByRole('link', { name: '补建场景' }).click()
  await expect(page).toHaveURL('/worlds/world-1/scene/repair')
  await expect(page.getByRole('heading', { name: '让「雾影庄」回到可进入的状态' })).toBeVisible()
})

test('map missing-scene entry opens repair for the same original world', async ({ page }) => {
  const now = '2026-10-01T00:00:00.000Z'
  const snapshot = {
    world: { id: 'world-1', name: '雾影庄', description: '白雾町的旧宅。', status: 'paused', pauseReason: 'manual', isDemo: false, callsToday: 0, locations: [{ name: '主楼', description: '旧宅' }] },
    timelines: [{ id: 'timeline-1', parentTimelineId: null, simNow: now }], currentTimelineId: 'timeline-1', simNow: now,
    stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] },
    currentFacts: [], locationBoard: [{ location: '主楼', persons: [{ id: 'person-1', name: 'Ada', activity: '正在安顿' }] }], events: [],
  }
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/worlds/world-1/map/bootstrap**', route => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: true, resetDemo: false },
    world: snapshot, scene: { status: 'missing' },
    presentation: { timelineId: 'timeline-1', stateVersion: 1, simNow: now, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
    theme: { id: 'mist-manor', assetVersion: 'fixture' },
    resume: { worldId: 'world-1', timelineId: 'timeline-1', spaceId: 'exterior', mode: 'life', updatedAt: now },
  } }))
  await page.route('**/api/worlds/world-1/map/resume', route => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/worlds/world-1/stream**', route => route.fulfill({ contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }))
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [] } }))
  await page.route('**/api/worlds/world-1/scene/repair-context*', route => route.fulfill({ json: {
    world: { id: 'world-1', name: '雾影庄', description: '白雾町的旧宅。', locations: [{ name: '主楼', description: '旧宅' }] },
    residents: [{ id: 'person-1', name: 'Ada' }], sceneStatus: 'missing',
  } }))

  await page.goto('/worlds/world-1')
  await expect(page.getByTestId('world-canvas-missing')).toBeVisible()
  await page.getByRole('link', { name: '补建场景' }).click()
  await expect(page).toHaveURL('/worlds/world-1/scene/repair')
  await expect(page.getByRole('heading', { name: '让「雾影庄」回到可进入的状态' })).toBeVisible()
})

test('a competing successful repair sends the user into the original world', async ({ page }) => {
  const saveAttempts: Record<string, unknown>[] = []
  const now = '2026-10-01T00:00:00.000Z'
  const snapshot = {
    world: { id: 'world-1', name: '雾影庄', description: '白雾町的旧宅。', status: 'paused', pauseReason: 'manual', isDemo: false, callsToday: 0, locations: [{ name: '主楼', description: '旧宅' }, { name: '温室', description: '玻璃温室' }, { name: '庭院', description: '石灯庭院' }] },
    timelines: [{ id: 'timeline-1', parentTimelineId: null, simNow: now }], currentTimelineId: 'timeline-1', simNow: now,
    stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [],
    locationBoard: [{ location: '主楼', persons: [{ id: 'person-1', name: 'Ada', activity: '正在安顿' }] }], events: [],
  }
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await mockRepairSnapshot(page)
  await page.route('**/api/worlds/world-1/scene/repair-context*', route => route.fulfill({ json: {
    world: { id: 'world-1', name: '雾影庄', description: '白雾町的旧宅。', locations: [{ name: '主楼', description: '旧宅' }, { name: '温室', description: '玻璃温室' }, { name: '庭院', description: '石灯庭院' }] },
    residents: [{ id: 'person-1', name: 'Ada' }], sceneStatus: 'missing',
  } }))
  await page.route('**/api/worlds/world-1/scene/repair-draft', route => route.fulfill({ json: {
    worldId: 'world-1', document: voxelDoc, explanation: '场景草稿。', warnings: [], callsUsed: 1,
  } }))
  await page.route('**/api/worlds/world-1/scene/voxel-revision', route => {
    saveAttempts.push(route.request().postDataJSON() as Record<string, unknown>)
    return route.fulfill({ status: 409, json: { error: '场景已由其他请求补建' } })
  })
  await page.route('**/api/worlds/world-1/scene', route => route.fulfill({ json: { status: 'ready', version: 1, document: voxelDoc } }))
  await page.route('**/api/worlds/world-1/map/bootstrap**', route => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: true, resetDemo: false },
    world: snapshot, scene: { status: 'ready', document: voxelDoc },
    presentation: { timelineId: 'timeline-1', stateVersion: 1, simNow: now, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
    theme: { id: 'mist-manor', assetVersion: 'fixture' },
    resume: { worldId: 'world-1', timelineId: 'timeline-1', spaceId: 'exterior', mode: 'life', updatedAt: now },
  } }))
  await page.route('**/api/worlds/world-1/map/resume', route => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/worlds/world-1/stream**', route => route.fulfill({ contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }))
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [] } }))

  await page.goto('/worlds/world-1/scene/repair')
  await page.getByTestId('repair-scene-prompt').fill('修复主楼和庭院。')
  await page.getByTestId('generate-repair-scene').click()
  await expect(page.getByTestId('save-repair-scene')).toBeVisible()
  await page.getByTestId('save-repair-scene').click()
  await expect(page).toHaveURL('/worlds/world-1')
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 15000 })
  expect(saveAttempts).toHaveLength(1)
  expect(saveAttempts[0]).toMatchObject({ expectedVersion: 0, repair: true })
  // 409 switches to the winning scene in the same world without replaying the stale repair draft.
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  await expect.poll(() => page.evaluate(() => (window as any).__voxelEngine?.world?.doc?.id)).toBe('fixture-mist-manor')
})

test('generation errors keep the original context and description available for retry', async ({ page }) => {
  let draftCalls = 0
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await mockRepairSnapshot(page)
  await page.route('**/api/worlds/world-1/scene/repair-context*', route => route.fulfill({ json: {
    world: { id: 'world-1', name: '雾影庄', description: '白雾町的旧宅。', locations: [{ name: '主楼', description: '旧宅' }, { name: '温室', description: '玻璃温室' }, { name: '庭院', description: '石灯庭院' }] },
    residents: [{ id: 'person-1', name: 'Ada' }], sceneStatus: 'missing',
  } }))
  await page.route('**/api/worlds/world-1/scene/repair-draft', route => {
    draftCalls++
    if (draftCalls === 1) return route.fulfill({ status: 502, json: { error: '场景生成暂时失败，请重试。', errorCode: 'system' } })
    return route.fulfill({ json: { worldId: 'world-1', document: voxelDoc, explanation: '场景草稿。', warnings: [], callsUsed: 1 } })
  })

  await page.goto('/worlds/world-1/scene/repair')
  const prompt = page.getByTestId('repair-scene-prompt')
  await prompt.fill('修复原有主楼和庭院之间的石板路。')
  await page.getByTestId('generate-repair-scene').click()
  await expect(page.getByRole('alert')).toContainText('场景生成暂时失败')
  await expect(prompt).toHaveValue('修复原有主楼和庭院之间的石板路。')
  await expect(page.getByRole('heading', { name: '让「雾影庄」回到可进入的状态' })).toBeVisible()
  await page.getByTestId('generate-repair-scene').click()
  await expect(page.getByRole('heading', { name: '场景草稿已生成' })).toBeVisible()
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 15000 })
  expect(draftCalls).toBe(2)
})

test('an unrepairable original world stays intact and offers a route back', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await mockRepairSnapshot(page)
  await page.route('**/api/worlds/world-1/scene/repair-context*', route => route.fulfill({
    status: 409, json: { error: '这个世界没有可用于补建场景的居民。', errorCode: 'world_structure_invalid' },
  }))
  await page.route('**/api/worlds/world-1/scene', route => route.fulfill({ json: { status: 'missing' } }))
  await page.route('**/api/persons', route => route.fulfill({ json: { persons: [{ id: 'person-1', name: 'Ada', createdAt: '2026-09-01T10:00:00Z' }] } }))

  await page.goto('/worlds/world-1/scene/repair')
  await expect(page.getByRole('alert')).toContainText('没有可用于补建场景的居民')
  await expect(page.locator('section').getByRole('link', { name: '返回原世界' })).toBeVisible()
  const createIndependent = page.getByRole('button', { name: '创建独立新世界' })
  await expect(createIndependent).toBeVisible()
  await createIndependent.click()
  const confirmation = page.getByRole('dialog')
  await expect(confirmation).toContainText('原世界会保留')
  await expect(confirmation).toContainText('不会迁移、替换或归档')
  await confirmation.getByRole('button', { name: '返回补建页' }).click()
  await expect(page).toHaveURL('/worlds/world-1/scene/repair')
  await expect(confirmation).toHaveCount(0)
  await createIndependent.click()
  await confirmation.getByRole('button', { name: '确认，创建独立新世界' }).click()
  await expect(page).toHaveURL('/worlds/new')
  await expect(page.getByTestId('scene-prompt')).toBeVisible()
})
