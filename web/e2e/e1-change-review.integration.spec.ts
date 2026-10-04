import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

const apiPort = process.env.PLAYWRIGHT_API_PORT ?? '18787'
const apiOrigin = `http://127.0.0.1:${apiPort}`
const sceneFixture = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))
const personModel = {
  identity: [{ text: '经营街角书店', provenance: 'known' }],
  behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [],
}

test('E1 uses a real isolated account and D1 world without calling a model', async ({ page }) => {
  test.setTimeout(90_000)
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const username = `e1-${suffix}`
  const password = 'e1-integration-test-password'
  const register = await page.request.post(`${apiOrigin}/api/auth/register`, { data: { username, password } })
  expect(register.status()).toBe(200)
  const { token } = await register.json() as { token: string }
  const headers = { Authorization: `Bearer ${token}` }

  const personResponse = await page.request.post(`${apiOrigin}/api/persons`, { headers, data: { name: 'Ada', model: personModel } })
  expect(personResponse.status()).toBe(200)
  const { id: personId } = await personResponse.json() as { id: string }
  const worldResponse = await page.request.post(`${apiOrigin}/api/worlds`, { headers, data: {
    name: `E1 integration ${suffix}`,
    description: 'Isolated world for the E1 return review journey.',
    locations: ['主楼', '温室', '庭院', 'Cafe', 'Library'].map(name => ({ name, description: `${name} for E1 verification` })),
    personIds: [personId],
  } })
  const worldPayload = await worldResponse.json() as { id?: string; timelineId?: string; error?: string; issues?: unknown[] }
  expect(worldResponse.status(), JSON.stringify(worldPayload)).toBe(200)
  const { id: worldId, timelineId } = worldPayload as { id: string; timelineId: string }

  const writeEnvironmentChange = async (id: string, expectedVersion: number, value: string) => {
    const response = await page.request.post(`${apiOrigin}/api/worlds/${worldId}/actions`, { headers, data: {
      id, timelineId, expectedVersion, action: { type: 'environment', location: 'Cafe', condition: 'weather', value },
    } })
    expect(response.status()).toBe(200)
  }
  await writeEnvironmentChange(`e1-${suffix}-first`, 0, '薄雾')

  await page.addInitScript((authToken: string) => localStorage.setItem('possibility_token', authToken), token)
  // The voxel document is only a rendering fixture; auth, world state, return, evidence and seen APIs stay real.
  await page.route(`**/api/worlds/${worldId}/map/bootstrap**`, async route => {
    const response = await route.fetch()
    const payload = await response.json() as Record<string, unknown>
    return route.fulfill({ response, json: { ...payload, scene: { status: 'ready', document: sceneFixture } } })
  })
  await page.route(`**/api/worlds/${worldId}/scene`, route => route.fulfill({ json: {
    status: 'ready', document: sceneFixture, version: 1, contentHash: `e1-${suffix}`, createdAt: new Date().toISOString(),
  } }))
  await page.goto(`/worlds/${worldId}?timeline=${timelineId}`, { timeout: 60_000 })
  const returnButton = page.getByRole('button', { name: '你不在时' })
  await expect(returnButton).toBeVisible({ timeout: 60_000 })
  await returnButton.click()
  await expect(page.getByText(/新增 1 项记录/)).toBeVisible()
  await page.getByRole('button', { name: '查看来源与当时状态' }).click()
  await expect(page.getByTestId('event-evidence-detail')).toContainText('记录事实')
  await expect(page.getByTestId('event-evidence-detail')).toContainText('薄雾')

  // Emulate a world write after the page watermarks were read but before the user marks it seen.
  await writeEnvironmentChange(`e1-${suffix}-second`, 1, '小雨')
  await page.getByRole('button', { name: '看完了，记下这个时间点' }).click()
  await returnButton.click()
  await expect(page.getByText(/新增 1 项记录/)).toBeVisible()
  await expect(page.getByText('记录值：小雨')).toBeVisible()
  await expect(page.getByText('记录值：薄雾')).toHaveCount(0)
  await page.getByRole('button', { name: '查看来源与当时状态' }).click()
  await page.getByTestId('fork-from-event').click()
  const forkDialog = page.getByRole('dialog', { name: '创建平行宇宙' })
  await expect(forkDialog).toBeVisible()
  await expect(forkDialog.locator('#fork-what-if')).not.toHaveValue('')
  await expect(forkDialog.getByTestId('fork-moment-input')).not.toHaveValue('')
})
