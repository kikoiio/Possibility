import { test, expect, type Browser, type Page } from '@playwright/test'
import {
  TESTIDS,
  assertReadOnlyApiRequests,
  createApiRequestRecorder,
  createIsolatedSampleContext,
  getObjectScreenRect,
  installPublicApiStub,
  publicDayResponse,
  publicRefreshResponse,
  publicWorldPath,
  readDiagnostics,
} from './fixtures'

async function openSample(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const { page, context } = await createIsolatedSampleContext(browser)
  await page.goto('/dev/native-2d')
  await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
  await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(0)
  return { page, close: () => context.close() }
}

async function dragViewport(page: Page, dx: number, dy: number): Promise<void> {
  const box = await page.getByTestId(TESTIDS.viewportHost).boundingBox()
  if (!box) throw new Error('viewport host is not visible')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 4 })
  await page.mouse.up()
}

test.describe('N2D1 desktop sample', () => {
  test('loads fixed facts, selects residents, follows, and enters the hall', async ({ browser }) => {
    const { page, close } = await openSample(browser)
    const recorder = createApiRequestRecorder(page)
    try {
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText('固定数据')
      await expect(page.getByTestId(TESTIDS.worldTimeZone)).toHaveText('Asia/Tokyo')
      await expect(page.getByTestId(TESTIDS.residentList).locator('button').first()).toBeVisible()
      await page.screenshot({ path: '/tmp/native2d-playwright-results/native2d-desktop-review.png', fullPage: true })

      await page.getByTestId('native2d-resident-person-mugino-toru').click()
      await expect(page.getByTestId(TESTIDS.residentCardName)).toHaveText('雾野 透')
      await expect(page.getByTestId(TESTIDS.residentCardActivity)).toContainText('侦探笔记')
      await page.getByTestId(TESTIDS.followToggle).click()
      await expect(page.getByTestId(TESTIDS.followStatus)).toContainText('雾野 透')

      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('主楼 · 大厅')
      await dragViewport(page, 80, 0)
      await expect(page.getByTestId(TESTIDS.followStatus)).toHaveCount(0)

      await page.getByTestId(TESTIDS.hallExit).click()
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('庄园外景')
      await page.getByTestId(TESTIDS.hallEnter).click()
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('主楼 · 大厅')
      await page.getByTestId(TESTIDS.hallExit).click()
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('庄园外景')

      await expect.poll(async () => (await readDiagnostics(page))?.objectBounds['building:main-house'] ?? null).not.toBeNull()
      assertReadOnlyApiRequests(recorder.records())
    } finally {
      recorder.stop()
      await close()
    }
  })

  test('reads public snapshots, retains stale facts, and retries', async ({ browser }) => {
    const { page, context } = await createIsolatedSampleContext(browser)
    const recorder = createApiRequestRecorder(page)
    await installPublicApiStub(page, {
      worlds: [
        { kind: 'json', body: publicDayResponse() },
        { kind: 'json', body: publicRefreshResponse() },
        { kind: 'error', status: 503, message: 'temporary outage' },
        { kind: 'json', body: publicRefreshResponse() },
      ],
    })
    try {
      await page.goto('/dev/native-2d')
      await page.getByTestId(TESTIDS.sourceKindPublic).click()
      await page.getByTestId(TESTIDS.sourceApply).click()
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText('公开只读')
      await expect(page.getByTestId(TESTIDS.stateVersion)).toHaveText('版本 7')

      await page.getByTestId(TESTIDS.refresh).click()
      await expect(page.getByTestId(TESTIDS.stateVersion)).toHaveText('版本 9')
      await page.getByTestId(TESTIDS.refresh).click()
      await expect(page.getByTestId(TESTIDS.staleBadge)).toBeVisible()
      await expect(page.getByTestId(TESTIDS.stateVersion)).toHaveText('版本 9')
      await page.getByTestId(TESTIDS.readRetry).click()
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
      assertReadOnlyApiRequests(recorder.records())
      expect(recorder.records().filter((record) => record.path === publicWorldPath('demo-world-mist-manor'))).not.toHaveLength(0)
    } finally {
      recorder.stop()
      await context.close()
    }
  })

  test('supports overview and canvas selection diagnostics', async ({ browser }) => {
    const { page, close } = await openSample(browser)
    try {
      const before = await readDiagnostics(page)
      expect(before?.renderer).toBeTruthy()
      const bounds = await getObjectScreenRect(page, 'building:main-house')
      expect(bounds?.width).toBeGreaterThan(0)
      await page.getByTestId(TESTIDS.overview).click()
      await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(before?.drawCount ?? 0)
      await page.getByTestId('native2d-location-大厅').click()
      await expect(page.getByTestId(TESTIDS.locationCard)).toBeVisible()
    } finally {
      await close()
    }
  })
})
