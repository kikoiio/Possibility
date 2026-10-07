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
  await expect(page.locator('[data-voxel-instance="main"] [data-testid="voxel-viewport-canvas"]')).toBeVisible({ timeout: 30_000 })
  await expect(page).not.toHaveURL(/timeline=timeline-fork/)
})
