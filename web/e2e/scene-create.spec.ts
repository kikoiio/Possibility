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
  await expect(page.getByTestId('voxel-editor-toolbar')).toBeVisible()
  await expect(page.getByTestId('voxel-tool-ai')).toHaveCount(0)
  await expect(page.getByText(/AI 改造需先保存并进入有编辑权限的世界/)).toBeVisible()
  await expect(page.getByTestId('start-life')).toBeEnabled()

  await page.getByTestId('start-life').click()
  await expect(page.getByTestId('create-live-banner')).toBeVisible()
  expect(page.url()).toContain('/worlds/world-1')
  // 创建载荷是体素信封(归一化后仍带 format 标识)
  expect((createdScene as { format?: string } | null)?.format).toBe('voxel-document')

  // 进入已创建世界地图:单文档场景无 ?voxel=1 开关也能直渲
  await page.getByTestId('enter-world-map').click()
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible()
  await expect(page.getByTestId('voxel-tool-ai')).toBeVisible()
})

test('lost world-create response retries the identical payload with the same request key', async ({ page }) => {
  const createBodies: Record<string, unknown>[] = []
  let committedResult: { id: string; timelineId: string } | null = null
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/persons', route => route.fulfill({ json: { persons: [{ id: 'person-1', name: 'Ada', createdAt: '2026-01-01T00:00:00Z' }] } }))
  await page.route('**/api/scene-drafts/voxel', route => route.fulfill({ json: { world, document: voxelDoc, explanation: '旧宅、温室与庭院已就位。', warnings: [] } }))
  await page.route('**/api/worlds', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { worlds: [] } })
    createBodies.push(route.request().postDataJSON() as Record<string, unknown>)
    if (createBodies.length === 1) {
      // Model a server commit whose successful response was lost in transit.
      committedResult = { id: 'world-1', timelineId: 'timeline-1' }
      return route.fulfill({ status: 503, json: { error: '创建结果暂时无法确认' } })
    }
    if (createBodies[1]!.sceneRequestId !== createBodies[0]!.sceneRequestId) {
      return route.fulfill({ status: 409, json: { error: '创建请求标识已变化', errorCode: 'request_id_conflict' } })
    }
    return route.fulfill({ json: committedResult })
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
  await expect(page.getByTestId('voxel-create-workspace')).toBeVisible()
  await page.waitForTimeout(500)
  await page.getByTestId('start-life').click()
  await expect(page.getByRole('alert')).toContainText('创建结果暂时无法确认')
  await expect(page.getByTestId('start-life')).toBeEnabled()
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('voxel-create-workspace')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('start-life').click()
  await expect(page).toHaveURL('/worlds/world-1')
  expect(createBodies).toHaveLength(2)
  expect(createBodies[1]!.sceneRequestId).toBe(createBodies[0]!.sceneRequestId)
  expect(createBodies[1]).toEqual(createBodies[0])
  expect(createBodies[0]).toMatchObject({
    name: world.name,
    description: world.description,
    locations: world.locations,
    personIds: ['person-1'],
    scene: { format: 'voxel-document' },
  })
  expect(createBodies[1]).toMatchObject({
    name: createBodies[0]!.name,
    description: createBodies[0]!.description,
    locations: createBodies[0]!.locations,
    personIds: createBodies[0]!.personIds,
    scene: createBodies[0]!.scene,
  })
})

test('changed creation payload starts a new idempotency request', async ({ page }) => {
  const createBodies: Record<string, unknown>[] = []
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/persons', route => route.fulfill({ json: { persons: [
    { id: 'person-1', name: 'Ada', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'person-2', name: 'Bo', createdAt: '2026-01-02T00:00:00Z' },
  ] } }))
  await page.route('**/api/scene-drafts/voxel', route => route.fulfill({ json: { world, document: voxelDoc, explanation: '旧宅、温室与庭院已就位。', warnings: [] } }))
  await page.route('**/api/worlds', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { worlds: [] } })
    createBodies.push(route.request().postDataJSON() as Record<string, unknown>)
    if (createBodies.length === 1) return route.fulfill({ status: 503, json: { error: '创建未确认' } })
    return route.fulfill({ json: { id: 'world-1', timelineId: 'timeline-1' } })
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
  await expect(page.getByTestId('voxel-create-workspace')).toBeVisible()
  await page.getByTestId('start-life').click()
  await expect(page.getByRole('alert')).toContainText('创建未确认')

  await page.getByRole('button', { name: 'Bo' }).click()
  await page.getByTestId('start-life').click()
  await expect(page).toHaveURL('/worlds/world-1')
  expect(createBodies).toHaveLength(2)
  expect(createBodies[0]!.personIds).toEqual(['person-1'])
  expect(createBodies[1]!.personIds).toEqual(['person-1', 'person-2'])
  expect(createBodies[1]!.sceneRequestId).not.toBe(createBodies[0]!.sceneRequestId)
})

