import { expect, test } from '@playwright/test'
import { createPresentationFixtures, installPresentationFixtures } from './presentation.fixtures'

test('touch browser retries one pane and switches only the tapped pane presentation', async ({ page }) => {
  const fixtures = await installPresentationFixtures(page, createPresentationFixtures(), { right: 'error' })
  await page.goto('/worlds/presentation-world-a?timeline=presentation-world-a-main&presentation=native2d&rightWorld=presentation-world-b&right=presentation-world-b-fork&rightPresentation=native2d')

  await expect(page.getByTestId('pane-facts-left')).toContainText('presentation-world-a-main')
  await expect(page.getByTestId('pane-facts-left')).toContainText('owner')
  await expect(page.getByTestId('comparison-pane-right').getByRole('alert')).toContainText('Fixture unavailable')
  await expect(page.locator('[data-presentation="native2d"] canvas')).toHaveCount(1)
  await expect(page.getByTestId('comparison-pane-right').getByRole('button', { name: '重试此侧' })).toBeVisible()

  fixtures.setOutcome('right', 'ready')
  await page.getByTestId('comparison-pane-right').getByRole('button', { name: '重试此侧' }).tap()
  await expect(page.getByTestId('pane-facts-right')).toContainText('presentation-world-b-fork')
  await expect(page.getByTestId('pane-facts-right')).toContainText('readonly')
  await expect(page.locator('.comparison-pane-facts time')).toHaveCount(2)
  await expect(page.locator('[data-presentation="native2d"] canvas')).toHaveCount(2)

  await page.getByRole('group', { name: '左侧画面表现' }).getByRole('button', { name: '3D' }).tap()
  await expect(page.locator('[data-testid="presentation-host-left"] [data-presentation]')).toHaveAttribute('data-presentation', 'voxel3d')
  await expect(page.locator('[data-testid="presentation-host-right"] [data-presentation]')).toHaveAttribute('data-presentation', 'native2d')
  await page.getByRole('group', { name: '左侧画面表现' }).getByRole('button', { name: '2D' }).tap()
  await expect(page.locator('[data-presentation="native2d"] canvas')).toHaveCount(2)

  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    touchPoints: navigator.maxTouchPoints,
  }))
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width)
  expect(layout.touchPoints).toBeGreaterThan(0)
})
