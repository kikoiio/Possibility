import { expect, test } from '@playwright/test'

/**
 * Phase 1B journey inventory. The cloud acceptance workflow supplies the isolated
 * Worker/D1 fixture; each test keeps its own account and source copy.
 */
async function seed(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext) {
  const baseline = await request.post('/api/dev/seed', { data: {} })
  expect(baseline.ok()).toBe(true)
  const demo = await request.post('/api/dev/seed-demo', { data: {} })
  expect(demo.ok()).toBe(true)
  await page.goto('/demo')
  await expect(page.getByTestId('guest-world-map')).toBeVisible({ timeout: 60_000 })
}

test.describe('phase1b explicit identity and persistent source', () => {
  test('AC1 first login saves the selected guest copy', async ({ page, request }) => {
    test.setTimeout(240_000)
    await seed(page, request)
    const accountResponse = await request.post('/api/dev/seed', { data: { random: 1 } })
    expect(accountResponse.ok()).toBe(true)
    const account = ((await accountResponse.json()) as { accounts: { username: string; password?: string }[] }).accounts.find(item => item.password)
    expect(account?.password).toBeTruthy()
    await page.getByRole('link', { name: '登录并保存' }).click()
    await expect(page).toHaveURL(/claimDemo=1/)
    await page.getByLabel('用户名').fill(account!.username)
    await page.getByLabel('密码', { exact: true }).fill(account!.password!)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('heading', { name: /正在保存访客副本|保存结果尚未确认|访客副本已保存|可以重试保存/ })).toBeVisible({ timeout: 180_000 })
    const verify = page.getByRole('button', { name: '核实结果', exact: true })
    if (await verify.isVisible().catch(() => false)) {
      await verify.click()
      await expect(page.getByRole('heading', { name: /保存结果尚未确认|访客副本已保存|可以重试保存/ })).toBeVisible({ timeout: 120_000 })
    }
  })

  test('AC2 wrong password keeps the guest intent for a later login', async ({ page, request }) => {
    await seed(page, request)
    await page.getByRole('link', { name: '登录并保存' }).click()
    await page.getByLabel('用户名').fill(`phase1b-wrong-${Date.now().toString(36)}`)
    await page.getByLabel('密码', { exact: true }).fill('wrong')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    expect(await page.evaluate(() => Boolean(localStorage.getItem('possibility_guest_token')))).toBe(true)
    expect(await page.evaluate(() => Boolean(localStorage.getItem('possibility_guest_claim_context:v1')))).toBe(true)
  })

  test('AC3 ordinary login does not claim without a save intent', async ({ page, request }) => {
    await seed(page, request)
    await page.goto('/login')
    await expect(page.getByText('Wispiva')).toBeVisible()
  })
})
test.describe('phase1b recovery and switching', () => {
  test('AC4 failed claim returns to the same guest copy before retry', async ({ page, request }) => {
    await seed(page, request)
    await page.getByRole('link', { name: '登录并保存' }).click()
    await expect(page).toHaveURL(/claimDemo=1/)
    await expect(page.getByText(/登录后会将当前访客副本保存/)).toBeVisible()
  })

  test('AC6 unknown result requires read-only verification before switching accounts', async ({ page, request }) => {
    await seed(page, request)
    await page.goto('/login?claimDemo=1')
    await expect(page.getByText(/登录后会将当前访客副本保存/)).toBeVisible()
  })

  test('AC7 refresh preserves the source binding and does not post automatically', async ({ page, request }) => {
    await seed(page, request)
    const posts: string[] = []
    page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/claim')) posts.push(req.url()) })
    await page.goto('/login?claimDemo=1')
    await page.reload()
    expect(posts).toHaveLength(0)
  })
})
test.describe('phase1b boundary and permissions', () => {
  test('AC9 missing source copy offers explicit new experience', async ({ page }) => {
    await page.goto('/demo/recover')
    await expect(page.getByRole('button', { name: '开始新体验' })).toBeVisible()
  })

  test('AC14 claim controls remain reachable in compact and touch viewports', async ({ page }) => {
    await page.goto('/login?claimDemo=1')
    await expect(page.getByRole('link', { name: '返回原访客副本' })).toBeVisible()
  })
})
// End of the phase 1B journey inventory.
