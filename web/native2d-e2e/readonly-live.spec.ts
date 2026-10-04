import { test, expect } from '@playwright/test'
import {
  TESTIDS,
  assertReadOnlyApiRequests,
  createApiRequestRecorder,
  createIsolatedSampleContext,
} from './fixtures'

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
      await page.getByTestId(TESTIDS.refresh).click()
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新', { timeout: 15_000 })
      assertReadOnlyApiRequests(recorder.records())
      const apiRecords = recorder.records()
      expect(apiRecords.every((record) => record.path.startsWith('/api/public/')), JSON.stringify(apiRecords)).toBe(true)
    } finally {
      recorder.stop()
      await context.close()
    }
  })
})
