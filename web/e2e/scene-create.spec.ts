import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const voxelDoc = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))

/** 与 fixture 体素文档地点绑定一致的世界骨架(主楼/温室/庭院) */
const world = {
  name: '雾影庄', description: '白雾町的旧宅与庭院。',
  locations: [{ name: '主楼', description: '旧宅主楼' }, { name: '温室', description: '玻璃温室' }, { name: '庭院', description: '石灯庭院' }],
}

const snapshot = {
  world: { id: 'world-1', ...world, status: 'running', pauseReason: null, isDemo: false, callsToday: 0 },
  timelines: [{ id: 'timeline-1', parentTimelineId: null, simNow: '2026-09-28T12:00:00.000Z' }], currentTimelineId: 'timeline-1', simNow: '2026-09-28T12:00:00.000Z',
  stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [],
  locationBoard: [{ location: '主楼', persons: [{ id: 'person-1', name: 'Ada', activity: '正在安顿' }] }], events: [],
}

test('S1 体素创建:一句话 → 体素预览 → 开始生活 → 世界页无开关直渲体素', async ({ page }) => {
  let createdScene: Record<string, unknown> | null = null
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/persons', route => route.fulfill({ json: { persons: [{ id: 'person-1', name: 'Ada', createdAt: '2026-01-01T00:00:00Z' }] } }))
  await page.route('**/api/scene-drafts/voxel', route => route.fulfill({ json: { world, document: voxelDoc, explanation: '旧宅、温室与庭院已就位。', warnings: [] } }))
  await page.route('**/api/worlds', async route => {
    if (route.request().method() === 'POST') { createdScene = route.request().postDataJSON().scene; return route.fulfill({ json: { id: 'world-1', timelineId: 'timeline-1' } }) }
    return route.fulfill({ json: { worlds: [{ id: 'world-1', name: world.name }] } })
  })
  await page.route('**/api/worlds/world-1**', route => {
    const url = route.request().url()
    if (url.includes('/map/bootstrap')) return route.fulfill({ json: {
      access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
      world: snapshot,
      scene: { status: 'ready', document: voxelDoc },
      presentation: { timelineId: 'timeline-1', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
      theme: { id: 'mist-manor', assetVersion: 'fixture' },
      resume: { worldId: 'world-1', timelineId: 'timeline-1', spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow },
    } })
    if (url.includes('/map/resume')) return route.fulfill({ json: { ok: true } })
    return route.fulfill({ json: snapshot })
  })

  await page.goto('/worlds/new')
  await page.getByTestId('scene-prompt').fill('白雾缭绕的山间旧宅,有温室和石灯庭院。')
  await page.getByRole('button', { name: 'Ada' }).click()
  await page.getByTestId('generate-scene').click()

  // 体素预览:直接挂载体素视口(不再经过 2D 画布)
  await expect(page.getByTestId('voxel-create-workspace')).toBeVisible()
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible()
  await expect(page.getByTestId('start-life')).toBeEnabled()

  await page.getByTestId('start-life').click()
  await expect(page.getByTestId('create-live-banner')).toBeVisible()
  expect(page.url()).toContain('/worlds/world-1')
  // 创建载荷是体素信封(归一化后仍带 format 标识)
  expect((createdScene as { format?: string } | null)?.format).toBe('voxel-document')

  // 进入世界地图:单空间体素文档无 ?voxel=1 开关也直渲(S1 解除门控)
  await page.getByTestId('enter-world-map').click()
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 15000 })
})
