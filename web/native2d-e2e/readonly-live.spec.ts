import { test, expect } from '@playwright/test'
import {
  TESTIDS,
  assertReadOnlyApiRequests,
  createApiRequestRecorder,
  createIsolatedSampleContext,
  getObjectClickPoint,
} from './fixtures'

async function dragObject(page: import('@playwright/test').Page, objectId: string, dx: number, dy: number) {
  await page.getByTestId(TESTIDS.viewportHost).scrollIntoViewIfNeeded()
  const start = await getObjectClickPoint(page, objectId)
  if (!start) throw new Error(`missing object ${objectId}`)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 20, start.y + 20, { steps: 2 })
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 })
  await page.mouse.up()
}

test.describe('N2D1 live public read', () => {
  test('reads the configured public demo without writes', async ({ browser }) => {
    const { page, context } = await createIsolatedSampleContext(browser)
    const recorder = createApiRequestRecorder(page)
    try {
      await page.goto('/dev/native-2d')
      await page.getByTestId(TESTIDS.sourceKindPublic).click()
      await page.getByTestId(TESTIDS.sourceApply).click()
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新', { timeout: 15_000 })
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText('公开只读')
      await expect(page.getByTestId(TESTIDS.residentList)).toBeVisible()
      await page.getByTestId(TESTIDS.residentList).locator('button').first().click()
      await expect(page.getByTestId(TESTIDS.residentCard)).toBeVisible()
      await page.getByTestId('native2d-location-大厅').click()
      await expect(page.getByTestId(TESTIDS.locationCard)).toBeVisible()
      await page.getByTestId(TESTIDS.hallEnter).click()
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('主楼 · 大厅')
      await page.getByTestId(TESTIDS.hallExit).click()
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('庄园外景')
      await page.getByTestId(TESTIDS.refresh).click()
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新', { timeout: 15_000 })
      await page.getByTestId(TESTIDS.buildingList).selectOption('gatehouse')
      await page.getByTestId(TESTIDS.moveStart).click()
      await dragObject(page, 'building:gatehouse', 44, 22)
      await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('可应用')
      await page.getByTestId(TESTIDS.moveApply).click()
      await expect(page.getByTestId(TESTIDS.undo)).toBeEnabled()
      await page.getByTestId(TESTIDS.undo).click()
      assertReadOnlyApiRequests(recorder.records())
      const apiRecords = recorder.records()
      expect(apiRecords.every((record) => record.path.startsWith('/api/public/')), JSON.stringify(apiRecords)).toBe(true)
    } finally {
      recorder.stop()
      await context.close()
    }
  })
})
