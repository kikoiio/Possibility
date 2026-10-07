import { expect, test } from '@playwright/test'
import { stubSplitApis } from './split-view-stubs'

test.describe.configure({ mode: 'serial', timeout: 180_000 })

test('single world switches 3D to native 2D and back without changing its timeline', async ({ page }) => {
  await stubSplitApis(page)
  await page.goto('/worlds/world-1?timeline=timeline-main')
  await expect(page.locator('[data-voxel-instance="main"] [data-testid="voxel-viewport-canvas"]')).toBeVisible({ timeout: 30_000 })

  await page.getByRole('group', { name: '世界画面表现' }).getByRole('button', { name: '2D' }).click()
  await expect(page).toHaveURL(/presentation=native2d/)
  await expect(page.getByTestId('comparison-workspace')).toBeVisible()
  await expect(page.getByTestId('pane-facts-single')).toContainText('timeline-main')
  await expect(page.locator('[data-presentation="native2d"] canvas')).toBeVisible({ timeout: 30_000 })

  await page.getByRole('group', { name: '世界画面表现' }).getByRole('button', { name: '3D' }).click()
  await expect(page).toHaveURL(/presentation=voxel3d/)
  await expect(page.locator('[data-voxel-instance="single"] [data-testid="voxel-viewport-canvas"]')).toBeVisible({ timeout: 30_000 })
  await expect(page).not.toHaveURL(/timeline=timeline-fork/)
})

test('browser preference restores on reload while explicit URL presentation takes precedence', async ({ page }) => {
  await stubSplitApis(page)
  await page.addInitScript(() => localStorage.setItem('possibility:presentation:preferred', JSON.stringify({
    formatVersion: 1,
    preferredPresentation: 'native2d',
    savedAt: Date.now(),
  })))

  await page.goto('/worlds/world-1?timeline=timeline-main')
  await expect(page.locator('[data-presentation="native2d"] canvas')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('pane-facts-single')).toContainText('timeline-main')
  await page.reload()
  await expect(page.locator('[data-presentation="native2d"] canvas')).toBeVisible({ timeout: 30_000 })

  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=voxel3d')
  await expect(page.locator('[data-voxel-instance="single"] [data-testid="voxel-viewport-canvas"]')).toBeVisible({ timeout: 30_000 })
  await page.reload()
  await expect(page.locator('[data-voxel-instance="single"] [data-testid="voxel-viewport-canvas"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('pane-facts-single')).toContainText('timeline-main')
})

test('3D camera restores from its world, timeline and presentation scope after reload', async ({ page }) => {
  await stubSplitApis(page)
  const pose = { theta: 1.25, phi: 0.8, distance: 88, target: { x: 4, y: 3, z: -2 } }
  await page.addInitScript(value => localStorage.setItem(
    'possibility:presentation:camera:["world-1","timeline-main","voxel3d"]',
    JSON.stringify({
      formatVersion: 1,
      worldId: 'world-1',
      timelineId: 'timeline-main',
      presentation: 'voxel3d',
      camera: { kind: 'voxel3d', version: 1, pose: value },
      savedAt: Date.now(),
    }),
  ), pose)
  const restoredTheta = async () => page.evaluate(() => {
    const engine = (window as unknown as {
      __voxelEngines?: Record<string, { world?: unknown; getOrbitPose(): { theta: number } | null }>
    }).__voxelEngines?.single
    return engine?.world ? engine.getOrbitPose()?.theta ?? null : null
  })

  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=voxel3d')
  await expect.poll(restoredTheta).toBeCloseTo(pose.theta, 2)
  await page.reload()
  await expect.poll(restoredTheta).toBeCloseTo(pose.theta, 2)
})
