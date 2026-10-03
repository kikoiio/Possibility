import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const voxelSpaces = JSON.parse(readFileSync(new URL('../../api/src/demo/mist-manor-voxel-spaces.json', import.meta.url), 'utf8'))

const snapshot = {
  world: {
    id: 'demo', name: '雾影庄', description: '白雾町的旧宅', status: 'running', pauseReason: null,
    isDemo: true, callsToday: 0, locations: [{ name: '大厅', description: '主楼大厅' }],
  },
  timelines: [{ id: 'main', parentTimelineId: null, simNow: '2026-09-28T02:00:00.000Z' }],
  currentTimelineId: 'main', simNow: '2026-09-28T02:00:00.000Z', stateVersion: 1, worldModelVersion: 1,
  evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [],
  locationBoard: [{ location: '大厅', persons: [{ id: 'person-host', name: '主人', activity: '在灯下整理信件' }] }], events: [],
}

async function mockGuestMap(page: Page) {
  await page.addInitScript(() => localStorage.setItem('possibility:flag:voxel', '1'))
  await page.route('**/api/demo/session', (route) => route.fulfill({ json: {
    token: 'guest-token', sessionId: 's5b-mobile-session', worldId: 'demo', timelineId: 'main', generation: 1,
    expiresAt: '2026-09-29T12:00:00.000Z',
  } }))
  await page.route('**/api/worlds/demo/map/bootstrap**', (route) => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: false, resetDemo: true },
    world: snapshot, scene: { status: 'ready', document: voxelSpaces },
    presentation: { timelineId: 'main', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'night', weather: '雾', residents: [], locations: [], signals: [] },
    theme: { id: 'mist-manor', assetVersion: 's5b-mobile-e2e' },
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

test('S5B mobile:外景→室内→返回外景且无横向溢出', async ({ page }) => {
  await mockGuestMap(page)
  await page.goto('/')
  await waitReady(page)
  await page.getByRole('button', { name: '跳过' }).click()

  await expect(page.getByText('雾影庄 · 雾影庄外景 · 正在生活')).toBeVisible()
  await expect(page.getByTestId('voxel-mode-toggle')).toHaveCount(0)
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible()
  await expect.poll(() => probe(page, (engine) => (engine as { probeScene(): { visibleObjectIds: string[] } }).probeScene().visibleObjectIds.length), { timeout: 10_000 }).toBeGreaterThan(0)
  const exterior = await probe(page, (engine) => (engine as { probeScene(): { visibleObjectIds: string[] } }).probeScene())
  expect(exterior.visibleObjectIds).toContain('manor-main-house-1')
  expect(exterior.visibleObjectIds).toContain('greenhouse-1')
  const modeNav = await page.getByRole('navigation', { name: '体验位置' }).boundingBox()
  const spaceEntry = await page.getByTestId('voxel-space-main-house-interior').boundingBox()
  expect(modeNav).not.toBeNull()
  expect(spaceEntry).not.toBeNull()
  expect(modeNav!.y + modeNav!.height).toBeLessThanOrEqual(spaceEntry!.y)
  const exteriorOverflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))
  expect(exteriorOverflow.scrollWidth).toBeLessThanOrEqual(exteriorOverflow.clientWidth)
  await page.screenshot({ path: '/tmp/s5b-mobile-exterior.png' })

  await clickSpaceEntry(page)
  await expect(page.getByText('雾影庄 · 主楼室内 · 正在生活')).toBeVisible()
  const interior = await probe(page, (engine) => {
    const e = engine as {
      probeScene(): { spaceContext: { kind: string; skyVisible: boolean; skyLightEnabled: boolean }; cameraMode: string; worldSize: { width: number; height: number; depth: number } | null }
      inspectInterior(): { hasContinuousRoof: boolean; hasClosedWallBoundary: boolean; exposedCells: unknown[] } | null
    }
    return { probe: e.probeScene(), closure: e.inspectInterior() }
  })
  expect(interior.probe.spaceContext.kind).toBe('interior')
  expect(interior.probe.spaceContext.skyVisible).toBe(false)
  expect(interior.probe.spaceContext.skyLightEnabled).toBe(false)
  expect(interior.probe.cameraMode).toBe('orbit')
  expect(interior.probe.worldSize).toEqual({ width: 24, height: 8, depth: 24 })
  expect(interior.closure).toMatchObject({ hasContinuousRoof: true, hasClosedWallBoundary: true, exposedCells: [] })
  await expect(page.getByTestId('voxel-space-exterior')).toBeVisible()
  const interiorOverflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))
  expect(interiorOverflow.scrollWidth).toBeLessThanOrEqual(interiorOverflow.clientWidth)
  await page.screenshot({ path: '/tmp/s5b-mobile-interior.png' })

  await page.getByTestId('voxel-space-exterior').click()
  await waitReady(page)
  await expect(page.getByText('雾影庄 · 雾影庄外景 · 正在生活')).toBeVisible()
  await expect(page.getByTestId('voxel-space-main-house-interior')).toBeVisible()
  const returned = await probe(page, (engine) => (engine as { probeScene(): { spaceContext: { kind: string; skyVisible: boolean; skyLightEnabled: boolean } } }).probeScene())
  expect(returned.spaceContext.kind).toBe('exterior')
  expect(returned.spaceContext.skyVisible).toBe(true)
  expect(returned.spaceContext.skyLightEnabled).toBe(true)
  const returnedOverflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))
  expect(returnedOverflow.scrollWidth).toBeLessThanOrEqual(returnedOverflow.clientWidth)
})
