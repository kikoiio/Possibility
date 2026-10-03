import { expect, test, type Page } from '@playwright/test'

const worlds = [{
  id: 'world-mobile', name: '河畔街', description: '移动端世界列表夹具。', status: 'running', pauseReason: null,
  isDemo: false, hasScene: true, personIds: ['person-mobile'], personCount: 1, callsToday: 0,
  simNow: '2026-10-01T10:00:00.000Z', timeZone: 'UTC', createdAt: '2026-09-20T10:00:00.000Z',
}]

test('S5A mobile list and form stay readable without horizontal overflow', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 's5a-mobile-token'))
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds } }))
  await page.route('**/api/persons', route => route.fulfill({ json: { persons: [{ id: 'person-mobile', name: '林晚', createdAt: '2026-09-01T10:00:00.000Z' }] } }))

  await page.goto('/worlds')
  await expect(page.getByText('人物：林晚')).toBeVisible()
  await expect(page.getByText('创建于')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

  await page.goto('/people/new')
  await page.getByRole('button', { name: '不调用生成服务，手动填写人物卡' }).click()
  await page.getByRole('button', { name: '确认创建人物' }).click()
  await expect(page.locator('#person-create-name')).toBeFocused()
  await expect(page.locator('#person-create-name')).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})
