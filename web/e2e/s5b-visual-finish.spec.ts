import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const voxelSpaces = JSON.parse(readFileSync(new URL('../../api/src/demo/mist-manor-voxel-spaces.json', import.meta.url), 'utf8'))

const snapshot = {
  world: {
    id: 'demo', name: '雾影庄', description: '白雾町的旧宅', status: 'running', pauseReason: null,
    isDemo: true, callsToday: 0,
    locations: [
      { name: '大厅', description: '主楼大厅' },
      { name: '温室花房', description: '玻璃温室' },
      { name: '后山散步道', description: '沿着石灯笼走向后山' },
    ],
  },
  timelines: [{ id: 'main', parentTimelineId: null, simNow: '2026-09-28T02:00:00.000Z' }],
  currentTimelineId: 'main', simNow: '2026-09-28T02:00:00.000Z',
  stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured',
  evidence: { level: 'complete', reasonCodes: [] },
  currentFacts: [{ factType: 'environment', value: { condition: 'weather', value: '雾', location: '世界' } }],
  locationBoard: [{ location: '大厅', persons: [{ id: 'person-host', name: '主人', activity: '在灯下整理信件' }] }],
  events: [],
}

async function mockGuestMap(page: Page) {
  await page.addInitScript(() => localStorage.setItem('possibility:flag:voxel', '1'))
  await page.route('**/api/demo/session', (route) => route.fulfill({ json: {
    token: 'guest-token', sessionId: 's5b-session', worldId: 'demo', timelineId: 'main', generation: 1,
    expiresAt: '2026-09-29T12:00:00.000Z',
  } }))
  await page.route('**/api/worlds/demo/map/bootstrap**', (route) => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: false, resetDemo: true },
    world: snapshot,
    scene: { status: 'ready', document: voxelSpaces },
    presentation: { timelineId: 'main', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'night', weather: '雾', residents: [], locations: [], signals: [] },
    theme: { id: 'mist-manor', assetVersion: 's5b-e2e' },
    resume: { worldId: 'demo', timelineId: 'main', spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow },
  } }))
  await page.route('**/api/worlds/demo/map/resume', (route) => route.fulfill({ json: { ok: true } }))
}

async function waitReady(page: Page) {
  await expect(page.getByTestId('guest-world-map')).toBeVisible()
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 20_000 })
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible()
}

