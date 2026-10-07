import { expect, test } from '@playwright/test'
import { createPresentationFixtures, installPresentationFixtures, PRESENTATION_SLOW_RESPONSE_DELAY_MS } from './presentation.fixtures'

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

test('a delayed pane stays loading while its sibling is ready, then retries only that pane', async ({ page }) => {
  const fixture = await installPresentationFixtures(page, createPresentationFixtures(), { right: 'slow' })
  await page.goto(comparisonUrl())

  await expect(page.getByTestId('pane-facts-left')).toContainText('presentation-world-a-main')
  await expect(page.getByTestId('comparison-pane-right').getByRole('status')).toContainText(
    '正在读取 presentation-world-b', { timeout: PRESENTATION_SLOW_RESPONSE_DELAY_MS / 2 },
  )
  await expect(page.getByTestId('comparison-pane-right').getByRole('alert')).toContainText('Fixture response delayed before temporary outage')

  const leftBootstrapReadsBeforeRetry = fixture.reads.filter(read => read.side === 'left' && read.path.endsWith('/map/bootstrap')).length
  fixture.setOutcome('right', 'ready')
  await page.getByTestId('comparison-pane-right').getByRole('button', { name: '重试此侧' }).click()
  await expect(page.getByTestId('pane-facts-right')).toContainText('presentation-world-b-fork')
  await expect.poll(() => fixture.reads.filter(read => read.side === 'left' && read.path.endsWith('/map/bootstrap')).length).toBe(leftBootstrapReadsBeforeRetry)
})

test('an internet-disconnected pane can recover without reloading its ready sibling', async ({ page }) => {
  const fixture = await installPresentationFixtures(page, createPresentationFixtures(), { left: 'offline' })
  await page.goto(comparisonUrl())

  await expect(page.getByTestId('comparison-pane-left').getByRole('alert')).toBeVisible()
  await expect(page.getByTestId('pane-facts-right')).toContainText('presentation-world-b-fork')
  const rightBootstrapReadsBeforeRetry = fixture.reads.filter(read => read.side === 'right' && read.path.endsWith('/map/bootstrap')).length

  fixture.setOutcome('left', 'ready')
  await page.getByTestId('comparison-pane-left').getByRole('button', { name: '重试此侧' }).click()
  await expect(page.getByTestId('pane-facts-left')).toContainText('presentation-world-a-main')
  await expect.poll(() => fixture.reads.filter(read => read.side === 'right' && read.path.endsWith('/map/bootstrap')).length).toBe(rightBootstrapReadsBeforeRetry)
})

test('a failed 2D adapter can retry while preserving the pane world and timeline context', async ({ page }) => {
  await installPresentationFixtures(page)
  await page.addInitScript(() => {
    const canvasPrototype = HTMLCanvasElement.prototype as unknown as { getContext: (...args: any[]) => any }
    const getContext = canvasPrototype.getContext
    Object.defineProperty(window, '__failPresentationWebgl', { value: true, writable: true })
    canvasPrototype.getContext = function (kind: string, ...args: any[]) {
      if ((window as Window & { __failPresentationWebgl?: boolean }).__failPresentationWebgl
        && (kind === 'webgl' || kind === 'webgl2')) throw new Error('Fixture WebGL adapter failure')
      return getContext.call(this, kind, ...args)
    }
  })
  await page.goto('/worlds/presentation-world-a?timeline=presentation-world-a-main&presentation=native2d')

  const host = page.getByTestId('presentation-host-single')
  await expect(page.getByTestId('pane-facts-single')).toContainText('presentation-world-a-main')
  await expect(host.getByRole('alert')).toContainText('Fixture WebGL adapter failure', { timeout: 30_000 })
  await expect(page).toHaveURL(/worlds\/presentation-world-a\?timeline=presentation-world-a-main&presentation=native2d/)

  await page.evaluate(() => { (window as Window & { __failPresentationWebgl?: boolean }).__failPresentationWebgl = false })
  await host.getByRole('button', { name: '重试视口' }).click()
  await expect(host.locator('[data-presentation="native2d"] canvas')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('pane-facts-single')).toContainText('presentation-world-a-main')
})

test('rapid replacement cancels a stale side load and closing it leaves the sibling mounted', async ({ page }) => {
  const fixture = await installPresentationFixtures(page, createPresentationFixtures({ sameWorld: true }), { right: 'slow' })
  const rightCamera = { pan: { x: -19, y: 41 }, zoom: 1.2 }
  await page.addInitScript(camera => localStorage.setItem(
    'possibility:presentation:camera:["presentation-world-a","presentation-world-a-fork","native2d"]',
    JSON.stringify({ formatVersion: 1, worldId: 'presentation-world-a', timelineId: 'presentation-world-a-fork', presentation: 'native2d', camera: { kind: 'native2d', version: 1, camera }, savedAt: Date.now() }),
  ), rightCamera)
  await page.goto('/worlds/presentation-world-a?timeline=presentation-world-a-main&presentation=native2d&rightWorld=presentation-world-a&right=presentation-world-a-fork&rightPresentation=native2d')

  await expect(page.getByTestId('pane-facts-left')).toContainText('presentation-world-a-main')
  await expect(page.getByTestId('comparison-pane-right').getByRole('status')).toContainText('正在读取')
  const leftBootstrapReads = fixture.reads.filter(read => read.side === 'left' && read.path.endsWith('/map/bootstrap')).length
  await page.getByLabel('right时间线').selectOption('presentation-world-a-main')
  await expect(page.getByTestId('pane-facts-right')).toContainText('presentation-world-a-main')
  await expect(page.locator('[data-testid="comparison-pane-left"] [data-presentation="native2d"] canvas')).toBeVisible()
  await expect.poll(() => fixture.reads.filter(read => read.side === 'left' && read.path.endsWith('/map/bootstrap')).length).toBe(leftBootstrapReads + 1)
  const leftBootstrapReadsAfterReplacement = fixture.reads.filter(read => read.side === 'left' && read.path.endsWith('/map/bootstrap')).length
  fixture.setOutcome('right', 'ready')
  await page.getByLabel('right时间线').selectOption('presentation-world-a-fork')
  await expect(page.getByTestId('pane-facts-right')).toContainText('presentation-world-a-fork')
  await expect(page.getByTestId('presentation-host-right')).toHaveAttribute('data-camera-state', JSON.stringify({ kind: 'native2d', version: 1, camera: rightCamera }))
  await expect.poll(() => fixture.reads.filter(read => read.side === 'left' && read.path.endsWith('/map/bootstrap')).length).toBe(leftBootstrapReadsAfterReplacement)

  await page.getByTestId('comparison-pane-right').getByRole('button', { name: '关闭右侧' }).click()
  await expect(page.getByTestId('comparison-pane-right')).toHaveCount(0)
  await expect(page.getByTestId('pane-facts-left')).toContainText('presentation-world-a-main')
  await expect(page.locator('[data-testid="comparison-pane-left"] [data-presentation="native2d"] canvas')).toBeVisible()

  await page.getByRole('button', { name: '添加比较视口' }).click()
  await expect(page.getByTestId('comparison-pane-right')).toBeVisible()
  await page.getByLabel('right时间线').selectOption('presentation-world-a-fork')
  await expect(page.getByTestId('pane-facts-right')).toContainText('presentation-world-a-fork')
  await expect(page.getByTestId('presentation-host-right')).toHaveAttribute('data-camera-state', JSON.stringify({ kind: 'native2d', version: 1, camera: rightCamera }))
  await expect(page.getByTestId('pane-facts-left')).toContainText('presentation-world-a-main')
})
