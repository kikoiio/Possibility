import { expect, test } from '@playwright/test'

test('creates and reloads a scene through the real local API and D1 backend', async ({ page, request }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
  const apiRoot = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 18787}`
  const authResponse = await request.post(`${apiRoot}/api/auth/register`, {
    data: { username: `s02-${Date.now()}`, password: 'scene-e2e-password' },
  })
  expect(authResponse.ok()).toBe(true)
  const { token } = await authResponse.json() as { token: string }
  const personResponse = await request.post(`${apiRoot}/api/persons`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Ada', model: { identity: ['喜欢河边散步'], behavior: ['耐心观察'], speech: ['语气温和'], boundaries: ['不替他人做决定'], unknowns: ['今天会遇到谁'] }, worldName: 'Ada 的日常', worldDescription: '一方临河生活的天地', initialState: { location: '住所', activity: '整理书架', mood: '平静', goal: '认识邻居' } },
  })
  expect(personResponse.ok()).toBe(true)
  await page.addInitScript(value => localStorage.setItem('possibility_token', value), token)
  await page.goto('/worlds/new')
  await expect(page.getByRole('button', { name: 'Ada' })).toBeVisible()
  await page.getByTestId('scene-prompt').fill('临河的一方日常天地，有住宅、咖啡馆、书屋、商店和车站。')
  await page.getByRole('button', { name: 'Ada' }).click()
  await page.getByTestId('generate-scene').click()
  await expect(page.getByText('继续调整这方天地')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('world-canvas').locator('canvas')).toBeVisible()
  await page.getByTestId('start-life').click()
  // 创建后原地进入生活：URL 切到新世界，canvas 节点保持
  await expect(page).toHaveURL(/\/worlds\/[0-9a-f-]+$/)
  const worldId = new URL(page.url()).pathname.split('/').at(-1)!
  await expect(page.getByTestId('create-live-banner')).toBeVisible()
  await expect(page.getByTestId('world-canvas').locator('canvas')).toBeVisible()
  const sceneResponse = await request.get(`${apiRoot}/api/worlds/${worldId}/scene`, { headers: { Authorization: `Bearer ${token}` } })
  expect(sceneResponse.ok()).toBe(true)
  const scene = await sceneResponse.json() as { status: string; version: number; document: { objects: unknown[] } }
  expect(scene).toMatchObject({ status: 'ready', version: 1 })
  expect(scene.document.objects).toHaveLength(6)
  await page.reload()
  await expect(page.getByTestId('world-canvas').locator('canvas')).toBeVisible()
  await expect.poll(async () => (await request.get(`${apiRoot}/api/worlds/${worldId}/scene`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200)
})
