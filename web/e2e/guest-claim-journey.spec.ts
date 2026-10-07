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

async function openDemoMap(page: import('@playwright/test').Page) {
  const canvas = page.getByTestId('voxel-viewport-canvas')
  const missingWorld = page.getByText('世界或时间线不存在')
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 0) await page.goto('/demo')
    else await page.reload()
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="voxel-viewport-canvas"]'))
      || document.body.innerText.includes('世界或时间线不存在'), null, { timeout: 30_000 })
    if (await canvas.isVisible().catch(() => false)) return
    if (!await missingWorld.isVisible().catch(() => false)) throw new Error('演示世界未加载，页面也没有可识别的世界/时间线错误')
  }
  await expect(canvas).toBeVisible({ timeout: 60_000 })
}

test('guest interacts, forks, claims on register and keeps progress in the saved world', async ({ page, request }) => {
  test.setTimeout(240_000)

  // 1. 真实种子:admin + 雾影庄演示基线(dev 路由对 s02-e2e 环境放行,按世界名幂等)
  const seed = await request.post('/api/dev/seed', { data: {} })
  expect(seed.status(), await seed.text()).toBe(200)
  const seedDemo = await request.post('/api/dev/seed-demo', { data: {} })
  expect(seedDemo.status(), await seedDemo.text()).toBe(200)

  // 2. 访客进入演示世界
  await openDemoMap(page)
  await skipTour(page)

  // 3. 可见交互:进入温室花房(真实 scene/position 调用)
  await clickGreenhouse(page)
  await page.getByRole('button', { name: '进入此地点' }).click()
  await expect(page.getByRole('heading', { name: '进入世界' })).toBeVisible()
  // S3/F2:从地点卡进入时面板预选该地点(此前被 persona 记忆地点静默覆盖,须先手选)
  await expect(page.getByLabel('进入地点')).toHaveValue('温室花房')
  await page.getByRole('button', { name: '移动', exact: true }).click()
  await expect(page.getByText('你在 温室花房')).toBeVisible({ timeout: 15000 })
  await page.getByPlaceholder('开口说话…（Enter 发送，Shift+Enter 换行）').fill('今天的兰花开得很好。')
  await page.getByRole('button', { name: '说', exact: true }).click()
  await expect(page.getByText('我收到了庭院维护的消息，会把这段经历记下来。')).toBeVisible({ timeout: 30000 })
  await page.getByRole('button', { name: '关闭', exact: true }).click()

  // 4. 创建分叉并对照
  await page.getByRole('button', { name: '可能' }).click()
  await page.getByRole('button', { name: '创建并对照' }).click()
  await page.getByTestId('guest-fork-confirm').click()
  await expect(page.getByTestId('guest-fork-summary')).toBeVisible({ timeout: 30000 })
  await page.getByRole('button', { name: '直接比较来源与新分支' }).click()
  await expect(page.getByRole('heading', { name: '两种人生' })).toBeVisible()
  await page.getByRole('button', { name: '关闭', exact: true }).click()

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

  // 7. 认领后的所有者管理：暂停并恢复世界，通过 UI 与真实 API 改变状态
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible({ timeout: 15000 })
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible({ timeout: 15000 })

  // 8. 真实 UI 场景编辑：挑选未绑定地点的装饰资产并移除，等待服务端 revision 保存
  const removable = await page.evaluate(() => {
    const engine = (window as any).__voxelEngine
    const doc = engine?.world?.doc
    if (!doc || !engine?.worldToScreen) return []
    const bound = new Set((doc.locations ?? []).map(location => location.objectId))
    return (doc.assetPlacements ?? []).filter(item => item.id && !bound.has(item.id)
      && ['decoration', 'vegetation'].includes(engine.assetsManifest?.assets[item.assetId]?.category ?? ''))
      .map(item => ({ id: item.id!, x: item.anchor[0], y: item.anchor[1] + Math.max(1, (engine.assetsManifest?.assets[item.assetId]?.height ?? 2) / 2), z: item.anchor[2] }))
  })
  expect(removable.length, 'claimed world should contain a removable unbound decorative asset').toBeGreaterThan(0)
  await page.getByTestId('voxel-tool-asset').click()
  await expect(page.getByTestId('voxel-asset-panel')).toBeVisible()
  let selectedAssetId: string | null = null
  for (const candidate of removable) {
    const point = await page.evaluate(at => (window.__voxelEngine as never as {
      worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null
    } | undefined)?.worldToScreen(at), candidate)
    if (!point) continue
    await page.mouse.click(point.x, point.y)
    if (await page.getByTestId('voxel-asset-actions').isVisible().catch(() => false)) {
      selectedAssetId = candidate.id
      break
    }
  }
  expect(selectedAssetId, 'an unbound decorative asset should be selectable in the owner editor').not.toBeNull()
  const revisionResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && response.url().includes('/scene/voxel-revision') && response.status() === 200)
  await page.getByTestId('voxel-asset-remove').click()
  await revisionResponse
  await expect(page.getByTestId('voxel-asset-actions')).toHaveCount(0)

  // 9. 从多空间 owner renderer 发起真实分屏；记录当前 renderer 是否支持并继续验证刷新
  await page.getByRole('button', { name: '对照宇宙', exact: true }).click()
  await expect(page.getByRole('heading', { name: '两种人生' })).toBeVisible({ timeout: 15000 })
  await page.getByTestId('compare-split-entry').click()
  await expect(page).toHaveURL(/mode=possibility/)
  const splitAvailable = await page.getByTestId('split-view').isVisible().catch(() => false)
  if (splitAvailable) {
    await expect(page.getByTestId('split-title-left')).toBeVisible()
    await expect(page.getByTestId('split-title-right')).toBeVisible()
    await expect(page.getByTestId('split-view').getByTestId('voxel-viewport-canvas')).toHaveCount(2)
  }

  // 10. 刷新继续：认领世界、时间线、对话记录与已保存的场景编辑均保留
  await page.reload()
  await expect(page.getByTestId('split-view')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('split-view').getByTestId('voxel-viewport-canvas')).toHaveCount(2)
  await skipTour(page)
  // 返回地图体验位置，正常关闭可能性抽屉后再选择地点。
  await page.getByRole('navigation', { name: '体验位置' }).getByRole('button', { name: '在场', exact: true }).click()
  await expect(page.getByTestId('split-view')).toHaveCount(0)
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible()
  await expect(page.getByTestId('timeline-switcher').locator('option')).toHaveCount(2)
  const persistedPlacements = await page.evaluate(() => (window.__voxelEngine as never as {
    world?: { doc?: { assetPlacements?: { id?: string }[] } }
  } | undefined)?.world?.doc?.assetPlacements?.map(item => item.id) ?? [])
  expect(persistedPlacements).not.toContain(selectedAssetId)

  // 11. 访客的到场状态与交谈记录随认领克隆保留
  await clickGreenhouse(page)
  await expect(page.getByText(/此刻在这里：.*访客/)).toBeVisible({ timeout: 15000 })
  await expect(page.getByRole('button', { name: '进入此地点' })).toBeVisible()
  await page.getByRole('button', { name: '进入此地点' }).click()
  await expect(page.getByText('我收到了庭院维护的消息，会把这段经历记下来。')).toBeVisible({ timeout: 15000 })
  expect(splitAvailable, 'the claimed multi-space renderer should expose the real side-by-side timeline view').toBe(true)
})
