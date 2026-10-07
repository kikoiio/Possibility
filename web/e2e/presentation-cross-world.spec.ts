import { expect, test, type Page } from '@playwright/test'
import { snapshotFor, stubSplitApis, voxelDocument } from './split-view-stubs'

test.describe.configure({ mode: 'serial', timeout: 240_000 })

async function stubSecondWorld(page: Page) {
  await page.route('**/api/worlds/world-2/map/bootstrap**', route => {
    const timelineId = new URL(route.request().url()).searchParams.get('timelineId') ?? 'timeline-main'
    const world = snapshotFor(timelineId)
    world.world.id = 'world-2'
    world.world.name = '第二世界'
    return route.fulfill({ json: {
      access: { observe: true, participate: false, editScene: false, fork: false, compare: true, persist: false, resetDemo: false },
      world,
      scene: { status: 'ready', document: voxelDocument },
      presentation: { timelineId, stateVersion: 2, simNow: world.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
      theme: { id: 'mist-manor', assetVersion: 'e2e-world-2' },
      resume: { worldId: 'world-2', timelineId, spaceId: 'exterior', mode: 'life', updatedAt: world.simNow },
    } })
  })
  await page.route('**/api/worlds/world-2?*', route => {
    const timelineId = new URL(route.request().url()).searchParams.get('timelineId') ?? 'timeline-main'
    const world = snapshotFor(timelineId)
    world.world.id = 'world-2'
    world.world.name = '第二世界'
    return route.fulfill({ json: world })
  })
  await page.route('**/api/worlds/world-2/scene', route => route.fulfill({ json: { status: 'ready', version: 2, document: voxelDocument } }))
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