async function probe<T>(page: Page, fn: (engine: unknown) => T): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__voxelEngine)`) as Promise<T>
}

async function clickSpaceEntry(page: Page) {
  const entry = await probe(page, (engine) => {
    const e = engine as { worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null; world: { doc: { spaceEntries: { at: { x: number; y: number; z: number } }[] } } | null }
    const at = e.world?.doc.spaceEntries[0]?.at
    return at ? e.worldToScreen(at) : null
  })
  expect(entry).not.toBeNull()
  await page.mouse.click(entry!.x, entry!.y)
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 20_000 })
}

async function clickWorldObject(page: Page, objectId: string) {
  const screen = await page.evaluate((id) => {
    const e = window.__voxelEngine as unknown as { worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null; world: { doc: { objects: { id: string; anchor: { x: number; y: number; z: number } }[] } } | null }
    const object = e.world?.doc.objects.find((item) => item.id === id)
    return object ? e.worldToScreen(object.anchor) : null
  }, objectId)
  expect(screen).not.toBeNull()
  await page.mouse.click(screen!.x, screen!.y)
}

async function clickWorldResident(page: Page, personId: string) {
  const screen = await page.evaluate((id) => {
    const e = window.__voxelEngine as unknown as {
      residents: { snapshot(): { personId: string; position: { x: number; y: number; z: number } }[] } | null
      worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null
    }
    const resident = e.residents?.snapshot().find((item) => item.personId === id)
    if (!resident) return null
    return e.worldToScreen({ x: Math.floor(resident.position.x), y: Math.floor(resident.position.y) + 1, z: Math.floor(resident.position.z) })
  }, personId)
  expect(screen, `resident ${personId} should be present after map reload`).not.toBeNull()
  await page.mouse.click(screen!.x, screen!.y)
}

test.describe('S5B visual finish desktop', () => {
  test.setTimeout(120_000)

  test('雾夜外景→主楼室内→第一视角移动→返回外景', async ({ page }) => {
    await mockGuestMap(page)
    await page.goto('/')
    await waitReady(page)
    await page.getByRole('button', { name: '跳过' }).click()

    await expect(page.getByText('雾影庄 · 雾影庄外景 · 正在生活')).toBeVisible()
    const exterior = await probe(page, (engine) => {
      const e = engine as { probeScene(): { spaceContext: { kind: string; skyVisible: boolean; skyLightEnabled: boolean; fogMode: string }; cameraMode: string; visibleObjectIds: string[] } }
      return e.probeScene()
    })
    expect(exterior.spaceContext.kind).toBe('exterior')
    expect(exterior.spaceContext.skyVisible).toBe(true)
    expect(exterior.spaceContext.skyLightEnabled).toBe(true)
    expect(exterior.spaceContext.fogMode).toBe('outdoor')
    expect(exterior.cameraMode).toBe('orbit')
    await expect.poll(() => probe(page, (engine) => (engine as { probeScene(): { visibleObjectIds: string[] } }).probeScene().visibleObjectIds.length), { timeout: 10_000 }).toBeGreaterThan(0)
    const visibleObjectIds = await probe(page, (engine) => (engine as { probeScene(): { visibleObjectIds: string[] } }).probeScene().visibleObjectIds)
    expect(visibleObjectIds).toContain('manor-main-house-1')
    expect(visibleObjectIds).toContain('greenhouse-1')
    await page.screenshot({ path: '/tmp/s5b-desktop-exterior.png' })

    await clickSpaceEntry(page)
    await expect(page.getByText('雾影庄 · 主楼室内 · 正在生活')).toBeVisible()
    const interior = await probe(page, (engine) => {
      const e = engine as {
        probeScene(): { spaceContext: { kind: string; skyVisible: boolean; skyLightEnabled: boolean; fogMode: string }; cameraMode: string; walkPosition: unknown; skyExposedAtPlayer: boolean | null }
        inspectInterior(): { hasFloor: boolean; hasContinuousRoof: boolean; hasClosedWallBoundary: boolean; walkableSpawn: unknown; exposedCells: unknown[] } | null
        lighting: { isSkyLightEnabled(): boolean } | null
      }
      return { probe: e.probeScene(), closure: e.inspectInterior(), skyLight: e.lighting?.isSkyLightEnabled() }
    })
    expect(interior.probe.spaceContext.kind).toBe('interior')
    expect(interior.probe.skyVisible).toBe(false)
    expect(interior.probe.spaceContext.skyLightEnabled).toBe(false)
    expect(interior.probe.spaceContext.fogMode).toBe('indoor')
    expect(interior.probe.cameraMode).toBe('orbit')
    expect(interior.skyLight).toBe(false)
    expect(interior.closure).toMatchObject({ hasFloor: true, hasContinuousRoof: true, hasClosedWallBoundary: true })
    expect(interior.closure?.walkableSpawn).not.toBeNull()
    expect(interior.closure?.walkableSpawn?.y ?? 0).toBeGreaterThan(0)
    expect(interior.closure?.exposedCells).toHaveLength(0)

    // Assert the visible control works; keyboard-only coverage hid an overlap
    // with the production map header's settings button.
    await page.getByTestId('voxel-mode-toggle').click()
    await expect(page.getByTestId('voxel-crosshair')).toBeVisible()
    await expect.poll(() => probe(page, (engine) => (engine as { probeScene(): { cameraMode: string; walkPosition: unknown; skyExposedAtPlayer: boolean | null } }).probeScene()), { timeout: 10_000 }).toMatchObject({ cameraMode: 'walk' })
    await expect.poll(() => probe(page, (engine) => (engine as { probeScene(): { visibleObjectIds: string[] } }).probeScene().visibleObjectIds.length), { timeout: 10_000 }).toBeGreaterThan(0)
    const indoorVisibleObjectIds = await probe(page, (engine) => (engine as { probeScene(): { visibleObjectIds: string[] } }).probeScene().visibleObjectIds)
    expect(indoorVisibleObjectIds).toContain('hall-low-table')
    expect(indoorVisibleObjectIds).toContain('hall-bookshelf')
    expect(indoorVisibleObjectIds).toContain('lantern-hall-se')
    const before = await probe(page, (engine) => (engine as { probeScene(): { walkPosition: { x: number; y: number; z: number } | null } }).probeScene().walkPosition)
    const spawnOverlapsFurniture = await probe(page, (engine) => {
      const e = engine as { probeScene(): { walkPosition: { x: number; y: number; z: number } | null }; world: { doc: { objects: { anchor: { x: number; y: number; z: number } }[] } } | null }
      const at = e.probeScene().walkPosition
      return !!at && e.world?.doc.objects.some(({ anchor }) =>
        Math.abs(anchor.x - at.x) <= 2
        && Math.abs(anchor.z - at.z) <= 2
        && anchor.y >= at.y - 1
        && anchor.y <= at.y + 2)
    })
    expect(spawnOverlapsFurniture).toBe(false)
    await page.screenshot({ path: '/tmp/s5b-desktop-interior-spawn.png' })
    await page.keyboard.down('KeyW')
    await page.waitForTimeout(900)
    await page.keyboard.up('KeyW')
    const after = await probe(page, (engine) => (engine as { probeScene(): { walkPosition: { x: number; y: number; z: number } | null } }).probeScene().walkPosition)
    expect(before).not.toBeNull()
    expect(after).not.toBeNull()
    expect(Math.hypot(after!.x - before!.x, after!.z - before!.z)).toBeGreaterThan(0.1)
    const walked = await probe(page, (engine) => (engine as { probeScene(): { skyExposedAtPlayer: boolean | null } }).probeScene().skyExposedAtPlayer)
    expect(walked, `walk position before=${JSON.stringify(before)} after=${JSON.stringify(after)}`).toBe(false)
    await page.screenshot({ path: '/tmp/s5b-desktop-interior.png' })

    await page.getByTestId('voxel-mode-toggle').click()
    await expect.poll(() => probe(page, (engine) => (engine as { probeScene(): { cameraMode: string } }).probeScene().cameraMode), { timeout: 10_000 }).toBe('orbit')
    await page.getByTestId('voxel-space-exterior').click()
    await waitReady(page)
    await expect(page.getByText('雾影庄 · 雾影庄外景 · 正在生活')).toBeVisible()
    const returned = await probe(page, (engine) => (engine as { probeScene(): { spaceContext: { kind: string; skyVisible: boolean; skyLightEnabled: boolean }; cameraMode: string } }).probeScene())
    expect(returned.spaceContext.kind).toBe('exterior')
    expect(returned.spaceContext.skyVisible).toBe(true)
    expect(returned.spaceContext.skyLightEnabled).toBe(true)
    expect(returned.cameraMode).toBe('orbit')

    await clickWorldObject(page, 'greenhouse-1')
    await expect(page.getByTestId('map-selection-card')).toBeVisible()
    await expect(page.getByRole('heading', { name: '温室花房' })).toBeVisible()
    await page.getByRole('button', { name: '关闭信息' }).click()
    const experienceNav = page.getByRole('navigation', { name: '体验位置' })
    await experienceNav.getByRole('button', { name: '观察' }).click()
    await expect(experienceNav.getByRole('button', { name: '观察' })).toHaveAttribute('aria-pressed', 'true')
    await experienceNav.getByRole('button', { name: '可能' }).click()
    await expect(page.getByText('改变一个条件')).toBeVisible()
    await experienceNav.getByRole('button', { name: '在场' }).click()
  })
})

test.describe('S5B 保存前后地图回归 owner', () => {
  test.setTimeout(120_000)

  test('可编辑双空间保存刷新后仍可切换和打开地点卡', async ({ page }) => {
    let savedBundle = structuredClone(voxelSpaces)
    let savedVersion = 5
    let committedSpaceId: string | null = null
    const initialAssetCount = voxelSpaces.spaces.find((space) => space.id === 'exterior')?.document.assetPlacements?.length ?? 0

    await page.addInitScript(() => {
      localStorage.setItem('possibility_token', 'e2e-token')
      localStorage.setItem('possibility:flag:voxel', '1')
    })
    await page.route('**/api/worlds', (route) => route.fulfill({ json: { worlds: [{
      id: 'world-1', name: '雾影庄', description: '白雾町的旧宅', status: 'running', pauseReason: null,
      isDemo: false, hasScene: true, personIds: ['person-host'], personCount: 1, callsToday: 0,
      simNow: snapshot.simNow, timeZone: 'UTC', createdAt: snapshot.simNow,
    }] } }))
    await page.route('**/api/persons', (route) => route.fulfill({ json: { persons: [{ id: 'person-host', name: '主人', createdAt: snapshot.simNow }] } }))
    await page.route('**/api/worlds/world-1/stream**', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }))
    await page.route('**/api/worlds/world-1/map/bootstrap**', (route) => route.fulfill({ json: {
      access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
      world: { ...snapshot, world: { ...snapshot.world, id: 'world-1', isDemo: false, locations: [
        { name: '大厅', description: '主楼大厅' },
        { name: '温室花房', description: '玻璃温室' },
      ] } },
      scene: { status: 'ready', document: savedBundle },
      presentation: { timelineId: 'main', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'night', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
      theme: { id: 'mist-manor', assetVersion: 's5b-owner-e2e' },
      resume: { worldId: 'world-1', timelineId: 'main', spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow },
    } }))
    await page.route(/\/api\/worlds\/world-1(?:\?|$)/, (route) => route.fulfill({ json: {
      ...snapshot,
      world: { ...snapshot.world, id: 'world-1', isDemo: false, locations: [
        { name: '大厅', description: '主楼大厅' },
        { name: '温室花房', description: '玻璃温室' },
      ] },
    } }))
    await page.route('**/api/worlds/world-1/map/resume', (route) => route.fulfill({ json: { ok: true } }))
    await page.route('**/api/worlds/world-1/persona**', (route) => route.fulfill({ json: { persona: { id: 'p-owner', name: '访客', description: '旅人', location: '大厅' }, unread: 0 } }))
    await page.route('**/api/worlds/world-1/persona/messages**', (route) => route.fulfill({ json: { messages: [], mentions: [] } }))
    await page.route('**/api/worlds/world-1/scene/board**', (route) => route.fulfill({ json: { board: [{ location: '大厅', count: 1, people: [{ id: 'person-host', name: '主人' }] }] } }))
    await page.route('**/api/worlds/world-1/scene/history**', (route) => route.fulfill({ json: { dialogueId: null, location: null, turns: [] } }))
    await page.route('**/api/worlds/world-1/scene/intent/pending**', (route) => route.fulfill({ json: { proposal: null } }))
    await page.route('**/api/worlds/world-1/state**', (route) => route.fulfill({ json: { timelineId: 'main', version: 1, current: [], facts: [] } }))
    await page.route('**/api/worlds/world-1/timelines/*/history', (route) => route.fulfill({ json: { earliest: null, simNow: snapshot.simNow } }))
    await page.route('**/api/worlds/world-1/return**', (route) => route.fulfill({ json: { timelineId: 'main', simNow: snapshot.simNow, firstVisit: false, cursor: 0, events: [], commitments: [], unread: 0 } }))
    await page.route('**/api/worlds/world-1/scene', (route) => route.fulfill({ json: { status: 'ready', document: savedBundle, version: savedVersion, contentHash: 's5b-e2e', createdAt: snapshot.simNow } }))
    await page.route('**/api/worlds/world-1/scene/compatibility/preflight', (route) =>
      route.fulfill({ json: {
        status: 'valid',
        basis: { version: savedVersion, contentHash: 's5b-e2e', policyVersion: 'test' },
        report: { status: 'diagnosed', issues: [] },
      } })
    )
    await page.route('**/api/worlds/world-1/scene/voxel-revision', (route) => {
      const body = route.request().postDataJSON() as { document: typeof voxelSpaces; spaceId: string }
      committedSpaceId = body.spaceId
      savedBundle = body.document
      savedVersion += 1
      return route.fulfill({ json: { document: savedBundle, version: savedVersion, contentHash: 's5b-e2e', createdAt: snapshot.simNow } })
    })

    await page.goto('/worlds/world-1')
    await waitReady(page)
    await expect(page.getByTestId('voxel-editor-toolbar')).toBeVisible()
    const before = await page.getByTestId('voxel-viewport-canvas').boundingBox()
    expect(before?.height ?? 0).toBeGreaterThan(400)
    await expect(page.getByTestId('voxel-space-main-house-interior')).toBeVisible()

    await clickWorldObject(page, 'greenhouse-1')
    await expect(page.getByTestId('map-selection-card')).toBeVisible()
    await expect(page.getByRole('heading', { name: '温室花房' })).toBeVisible()
    await page.getByRole('button', { name: '关闭信息' }).click()

    // 在外景放置一朵花，走现有编辑器的防抖保存与 voxel-revision 提交。
    await page.getByTestId('voxel-tool-asset').click()
    await page.getByTestId('voxel-asset-item-veg-flower-a').click()
    const dropAt = await probe(page, (engine) => {
      const e = engine as { worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null }
      return e.worldToScreen({ x: 34, y: 4, z: 30 })
    })
    expect(dropAt).not.toBeNull()
    await page.mouse.click(dropAt!.x, dropAt!.y)
    await page.keyboard.press('Escape')
    await expect.poll(() => committedSpaceId, { timeout: 10_000 }).toBe('exterior')
    expect(savedBundle.spaces.map((space) => space.id)).toEqual(['exterior', 'main-house-interior'])
    expect(savedBundle.spaces.find((space) => space.id === 'exterior')?.document.assetPlacements?.length).toBe(initialAssetCount + 1)

    await page.reload()
    await waitReady(page)
    const after = await page.getByTestId('voxel-viewport-canvas').boundingBox()
    expect(after?.height ?? 0).toBeGreaterThan(400)
    expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThanOrEqual(2)
    await expect(page.getByTestId('voxel-editor-toolbar')).toBeVisible()
    await expect.poll(() => probe(page, (engine) => {
      const e = engine as { world: { doc: { assetPlacements?: unknown[] } } | null }
      return e.world?.doc.assetPlacements?.length ?? 0
    })).toBe(initialAssetCount + 1)

    await clickWorldResident(page, 'person-host')
    await expect(page.getByTestId('map-selection-card')).toBeVisible()
    // Depending on the resident's current marker hit target, the card may be
    // the resident detail or the resident's location detail; both identify the
    // resident and prove post-reload interaction is available.
    await expect(page.getByTestId('map-selection-card').getByText(/主人/)).toBeVisible()
    await page.getByRole('button', { name: '关闭信息' }).click()

    // After selecting a resident the orbit camera may be focused away from the
    // projected entry marker; exercise the persistent owner space control here.
    await page.getByTestId('voxel-space-main-house-interior').click()
    await waitReady(page)
    await expect(page.getByText('雾影庄 · 主楼室内 · 正在生活')).toBeVisible()
    const closure = await probe(page, (engine) => (engine as { inspectInterior(): { hasFloor: boolean; hasContinuousRoof: boolean; hasClosedWallBoundary: boolean } | null }).inspectInterior())
    expect(closure).toMatchObject({ hasFloor: true, hasContinuousRoof: true, hasClosedWallBoundary: true })
    await page.getByTestId('voxel-space-exterior').click()
    await waitReady(page)
    await expect(page.getByText('雾影庄 · 雾影庄外景 · 正在生活')).toBeVisible()
    await clickWorldObject(page, 'greenhouse-1')
    await expect(page.getByTestId('map-selection-card')).toBeVisible()
    await expect(page.getByRole('heading', { name: '温室花房' })).toBeVisible()
    await page.getByRole('button', { name: '进入此地点' }).click()
    await expect(page.getByRole('heading', { name: '进入世界' })).toBeVisible()
    await expect(page.getByLabel('进入地点')).toHaveValue('温室花房')
  })
})
