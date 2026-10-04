import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const voxelDoc = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))

test('repairs the original world and keeps the draft available after a failed save', async ({ page }) => {
  const saves: Array<{ url: string; body: Record<string, unknown> }> = []
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/worlds/world-1/scene/repair-context', route => route.fulfill({ json: {
    world: { id: 'world-1', name: '雾影庄', description: '白雾町的旧宅。', locations: [{ name: '主楼', description: '旧宅' }, { name: '庭院', description: '石灯庭院' }] },
    residents: [{ id: 'person-1', name: 'Ada' }], sceneStatus: 'missing',
  } }))
  await page.route('**/api/worlds/world-1/scene/repair-draft', route => route.fulfill({ json: {
    worldId: 'world-1', document: voxelDoc, explanation: '主楼和庭院已经就位。', warnings: [], callsUsed: 1,
  } }))
  await page.route('**/api/worlds/world-1/scene/voxel-revision', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    saves.push({ url: route.request().url(), body })
    if (saves.length === 1) return route.fulfill({ status: 503, json: { error: '暂时无法保存' } })
    return route.fulfill({ json: { version: 1, document: body.document, contentHash: 'saved', createdAt: '2026-10-01T00:00:00Z' } })
  })
  await page.route('**/api/worlds/world-1/scene', route => route.fulfill({ json: { status: 'ready', version: 1, document: voxelDoc } }))

  await page.goto('/worlds/world-1/scene/repair')
  await expect(page.getByRole('heading', { name: '让「雾影庄」回到可进入的状态' })).toBeVisible()
  await expect(page.getByText('Ada')).toBeVisible()
  await page.getByTestId('repair-scene-prompt').fill('修复原有主楼和庭院之间的石板路。')
  await page.getByTestId('generate-repair-scene').click()
  await expect(page.getByRole('heading', { name: '场景草稿已生成' })).toBeVisible()
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('save-repair-scene').click()
  await expect(page.getByRole('alert')).toContainText('暂时无法保存')
  await expect(page.getByTestId('save-repair-scene')).toHaveText('重试保存')
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible()

  await page.getByTestId('save-repair-scene').click()
  await expect(page).toHaveURL(/\/worlds\/world-1$/)
  expect(saves).toHaveLength(2)
  expect(saves.every(save => save.body.expectedVersion === 0 && save.body.repair === true)).toBe(true)
  expect(saves[0]!.body.requestId).toBe(saves[1]!.body.requestId)
  expect(saves[1]!.body.document).toMatchObject({ format: 'voxel-document' })
})
