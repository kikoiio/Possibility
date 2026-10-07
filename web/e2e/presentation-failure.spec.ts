import { expect, test } from '@playwright/test'
import { createPresentationFixtures, installPresentationFixtures } from './presentation.fixtures'

test.describe.configure({ mode: 'serial' })

function comparisonUrl() {
  return '/worlds/presentation-world-a?timeline=presentation-world-a-main&presentation=native2d&rightWorld=presentation-world-b&right=presentation-world-b-fork&rightPresentation=native2d'
}

test('a 403 pane stays non-retryable while its authorized sibling remains usable', async ({ page }) => {
  await installPresentationFixtures(page, createPresentationFixtures(), { right: 'denied' })
  await page.goto(comparisonUrl())

  await expect(page.getByTestId('pane-facts-left')).toContainText('presentation-world-a-main')
  await expect(page.locator('[data-testid="comparison-pane-left"] [data-presentation="native2d"] canvas')).toBeVisible()
  await expect(page.getByTestId('comparison-pane-right').getByRole('alert')).toContainText('Fixture access denied')
  await expect(page.getByTestId('comparison-pane-right').getByRole('button', { name: '重试此侧' })).toHaveCount(0)
})

test('a timed-out pane can recover without reloading its sibling', async ({ page }) => {
  const fixture = await installPresentationFixtures(page, createPresentationFixtures(), { right: 'timeout' })
  await page.goto(comparisonUrl())

  await expect(page.getByTestId('pane-facts-left')).toContainText('presentation-world-a-main')
  await expect(page.getByTestId('comparison-pane-right').getByRole('alert')).toBeVisible()
  await expect(page.getByTestId('comparison-pane-right').getByRole('button', { name: '重试此侧' })).toBeVisible()
  const leftReadsBeforeRetry = fixture.reads.filter(read => read.side === 'left' && read.path.endsWith('/map/bootstrap')).length

  fixture.setOutcome('right', 'ready')
  await page.getByTestId('comparison-pane-right').getByRole('button', { name: '重试此侧' }).click()
  await expect(page.getByTestId('pane-facts-right')).toContainText('presentation-world-b-fork')
  await expect.poll(() => fixture.reads.filter(read => read.side === 'left' && read.path.endsWith('/map/bootstrap')).length).toBe(leftReadsBeforeRetry)
})

test('a left-side 403 does not authorize its URL target or block the ready right pane', async ({ page }) => {
  await installPresentationFixtures(page, createPresentationFixtures(), { left: 'denied' })
  await page.goto(comparisonUrl())

  await expect(page.getByTestId('comparison-pane-left').getByRole('alert')).toContainText('Fixture access denied')
  await expect(page.getByTestId('comparison-pane-left').getByRole('button', { name: '重试此侧' })).toHaveCount(0)
  await expect(page.getByTestId('pane-facts-right')).toContainText('presentation-world-b-fork')
  await expect(page.locator('[data-testid="comparison-pane-right"] [data-presentation="native2d"] canvas')).toBeVisible()
})

test('a timed-out left pane can retry without reloading the ready right pane', async ({ page }) => {
  const fixture = await installPresentationFixtures(page, createPresentationFixtures(), { left: 'timeout' })
  await page.goto(comparisonUrl())

  await expect(page.getByTestId('pane-facts-right')).toContainText('presentation-world-b-fork')
  await expect(page.getByTestId('comparison-pane-left').getByRole('button', { name: '重试此侧' })).toBeVisible()
  const rightReadsBeforeRetry = fixture.reads.filter(read => read.side === 'right' && read.path.endsWith('/map/bootstrap')).length

  fixture.setOutcome('left', 'ready')
  await page.getByTestId('comparison-pane-left').getByRole('button', { name: '重试此侧' }).click()
  await expect(page.getByTestId('pane-facts-left')).toContainText('presentation-world-a-main')
  await expect.poll(() => fixture.reads.filter(read => read.side === 'right' && read.path.endsWith('/map/bootstrap')).length).toBe(rightReadsBeforeRetry)
})