test('authenticated voxel-spaces world supports resident and location interaction', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/persons', route => route.fulfill({ json: { persons: [{ id: 'person-1', name: 'Ada', createdAt: '2026-01-01T00:00:00Z' }] } }))
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [{ id: 'world-1', name: world.name }] } }))
  await page.route('**/api/worlds/world-1**', route => {
    const url = route.request().url()
    if (url.includes('/map/bootstrap')) return route.fulfill({ json: {
      access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: true, resetDemo: false },
      world: snapshot,
      scene: { status: 'ready', document: { format: 'voxel-spaces', version: 1, defaultSpaceId: 'exterior',
        spaces: [{ id: 'exterior', name: '山间外景', document: voxelDoc }] } },
      presentation: { timelineId: 'timeline-1', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
      theme: { id: 'mist-manor', assetVersion: 'fixture' },
      resume: { worldId: 'world-1', timelineId: 'timeline-1', spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow },
    } })
    if (url.includes('/map/resume')) return route.fulfill({ json: { ok: true } })
    return route.fulfill({ json: snapshot })
  })

  await page.goto('/worlds/world-1?timeline=timeline-1')
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible()
  await expect(page.getByText('雾影庄 · 山间外景 · 正在生活')).toBeVisible()
  // 首帧/相机未稳定时一次性点击会落空,沿用 voxel-guest 的重试点击模式
  await expect(async () => {
    const location = await page.evaluate(() => (window.__voxelEngine as never as {
      worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null
    } | undefined)?.worldToScreen({ x: 8, y: 4, z: 11 }))
    expect(location).not.toBeNull()
    await page.mouse.click(location!.x, location!.y)
    await expect(page.getByRole('heading', { name: '温室' })).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15000 })
  await expect(page.getByText('此刻在这里：暂时没有居民')).toBeVisible()
  await expect(page.getByRole('button', { name: '进入此地点' })).toBeVisible()
  await page.getByRole('button', { name: '关闭信息' }).click()

  // S0 G2:登录保存地图也能点选居民；关闭面板后继续点选地点。
  await expect(async () => {
    const at = await page.evaluate(() => {
      const probe = window.__voxelEngine as never as {
        residents: { snapshot(): { personId: string; position: { x: number; y: number; z: number } }[] } | null
        worldToScreen(coord: { x: number; y: number; z: number }): { x: number; y: number } | null
      } | undefined
      const resident = probe?.residents?.snapshot().find(item => item.personId === 'person-1')
      if (!probe || !resident) return null
      return probe.worldToScreen({
        x: Math.floor(resident.position.x),
        y: Math.floor(resident.position.y) + 1,
        z: Math.floor(resident.position.z),
      })
    })
    expect(at).not.toBeNull()
    await page.mouse.click(at!.x, at!.y)
    await expect(page.getByTestId('map-selection-card').getByRole('heading', { name: 'Ada' })).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15000 })
  await expect(page.getByText('现在在主楼 · 正在安顿')).toBeVisible()
  await expect(page.getByRole('button', { name: '以访客身份进入' })).toBeVisible()
  await page.getByRole('button', { name: '关闭信息' }).click()

  await expect(async () => {
    const location = await page.evaluate(() => (window.__voxelEngine as never as {
      worldToScreen(coord: { x: number; y: number; z: number }): { x: number; y: number } | null
    } | undefined)?.worldToScreen({ x: 8, y: 4, z: 11 }))
    expect(location).not.toBeNull()
    await page.mouse.click(location!.x, location!.y)
    await expect(page.getByRole('heading', { name: '温室' })).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15000 })
})

test('unavailable scene shows the world page retry state', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [{ id: 'world-1', name: world.name }] } }))
  await page.route('**/api/worlds/world-1**', route => {
    const url = route.request().url()
    if (url.includes('/map/bootstrap')) return route.fulfill({ json: {
      access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: true, resetDemo: false },
      world: snapshot,
      scene: { status: 'unavailable', document: null },
      presentation: { timelineId: 'timeline-1', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
      theme: { id: 'mist-manor', assetVersion: 'fixture' },
      resume: { worldId: 'world-1', timelineId: 'timeline-1', spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow },
    } })
    return route.fulfill({ json: snapshot })
  })

  await page.goto('/worlds/world-1?timeline=timeline-1')
  const missing = page.getByTestId('world-canvas-missing')
  await expect(missing).toBeVisible()
  await expect(missing).toContainText('场景暂时不可用，请重试。')
  await expect(missing.getByRole('button', { name: '重试' })).toBeVisible()
})
