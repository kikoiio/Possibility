import { expect, test, type Page } from '@playwright/test'
import { snapshotFor, stubSplitApis, voxelDocument } from './split-view-stubs'

test.describe.configure({ mode: 'serial', timeout: 240_000 })

async function stubSecondWorld(page: Page, options: { failFirstBootstrap?: boolean } = {}) {
  let bootstrapReads = 0
  let recovering = !options.failFirstBootstrap
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/worlds/world-2/map/bootstrap') return route.fallback()
    bootstrapReads += 1
    const timelineId = url.searchParams.get('timelineId') ?? 'timeline-main'
    if (!recovering) {
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
  return { reads: () => bootstrapReads, recover: () => { recovering = true } }
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
  let leftBootstrapReads = 0
  await page.route('**/api/worlds/world-1/map/bootstrap**', route => {
    leftBootstrapReads += 1
    return route.fallback()
  })
  const rightReads = await stubSecondWorld(page, { failFirstBootstrap: true })
  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=voxel3d&rightWorld=world-2&right=timeline-fork&rightPresentation=voxel3d')
  await expect(page.getByTestId('comparison-pane-right').getByRole('alert')).toContainText('temporary second-world outage')
  await expect(page.locator('[data-voxel-instance="left"] [data-testid="voxel-viewport-canvas"]')).toBeVisible({ timeout: 30_000 })
  const leftReadsBeforeRetry = leftBootstrapReads
  rightReads.recover()
  await page.getByRole('button', { name: '重试此侧' }).click()
  await expect(page.getByTestId('pane-facts-right')).toContainText('timeline-fork')
  await expect.poll(() => rightReads.reads()).toBeGreaterThanOrEqual(3)
  await expect.poll(() => leftBootstrapReads).toBe(leftReadsBeforeRetry)
  await expect(page.locator('[data-voxel-instance="left"] [data-testid="voxel-viewport-canvas"]')).toBeVisible()
})

test('left pane can fail and retry while the right pane stays ready', async ({ page }) => {
  await stubSplitApis(page)
  let leftBootstrapReads = 0
  let failLeft = true
  await page.route('**/api/worlds/world-1/map/bootstrap**', route => {
    leftBootstrapReads += 1
    if (failLeft) return route.fulfill({ status: 503, json: { error: 'temporary first-world outage' } })
    return route.fallback()
  })
  const rightReads = await stubSecondWorld(page)
  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=native2d&rightWorld=world-2&right=timeline-fork&rightPresentation=voxel3d')
  await expect(page.getByTestId('comparison-pane-left').getByRole('alert')).toContainText('temporary first-world outage')
  await expect(page.locator('[data-voxel-instance="right"] [data-testid="voxel-viewport-canvas"]')).toBeVisible({ timeout: 30_000 })

  const rightReadsBeforeRetry = rightReads.reads()
  failLeft = false
  await page.getByTestId('comparison-pane-left').getByRole('button', { name: '重试此侧' }).click()
  await expect(page.getByTestId('pane-facts-left')).toContainText('timeline-main')
  await expect(page.locator('[data-presentation="native2d"] canvas')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => leftBootstrapReads).toBeGreaterThanOrEqual(2)
  await expect.poll(() => rightReads.reads()).toBe(rightReadsBeforeRetry)
  await expect(page.locator('[data-voxel-instance="right"] [data-testid="voxel-viewport-canvas"]')).toBeVisible()
})
