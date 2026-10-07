import { expect, test, type Page } from '@playwright/test'
import { snapshotFor, stubSplitApis, voxelDocument } from './split-view-stubs'

test.describe.configure({ mode: 'serial', timeout: 240_000 })

async function stubSecondWorld(page: Page, options: { failFirstBootstrap?: boolean } = {}) {
  let bootstrapReads = 0
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/worlds/world-2/map/bootstrap') return route.fallback()
    bootstrapReads += 1
    const timelineId = url.searchParams.get('timelineId') ?? 'timeline-main'
    if (options.failFirstBootstrap && bootstrapReads === 1) {
      return route.fulfill({ status: 503, json: { error: 'temporary second-world outage' } })
    }
    return route.fulfill({ json: secondWorldBootstrap(timelineId) })
  })
  await page.route('**/api/worlds/world-2?*', route => {
    const timelineId = new URL(route.request().url()).searchParams.get('timelineId') ?? 'timeline-main'
    const world = snapshotFor(timelineId)
    world.world.id = 'world-2'
    world.world.name = '第二世界'
    return route.fulfill({ json: world })
  })
  await page.route('**/api/worlds/world-2/scene', route => route.fulfill({ json: { status: 'ready', version: 2, document: voxelDocument } }))
  return () => bootstrapReads
}

function secondWorldBootstrap(timelineId: string) {
  const world = snapshotFor(timelineId)
  world.world.id = 'world-2'
  world.world.name = '第二世界'
  return {
    access: { observe: true, participate: false, editScene: false, fork: false, compare: true, persist: false, resetDemo: false },
    world,
    scene: { status: 'ready', document: voxelDocument },
    presentation: { timelineId, stateVersion: 2, simNow: world.simNow, timeOfDay: 'day' as const, weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
    theme: { id: 'mist-manor', assetVersion: 'e2e-world-2' },
    resume: { worldId: 'world-2', timelineId, spaceId: 'exterior', mode: 'life' as const, updatedAt: world.simNow },
  }
}

async function expectKinds(page: Page, left: 'native2d' | 'voxel3d', right: 'native2d' | 'voxel3d') {
  await expect(page.locator('[data-testid="presentation-host-left"] [data-presentation]')).toHaveAttribute('data-presentation', left)
  await expect(page.locator('[data-testid="presentation-host-right"] [data-presentation]')).toHaveAttribute('data-presentation', right)
  await expect(page.getByTestId('comparison-pane-left')).toHaveAttribute('data-world-id', 'world-1')
  await expect(page.getByTestId('comparison-pane-right')).toHaveAttribute('data-world-id', 'world-2')
  await expect(page.getByTestId('pane-facts-left')).toContainText('timeline-main')
  await expect(page.getByTestId('pane-facts-right')).toContainText('timeline-fork')
}

test('cross-world workspace keeps each timeline and supports all four renderer pairs', async ({ page }) => {
  await stubSplitApis(page)
  await stubSecondWorld(page)
  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=voxel3d&rightWorld=world-2&right=timeline-fork&rightPresentation=native2d')
  await expectKinds(page, 'voxel3d', 'native2d')
  await expect(page.locator('[data-voxel-instance="left"] [data-testid="voxel-viewport-canvas"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-presentation="native2d"] canvas')).toBeVisible({ timeout: 30_000 })

  await page.getByRole('group', { name: '左侧画面表现' }).getByRole('button', { name: '2D' }).click()
  await expectKinds(page, 'native2d', 'native2d')
  await page.getByRole('group', { name: '右侧画面表现' }).getByRole('button', { name: '3D' }).click()
  await expectKinds(page, 'native2d', 'voxel3d')
  await page.getByRole('group', { name: '左侧画面表现' }).getByRole('button', { name: '3D' }).click()
  await expectKinds(page, 'voxel3d', 'voxel3d')
  await expect(page.getByTestId('comparison-camera-link').locator('input')).toBeDisabled()
})

test('one pane can fail and retry without reloading its working sibling', async ({ page }) => {
  await stubSplitApis(page)
  const rightReads = await stubSecondWorld(page, { failFirstBootstrap: true })
  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=voxel3d&rightWorld=world-2&right=timeline-fork&rightPresentation=voxel3d')
  await expect(page.getByTestId('comparison-pane-right').getByRole('alert')).toContainText('temporary second-world outage')
  await expect(page.locator('[data-voxel-instance="left"] [data-testid="voxel-viewport-canvas"]')).toBeVisible({ timeout: 30_000 })
  const leftEngine = await page.evaluate(() => (window as unknown as { __voxelEngines?: Record<string, unknown> }).__voxelEngines?.left)
  await page.evaluate(engine => { (window as unknown as { __leftEngine?: unknown }).__leftEngine = engine }, leftEngine)
  await page.getByRole('button', { name: '重试此侧' }).click()
  await expect(page.getByTestId('pane-facts-right')).toContainText('timeline-fork')
  await expect.poll(() => rightReads()).toBe(3)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __voxelEngines?: Record<string, unknown> }).__voxelEngines?.left === (window as unknown as { __voxelEngines?: Record<string, unknown> }).__leftEngine)).toBe(true)
})
