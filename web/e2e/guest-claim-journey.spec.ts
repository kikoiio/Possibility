import { expect, test } from '@playwright/test'

/**
 * S2/T8 主链 E2E（真实本地服务,全程不打桩）：
 * 灌基线 → 访客进 /demo → 可见交互（进入温室花房）→ 创建分叉 → 注册并「登录并保存」（真实 claim）
 * → 重开保存世界 → 访客进度（位置 + 平行宇宙）仍在 → 点击地点得到面板反馈。
 * 固定单 worker（validation 命令带 --workers=1）,与其他 spec 共库但只写自己账号/会话的数据。
 */

// mist-manor-voxel-spaces.json greenhouse-1 anchor {38,4,14};多点候选避免树冠遮挡/相机角度落空
const GREENHOUSE_CANDIDATES = [
  { x: 41, y: 6, z: 17 }, { x: 38, y: 4, z: 14 }, { x: 40, y: 7, z: 16 }, { x: 42, y: 5, z: 18 },
]

async function clickGreenhouse(page: import('@playwright/test').Page) {
  // 首帧/相机未稳定或候选点被遮挡时点击会落空,沿用 scene-create 的重试点击模式(选择幂等)
  await expect(async () => {
    for (const at of GREENHOUSE_CANDIDATES) {
      const point = await page.evaluate(p => (window.__voxelEngine as never as {
        worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null
      } | undefined)?.worldToScreen(p), at)
      if (!point) continue
      await page.mouse.click(point.x, point.y)
      if (await page.getByRole('heading', { name: '温室花房' }).isVisible().catch(() => false)) return
    }
    throw new Error('温室花房面板未出现')
  }).toPass({ timeout: 30000 })
}

async function skipTour(page: import('@playwright/test').Page) {
  const skip = page.getByRole('button', { name: '跳过' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
}

test('guest interacts, forks, claims on register and keeps progress in the saved world', async ({ page, request }) => {
  test.setTimeout(240_000)

  // 1. 真实种子:admin + 雾影庄演示基线(dev 路由对 s02-e2e 环境放行,按世界名幂等)
  const seed = await request.post('/api/dev/seed', { data: {} })
  expect(seed.status(), await seed.text()).toBe(200)
  const seedDemo = await request.post('/api/dev/seed-demo', { data: {} })
  expect(seedDemo.status(), await seedDemo.text()).toBe(200)

  // 2. 访客进入演示世界
  await page.goto('/demo')
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 60_000 })
  await skipTour(page)

  // 3. 可见交互:进入温室花房(真实 scene/position 调用)
  await clickGreenhouse(page)
  await page.getByRole('button', { name: '进入此地点' }).click()
  await expect(page.getByRole('heading', { name: '进入世界' })).toBeVisible()
  // S3/F2:从地点卡进入时面板预选该地点(此前被 persona 记忆地点静默覆盖,须先手选)
  await expect(page.getByLabel('进入地点')).toHaveValue('温室花房')
  await page.getByRole('button', { name: '移动', exact: true }).click()
  await expect(page.getByText('你在 温室花房')).toBeVisible({ timeout: 15000 })
  await page.getByRole('button', { name: '关闭', exact: true }).click()

  // 4. 创建分叉并对照
  await page.getByRole('button', { name: '可能' }).click()
  await page.getByRole('button', { name: '创建并对照' }).click()
  await expect(page.getByText('已创建平行宇宙')).toBeVisible({ timeout: 30000 })
  await expect(page.getByText(/项事实差异/)).toBeVisible()

  // 5. 登录并保存:注册新账号 → 自动真实 claim → 落在保存后的世界
  await page.getByRole('link', { name: '登录并保存' }).click()
  await expect(page).toHaveURL(/\/login\?claimDemo=1/)
  await page.getByRole('button', { name: '没有账号？注册一个' }).click()
  await page.getByLabel('用户名').fill(`journey-${Date.now().toString(36)}`)
  await page.getByLabel('密码', { exact: true }).fill('journey-pass-6')
  await page.getByRole('button', { name: '注册', exact: true }).click()
  await expect(page).toHaveURL(/\/worlds\//, { timeout: 60000 })

  // 6. 重开保存世界:画布可用,访客进度(平行宇宙 + 位置)可见;地图铺满视窗(S3/F4,问题 19)
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 60_000 })
  await skipTour(page)
  const canvasBox = await page.getByTestId('voxel-viewport-canvas').boundingBox()
  const viewportHeight = page.viewportSize()?.height ?? 0
  expect(canvasBox?.height ?? 0).toBeGreaterThanOrEqual(viewportHeight * 0.9)
  const switcher = page.getByTestId('timeline-switcher')
  await expect(switcher).toBeVisible({ timeout: 30000 })
  await expect(switcher.locator('option')).toHaveCount(2)

  // 7. 点击地点得到面板反馈,且访客(已在温室花房)的到场状态随克隆保留
  await clickGreenhouse(page)
  await expect(page.getByText(/此刻在这里：.*访客/)).toBeVisible({ timeout: 15000 })
  await expect(page.getByRole('button', { name: '进入此地点' })).toBeVisible()
})
