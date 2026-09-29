import { expect, test, type Page } from '@playwright/test'

interface DocProbe { sections: Record<string, { nonAirCount: number }>; objects: Array<{ id: string; anchor: { x: number; y: number; z: number } }> }

async function waitReady(page: Page) {
  await page.goto('/dev/voxel')
  await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 15000 })
}

async function nonAirCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = (window.__voxelEngine as never as { world: { doc: DocProbe } }).world.doc
    return Object.values(doc.sections).reduce((n, s) => n + s.nonAirCount, 0)
  })
}

async function objectsProbe(page: Page) {
  return page.evaluate(() => (window.__voxelEngine as never as { world: { doc: DocProbe } }).world.doc.objects)
}

async function toScreen(page: Page, at: { x: number; y: number; z: number }) {
  return page.evaluate((cell) => (window.__voxelEngine as never as {
    worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null
  }).worldToScreen(cell)!, at)
}

test.describe('voxel editing (AC12/AC13/AC14/AC15)', () => {
  test('block mode: place one block and dig it back out (AC13)', async ({ page }) => {
    await waitReady(page)
    const before = await nonAirCount(page)
    await page.getByTestId('voxel-tool-block').click()
    await page.getByTestId('voxel-block-stone').click()
    const target = await toScreen(page, { x: 24, y: 1, z: 42 })
    await page.mouse.click(target.x, target.y)
    await expect.poll(() => nonAirCount(page)).toBe(before + 1)
    // hover 高亮应处于激活（放置模式悬停）
    await page.mouse.move(target.x + 30, target.y)
    // 挖掘同一位置
    await page.getByTestId('voxel-block-tool-dig').click()
    const placed = await toScreen(page, { x: 24, y: 1, z: 42 })
    await page.mouse.click(placed.x, placed.y)
    await expect.poll(() => nonAirCount(page)).toBe(before)
  })

  test('warehouse: drag a lantern in, move it, remove it (AC12)', async ({ page }) => {
    await waitReady(page)
    const objectsBefore = (await objectsProbe(page)).length
    await page.getByTestId('voxel-tool-warehouse').click()
    const dropAt = await toScreen(page, { x: 30, y: 1, z: 42 })
    await page.dragAndDrop(
      '[data-testid="voxel-warehouse-item-stone-lantern"]',
      '[data-testid="voxel-canvas"]',
      { targetPosition: { x: dropAt.x, y: dropAt.y } },
    )
    await expect.poll(async () => (await objectsProbe(page)).length).toBe(objectsBefore + 1)

    // 点击新放置的物体 → 选中；点击空地 → 移动
    const lanternTop = await toScreen(page, { x: 30, y: 2, z: 42 })
    await page.mouse.click(lanternTop.x, lanternTop.y)
    await expect(page.getByTestId('voxel-object-actions')).toBeVisible()
    const elsewhere = await toScreen(page, { x: 34, y: 1, z: 44 })
    await page.mouse.click(elsewhere.x, elsewhere.y)
    await expect.poll(async () => {
      const objects = await objectsProbe(page)
      const lantern = objects.find((o) => !['house', 'greenhouse', 'lantern-a', 'lantern-b', 'tree-a', 'tree-b', 'flowers', 'well', 'fence-a'].includes(o.id))
      return lantern ? `${lantern.anchor.x},${lantern.anchor.z}` : null
    }).toBe('34,44')

    // 再选中并移除
    const moved = await toScreen(page, { x: 34, y: 2, z: 44 })
    await page.mouse.click(moved.x, moved.y)
    await expect(page.getByTestId('voxel-object-actions')).toBeVisible()
    await page.getByTestId('voxel-object-remove').click()
    await expect.poll(async () => (await objectsProbe(page)).length).toBe(objectsBefore)
  })

  test('AI edit: ghost preview, confirm applies, cancel discards (AC14)', async ({ page }) => {
    await waitReady(page)
    const before = await nonAirCount(page)
    await page.route('**/api/voxel/edit-plan', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ops: [{ kind: 'set-block', at: { x: 2, y: 1, z: 42 }, block: 'lantern' }] }),
    }))
    await page.getByTestId('voxel-tool-ai').click()
    await page.getByTestId('voxel-ai-input').fill('在庭院里加一座石灯笼')
    await page.getByTestId('voxel-ai-preview').click()
    await expect(page.getByTestId('voxel-ai-pending')).toBeVisible()
    // 幽灵预览展示中
    expect(await page.evaluate(() => (window.__voxelEngine as never as { feedback: { ghostActive: boolean } }).feedback.ghostActive)).toBe(true)

    // 取消 → 无变更
    await page.getByTestId('voxel-ai-cancel').click()
    expect(await nonAirCount(page)).toBe(before)

    // 再次预览 → 确认 → 应用
    await page.getByTestId('voxel-ai-preview').click()
    await expect(page.getByTestId('voxel-ai-pending')).toBeVisible()
    await page.getByTestId('voxel-ai-confirm').click()
    await expect.poll(() => nonAirCount(page)).toBe(before + 1)
  })

  test('locked objects refuse moves with a reason (AC15)', async ({ page }) => {
    await waitReady(page)
    await page.getByTestId('voxel-tool-warehouse').click()
    // fixture 主楼是锁定物体：选中后尝试移动 → 拒绝提示
    const house = await toScreen(page, { x: 21, y: 2, z: 19 })
    await page.mouse.click(house.x, house.y)
    await expect(page.getByTestId('voxel-object-actions')).toBeVisible()
    const elsewhere = await toScreen(page, { x: 40, y: 1, z: 42 })
    await page.mouse.click(elsewhere.x, elsewhere.y)
    await expect(page.getByTestId('voxel-edit-rejected')).toBeVisible()
    // 锁定建筑上的挖掘也被拒绝
    await page.getByTestId('voxel-tool-block').click()
    await page.getByTestId('voxel-block-tool-dig').click()
    const wall = await toScreen(page, { x: 20, y: 2, z: 19 })
    await page.mouse.click(wall.x, wall.y)
    await expect(page.getByTestId('voxel-edit-rejected')).toBeVisible()
  })
})
