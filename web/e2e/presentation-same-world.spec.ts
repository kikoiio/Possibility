import { expect, test, type Page } from '@playwright/test'
import { stubSplitApis } from './split-view-stubs'

test.describe.configure({ mode: 'serial', timeout: 180_000 })

interface ProbeWindow {
  __voxelEngines?: Record<string, { getOrbitPose(): { theta: number } | null; setOrbitPose(pose: unknown): void }>
}

test('same-world linked cameras follow together, then disable for mixed renderers', async ({ page }) => {
  await stubSplitApis(page)
  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=voxel3d&rightWorld=world-1&right=timeline-fork&rightPresentation=voxel3d')
  const left = page.locator('[data-voxel-instance="left"] [data-testid="voxel-viewport-canvas"]')
  const right = page.locator('[data-voxel-instance="right"] [data-testid="voxel-viewport-canvas"]')
  await expect(left).toBeVisible({ timeout: 30_000 })
  await expect(right).toBeVisible({ timeout: 30_000 })
  const link = page.getByTestId('comparison-camera-link').locator('input')
  await expect(link).toBeEnabled()
  await link.check()

  const pose = { theta: 1.9, phi: 0.7, distance: 90, target: { x: 5, y: 3, z: 8 } }
  await page.evaluate(value => (window as unknown as ProbeWindow).__voxelEngines!.left!.setOrbitPose(value), pose)
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as ProbeWindow).__voxelEngines?.right?.getOrbitPose()))?.theta, { timeout: 30_000 }).toBeCloseTo(1.9, 2)

  await page.getByRole('group', { name: '右侧画面表现' }).getByRole('button', { name: '2D' }).click()
  await expect(link).toBeDisabled()
  await expect(page).toHaveURL(/rightPresentation=native2d/)
  await expect(page.getByTestId('pane-facts-left')).toContainText('timeline-main')
  await expect(page.getByTestId('pane-facts-right')).toContainText('timeline-fork')
})

test('narrow comparison panes remain stacked and usable without horizontal overflow', async ({ page }) => {
  await stubSplitApis(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=native2d&rightWorld=world-1&right=timeline-fork&rightPresentation=native2d')
  await expect(page.locator('[data-presentation="native2d"] canvas')).toHaveCount(2, { timeout: 30_000 })
  await expect(page.getByRole('group', { name: '左侧画面表现' })).toBeVisible()
  await expect(page.getByRole('group', { name: '右侧画面表现' })).toBeVisible()
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    left: document.querySelector('[data-testid="comparison-pane-left"]')!.getBoundingClientRect().toJSON(),
    right: document.querySelector('[data-testid="comparison-pane-right"]')!.getBoundingClientRect().toJSON(),
  }))
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width)
  expect(layout.right.y).toBeGreaterThan(layout.left.y)
})
