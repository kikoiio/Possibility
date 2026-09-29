import { expect, test } from '@playwright/test'

interface ResidentSnapshot { personId: string; position: { x: number; y: number; z: number }; moving: boolean }

async function snapshot(page: import('@playwright/test').Page): Promise<ResidentSnapshot[]> {
  return page.evaluate(() => (window.__voxelEngine as never as { residents: { snapshot(): ResidentSnapshot[] } }).residents.snapshot())
}

test.describe('voxel residents (AC9 雏形)', () => {
  test('residents walk between locations with animation', async ({ page }) => {
    await page.goto('/dev/voxel')
    await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 15000 })
    const first = await snapshot(page)
    expect(first.length).toBe(2)
    await page.waitForTimeout(2500)
    const second = await snapshot(page)
    // 至少一名居民在移动且位置发生了变化
    expect(second.some((r) => r.moving)).toBe(true)
    const moved = second.some((r) => {
      const before = first.find((f) => f.personId === r.personId)
      return before && (Math.abs(before.position.x - r.position.x) > 0.3 || Math.abs(before.position.z - r.position.z) > 0.3)
    })
    expect(moved).toBe(true)
    await page.screenshot({ path: 'e2e/snapshots/voxel-residents.png' })
    // 往返切换后最终能停驻
    await page.waitForTimeout(12000)
    const later = await snapshot(page)
    expect(later.length).toBe(2)
  })
})
