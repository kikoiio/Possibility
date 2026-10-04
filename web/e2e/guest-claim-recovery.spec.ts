import { expect, test } from '@playwright/test'

/** Failed guest claim recovery with a real pending copy and a lost-success replay. */
test('failed claim returns to the same guest copy and can be saved to a selected account', async ({ page, request }) => {
  test.setTimeout(240_000)

  const seed = await request.post('/api/dev/seed', { data: {} })
  expect(seed.status(), await seed.text()).toBe(200)
  const seedDemo = await request.post('/api/dev/seed-demo', { data: {} })
  expect(seedDemo.status(), await seedDemo.text()).toBe(200)

  let guestWorldId: string | undefined
  let guestTimelineId: string | undefined
  let recoveredWorldId: string | undefined
  let monitorRecovery = false
  const guestBootstrapHeaders: string[] = []
  page.on('response', async response => {
    if (!monitorRecovery || !response.url().endsWith('/api/demo/session') || response.request().method() !== 'GET' || !response.ok()) return
    const body = await response.json().catch(() => null) as { worldId?: string } | null
    if (body?.worldId) recoveredWorldId = body.worldId
  })
  await page.route('**/api/worlds/*/map/bootstrap**', async route => {
    guestBootstrapHeaders.push(JSON.stringify(route.request().headers()))
    await route.continue()
  })

  let claimAttempts = 0
  let savedWorldId: string | undefined
  await page.route('**/api/demo/session/claim', async route => {
    claimAttempts += 1
    if (claimAttempts <= 2) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '测试注入的临时保存失败' }) })
      return
    }
    if (claimAttempts === 3) {
      // The server commits the claim, but the browser loses its response.
      const committed = await route.fetch()
      expect(committed.status()).toBe(200)
      savedWorldId = (await committed.json() as { worldId: string }).worldId
      await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: '模拟保存成功但响应丢失' }) })
      return
    }
    if (claimAttempts === 4) {
      const replay = await route.fetch()
      expect(replay.status()).toBe(200)
      expect((await replay.json() as { worldId: string }).worldId).toBe(savedWorldId)
      await route.fulfill({ status: replay.status(), contentType: 'application/json', body: await replay.body() })
      return
    }
    await route.continue()
  })

  await page.goto('/demo')
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 60_000 })

  // Add a branch so the recovered copy includes meaningful progress.
  await page.getByRole('button', { name: '可能' }).click()
  await page.getByRole('button', { name: '创建并对照' }).click()
  await page.getByTestId('guest-fork-confirm').click()
  await expect(page.getByTestId('guest-fork-summary')).toBeVisible({ timeout: 30_000 })
  const sourceSession = await page.evaluate(async () => {
    const guestToken = localStorage.getItem('possibility_guest_token')
    const response = await fetch('/api/demo/session', { headers: { 'X-Possibility-Guest': guestToken ?? '' } })
    return (await response.json() as { worldId: string; timelineId: string })
  })
  guestWorldId = sourceSession.worldId
  guestTimelineId = sourceSession.timelineId

  await page.getByRole('link', { name: '登录并保存' }).click()
  await expect(page).toHaveURL(/\/login\?claimDemo=1/)
  await page.getByRole('button', { name: '没有账号？注册一个' }).click()
  const firstUsername = `claim-a-${Date.now().toString(36)}`
  await page.getByLabel('用户名').fill(firstUsername)
  await page.getByLabel('密码', { exact: true }).fill('claim-pass-6')
  await page.getByRole('button', { name: '注册', exact: true }).click()

  await expect(page.getByText(new RegExp(`当前保存目标账号：${firstUsername}`))).toBeVisible()
  await expect(page.getByRole('button', { name: '重试保存' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('link', { name: '返回原访客副本' })).toBeVisible()
  monitorRecovery = true
  await page.getByRole('link', { name: '返回原访客副本' }).click()
  await expect(page).toHaveURL(/\/demo\/recover$/)
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => recoveredWorldId).toBe(guestWorldId)

  // A reload must recover the same sandbox, retain its branch, and send guest credentials.
  recoveredWorldId = undefined
  await page.reload()
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('status').filter({ hasText: '访客副本待保存' })).toBeVisible()
  await expect.poll(() => recoveredWorldId).toBe(guestWorldId)
  await expect(page.getByTestId('timeline-switcher').locator('option')).toHaveCount(2)
  await expect.poll(() => guestBootstrapHeaders.length).toBeGreaterThan(0)
  expect(guestBootstrapHeaders.every(headers => headers.includes('x-possibility-guest') && !headers.includes('"authorization"'))).toBe(true)

  // New work performed after returning must also make it into the later claim.
  const newBranch = await page.evaluate(async ({ worldId, timelineId, requestId }) => {
    const guestToken = localStorage.getItem('possibility_guest_token')
    const response = await fetch(`/api/demo/worlds/${encodeURIComponent(worldId)}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Possibility-Guest': guestToken ?? '' },
      body: JSON.stringify({
        timelineId, requestId, name: '返回后创建的分支',
        whatIf: '访客返回后再次改变选择', changedVariable: '返回后的新选择',
      }),
    })
    return { status: response.status, body: await response.json() }
  }, { worldId: guestWorldId!, timelineId: guestTimelineId!, requestId: crypto.randomUUID() })
  expect(newBranch.status).toBe(200)
  await page.reload()
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('timeline-switcher').locator('option')).toHaveCount(3)

  // Re-enter claim, then explicitly switch from account A to account B.
  await page.getByRole('link', { name: '重试保存' }).click()
  await expect(page).toHaveURL(/\/login\?claimDemo=1/)
  await page.getByLabel('用户名').fill(firstUsername)
  await page.getByLabel('密码', { exact: true }).fill('claim-pass-6')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '重试保存' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '切换账号' }).click()
  await page.getByRole('button', { name: '没有账号？注册一个' }).click()
  const targetUsername = `claim-b-${Date.now().toString(36)}`
  await page.getByLabel('用户名').fill(targetUsername)
  await page.getByLabel('密码', { exact: true }).fill('claim-pass-6')
  await page.getByRole('button', { name: '注册', exact: true }).click()

  await expect(page.getByText(new RegExp(`当前保存目标账号：${targetUsername}`))).toBeVisible()
  await expect(page.getByText(new RegExp(`保存目标已切换为 ${targetUsername}`))).toBeVisible()
  await expect(page.getByRole('button', { name: '重试保存' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '重试保存' }).click()
  await expect(page.getByRole('button', { name: '重试保存' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '重试保存' }).click()
  await expect(page).toHaveURL(/\/worlds\//, { timeout: 60_000 })
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('timeline-switcher').locator('option')).toHaveCount(3)
  expect(claimAttempts).toBe(4)
})
