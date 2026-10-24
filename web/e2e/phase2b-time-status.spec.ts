import { expect, test } from '@playwright/test'
import { stubSplitApis } from './split-view-stubs'

test('establishes a first visit and closes it on a visible route change', async ({ page }) => {
  await stubSplitApis(page)
  const enter = page.waitForRequest(request => request.url().includes('/api/worlds/world-1/visits/enter'))
  await page.goto('/worlds/world-1', { waitUntil: 'domcontentloaded' })
  await enter
  await expect(page.getByText('首次到场', { exact: false })).toBeVisible()
  await expect(page.getByTestId('world-status')).toContainText('正在运行')

  const leave = page.waitForRequest(request => request.url().includes('/api/worlds/world-1/visits/leave'))
  await page.getByLabel('切换世界').selectOption('__new__')
  await leave
  await expect(page).toHaveURL(/\/worlds\/new$/)
})
