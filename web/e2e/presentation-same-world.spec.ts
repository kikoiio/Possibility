import { expect, test, type Page } from '@playwright/test'
import { stubSplitApis } from './split-view-stubs'

test.describe.configure({ mode: 'serial', timeout: 180_000 })

interface ProbeWindow {
  __voxelEngines?: Record<string, { world?: unknown; getOrbitPose(): { theta: number } | null; setOrbitPose(pose: unknown): void }>
  __linkedApplyCalls?: number
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
  await expect(page.getByTestId('comparison-camera-link')).toHaveAttribute('data-camera-left-mounted', 'true')
  await expect(page.getByTestId('comparison-camera-link')).toHaveAttribute('data-camera-right-mounted', 'true')
  await link.check()
  await expect(link).toBeChecked()
  await expect(page.getByTestId('comparison-camera-link')).toHaveAttribute('data-camera-link-enabled', 'true')
  await expect(page.getByTestId('comparison-camera-link')).toHaveAttribute('data-camera-link-active', 'true')
  await expect.poll(() => page.evaluate(() => !!(window as unknown as ProbeWindow).__voxelEngines?.left?.world && !!(window as unknown as ProbeWindow).__voxelEngines?.right?.world)).toBe(true)

  await page.evaluate(() => {
    const target = window as unknown as ProbeWindow
    const engine = target.__voxelEngines!.right!
    const original = engine.setOrbitPose
    engine.setOrbitPose = function (pose: unknown) {
      target.__linkedApplyCalls = (target.__linkedApplyCalls ?? 0) + 1
      original.call(this, pose)
    }
  })

  const rightBefore = (await page.evaluate(() => (window as unknown as ProbeWindow).__voxelEngines?.right?.getOrbitPose()))?.theta
  const pose = { theta: 1.9, phi: 0.7, distance: 90, target: { x: 5, y: 3, z: 8 } }
  await page.evaluate(value => (window as unknown as ProbeWindow).__voxelEngines!.left!.setOrbitPose(value), pose)
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as ProbeWindow).__voxelEngines?.left?.getOrbitPose()))?.theta).toBeCloseTo(1.9, 2)
  await expect.poll(() => page.evaluate(() => (window as unknown as ProbeWindow).__linkedApplyCalls ?? 0), { timeout: 30_000 }).toBeGreaterThan(0)
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as ProbeWindow).__voxelEngines?.right?.getOrbitPose()))?.theta, { timeout: 30_000 }).not.toBeCloseTo(rightBefore!, 2)

  await page.getByRole('group', { name: '右侧画面表现' }).getByRole('button', { name: '2D' }).click()
  await expect(link).toBeDisabled()
  await expect(page).toHaveURL(/rightPresentation=native2d/)
  await expect(page.getByTestId('pane-facts-left')).toContainText('timeline-main')
  await expect(page.getByTestId('pane-facts-right')).toContainText('timeline-fork')

  await page.getByRole('group', { name: '左侧画面表现' }).getByRole('button', { name: '2D' }).click()
  await expect(page.locator('[data-testid="presentation-host-left"] [data-presentation]')).toHaveAttribute('data-presentation', 'native2d')
  await expect(page.locator('[data-testid="presentation-host-right"] [data-presentation]')).toHaveAttribute('data-presentation', 'native2d')
  await page.getByRole('group', { name: '左侧画面表现' }).getByRole('button', { name: '3D' }).click()
  await expect(page.locator('[data-testid="presentation-host-left"] [data-presentation]')).toHaveAttribute('data-presentation', 'voxel3d')
  await expect(page.locator('[data-testid="presentation-host-right"] [data-presentation]')).toHaveAttribute('data-presentation', 'native2d')
  await page.getByRole('group', { name: '右侧画面表现' }).getByRole('button', { name: '3D' }).click()
  await expect(page.locator('[data-testid="presentation-host-right"] [data-presentation]')).toHaveAttribute('data-presentation', 'voxel3d')
  await expect(link).toBeEnabled()
  await expect(link).not.toBeChecked()
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
