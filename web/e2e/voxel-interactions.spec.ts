import { expect, test, type Page } from '@playwright/test'

async function waitReady(page: Page) {
  await page.goto('/dev/voxel')
  await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 15000 })
}

async function toScreen(page: Page, at: { x: number; y: number; z: number }) {
  return page.evaluate((cell) => (window.__voxelEngine as never as {
    worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null
  }).worldToScreen(cell)!, at)
}

interface SyncProbe { syncResidents(states: unknown[]): void }

/** 移除再重生，把居民钉在已知格（已存在居民的 at 不生效）；harness 每 9s 重同步，重试包在 toPass 里 */
async function freezeResidents(page: Page, spot = { x: 12, y: 1, z: 42 }) {
  await page.evaluate((at) => {
    const engine = window.__voxelEngine as never as SyncProbe
    engine.syncResidents([])
    engine.syncResidents([
      { personId: 'person-sayo', name: '小夜', at, destination: null, activity: '站桩' },
    ])
  }, spot)
}

async function lastInteraction(page: Page): Promise<{ kind: string; detail: string } | undefined> {
  return page.evaluate(() => window.__voxelInteractions?.at(-1))
}

test.describe('voxel interactions (AC16/AC9)', () => {
  test('click resident → activity panel (AC16)', async ({ page }) => {
    await waitReady(page)
    await expect(async () => {
      await freezeResidents(page)
      const at = await toScreen(page, { x: 12, y: 2, z: 42 })
      await page.mouse.click(at.x, at.y)
      await expect(page.getByTestId('voxel-activity-panel')).toBeVisible({ timeout: 800 })
      expect((await lastInteraction(page))?.kind).toBe('person')
    }).toPass({ timeout: 12000 })
    await expect(page.getByTestId('voxel-activity-detail')).toContainText('小夜')
  })

  test('click space entry → navigation event (AC9 外景→主楼)', async ({ page }) => {
    await waitReady(page)
    await expect(async () => {
      // 居民移出拾取范围，专注入口点击
      await page.evaluate(() => (window.__voxelEngine as never as SyncProbe).syncResidents([]))
      const at = await toScreen(page, { x: 23, y: 0, z: 24 })
      await page.mouse.click(at.x, at.y)
      await expect.poll(() => lastInteraction(page), { timeout: 800 }).toEqual({ kind: 'enter-space', detail: 'main-hall' })
    }).toPass({ timeout: 12000 })
    await expect(page.getByTestId('voxel-activity-panel')).toBeVisible()
  })

  test('click location-bound object → location detail (AC16)', async ({ page }) => {
    await waitReady(page)
    await page.evaluate(() => (window.__voxelEngine as never as SyncProbe).syncResidents([]))
    await expect(async () => {
      // 主楼屋顶（绑定 主楼，锁定物体也应可查看）
      const at = await toScreen(page, { x: 23, y: 5, z: 19 })
      await page.mouse.click(at.x, at.y)
      await expect.poll(() => lastInteraction(page), { timeout: 800 }).toEqual({ kind: 'location', detail: '主楼（house）' })
    }).toPass({ timeout: 12000 })
    await expect(page.getByTestId('voxel-activity-detail')).toContainText('主楼')
  })
})

test.describe('voxel platform gate (AC18)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('mobile hides all editing entries but keeps observation', async ({ page }) => {
    await waitReady(page)
    // 全部编辑入口隐藏
    await expect(page.getByTestId('voxel-editor-toolbar')).toBeHidden()
    await expect(page.getByTestId('voxel-tool-warehouse')).toBeHidden()
    await expect(page.getByTestId('voxel-tool-asset')).toBeHidden()
    await expect(page.getByTestId('voxel-tool-ai')).toBeHidden()
    // 观察与点击仍然可用（窄视口下庭院中心才在画面内）
    await expect(async () => {
      await freezeResidents(page, { x: 24, y: 1, z: 30 })
      const at = await toScreen(page, { x: 24, y: 2, z: 30 })
      await page.mouse.click(at.x, at.y)
      await expect(page.getByTestId('voxel-activity-panel')).toBeVisible({ timeout: 800 })
    }).toPass({ timeout: 12000 })
  })

  test('desktop keeps editing entries', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await waitReady(page)
    await expect(page.getByTestId('voxel-editor-toolbar')).toBeVisible()
  })
})
