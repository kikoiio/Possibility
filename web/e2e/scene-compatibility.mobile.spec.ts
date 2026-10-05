import { expect, test, type Page, type Locator } from '@playwright/test'

/**
 * A1 场景兼容真实持久 E2E（W45，移动项目 compatibility-mobile）。
 *
 * 390×844 手机视口，从真实多空间世界（a1-legacy-spaces-world，GuestWorldMap 路径）
 * 入口展开诊断与变化清单，并完成一次真实保存。
 *
 * 入口说明（自给自足）：多空间世界的一次性 repair-current 在全量运行时已被
 * 桌面 W38 用掉（当前转 valid，v1 成为历史），独立运行时 v1 仍是当前版本、
 * 历史行无「恢复到此版本」按钮。因此本用例先核对修订数：仅 1 条时先经
 * 「场景检查」完成一次真实 repair-current（v1 转为历史），再走「历史 → v1 →
 * 恢复到此版本」的 restore-history 旅程——两条路径都是多空间地图内的真实按钮
 * （scene-check-entry / scene-history-entry），诊断与变化清单同样覆盖整个空间包。
 * 与桌面 spec 共享同一隔离持久库；版本号一律相对断言。
 */

test.setTimeout(300_000)

const SPACES_WORLD = 'a1-legacy-spaces-world'
const OWNER = { username: 'a1-legacy-owner', password: 'a1-legacy-pass-7' }

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('用户名').fill(OWNER.username)
  await page.getByLabel('密码').fill(OWNER.password)
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 30_000 })
}

async function bearer(page: Page): Promise<Record<string, string>> {
  const token = await page.evaluate(() => localStorage.getItem('possibility_token'))
  if (!token) throw new Error('本地没有登录 token，请先 login()')
  return { Authorization: `Bearer ${token}` }
}

async function sceneVersion(page: Page, worldId: string): Promise<number> {
  const res = await page.request.get(`/api/worlds/${worldId}/scene`, { headers: await bearer(page) })
  expect(res.ok()).toBeTruthy()
  const body = await res.json() as { status: string; version?: number }
  return body.status === 'ready' ? body.version ?? 0 : 0
}

async function revisionCount(page: Page, worldId: string): Promise<number> {
  const res = await page.request.get(`/api/worlds/${worldId}/scene/revisions`, { headers: await bearer(page) })
  expect(res.ok()).toBeTruthy()
  return ((await res.json() as { revisions: unknown[] }).revisions).length
}

test('移动多空间入口：390×844 展开诊断与变化清单并完成一次真实保存', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.goto(`/worlds/${SPACES_WORLD}`)
  await expect(page.getByTestId('scene-history-entry')).toBeVisible({ timeout: 120_000 })

  // 自给自足：仅 1 条修订时 v1 仍是当前版本(独立运行/全量顺序不同),
  // 先经「场景检查」完成真实 repair-current,把 invalid 的 v1 转为历史
  if (await revisionCount(page, SPACES_WORLD) === 1) {
    await page.getByTestId('scene-check-entry').click()
    const repair = page.getByRole('dialog', { name: '场景兼容检查' })
    await expect(repair).toBeVisible()
    await expect(repair).toContainText('修复当前场景')
    await expect(repair).toContainText('检查完成', { timeout: 30_000 })
    await repair.getByRole('button', { name: '构建修复预览' }).click()
    await expect(repair).toContainText('修复预览', { timeout: 30_000 })
    await repair.getByRole('button', { name: '确认保存为新版本' }).click()
    await expect(repair).toContainText(/已保存为新版本 v\d+（场景修复）/, { timeout: 60_000 })
    await repair.getByRole('button', { name: '关闭兼容检查' }).click()
    await expect(repair).toHaveCount(0)
  }

  const before = await sceneVersion(page, SPACES_WORLD)
  const rowsBefore = await revisionCount(page, SPACES_WORLD)

  // 多空间地图头部「历史」→ v1（永远 invalid）→ 恢复到此版本 → 兼容旅程
  await page.getByTestId('scene-history-entry').click()
  const history = page.getByRole('dialog', { name: '场景历史' })
  await expect(history).toBeVisible()
  const rowV1 = history.locator('li').filter({ hasText: '隔离 fixture 原始旧场景' })
  await expect(rowV1).toBeVisible({ timeout: 30_000 })
  await rowV1.getByRole('button', { name: '恢复到此版本' }).click()

  const dialog = page.getByRole('dialog', { name: '场景兼容检查' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('恢复历史场景')
  await expect(dialog).toContainText('历史版本 v1')
  await expect(dialog).toContainText('检查完成', { timeout: 30_000 })
  await expect(dialog).toContainText('发现阻断问题')
  await expect(dialog).toContainText('空间 hall')

  // 构建修复预览：变化清单 + 空间 tab + 修复前/后 tab，同视口可切换
  await dialog.getByRole('button', { name: '构建修复预览' }).click()
  await expect(dialog).toContainText('修复预览', { timeout: 30_000 })
  await expect(dialog).toContainText(/本次修复变化（\d+ 项）/)
  await dialog.getByRole('tab', { name: '老花房' }).click()
  await expect(dialog.getByRole('tab', { name: '老花房' })).toHaveAttribute('aria-selected', 'true')
  await dialog.getByRole('tab', { name: '修复前' }).click()
  await expect(dialog.getByRole('tab', { name: '修复前' })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByRole('tab', { name: '石灯外景' })).toBeVisible()
  await expect(dialog).toContainText('预览为只读，不会触发编辑或自动保存。')

  // 面板可滚动：确认/取消按钮在 390px 视口内可操作、无裁切
  const dialogBox = await dialog.boundingBox()
  expect(dialogBox).not.toBeNull()
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0)
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(390)
  const closeButton = dialog.getByRole('button', { name: '关闭兼容检查' })
  const closeBox = await closeButton.boundingBox()
  expect(closeBox).not.toBeNull()
  expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(390)
  const confirmButton = dialog.getByRole('button', { name: '确认保存为新版本' })
  await confirmButton.scrollIntoViewIfNeeded()
  const confirmBox = await confirmButton.boundingBox()
  expect(confirmBox).not.toBeNull()
  expect(confirmBox!.x).toBeGreaterThanOrEqual(0)
  expect(confirmBox!.x + confirmBox!.width).toBeLessThanOrEqual(390)

  // 完成一次真实保存：回执可见，历史多出新版本
  await confirmButton.click()
  await expect(dialog).toContainText(/已保存为新版本 v\d+（历史恢复）/, { timeout: 60_000 })
  expect(await sceneVersion(page, SPACES_WORLD)).toBe(before + 1)
  await dialog.getByRole('button', { name: '关闭兼容检查' }).click()
  expect(await revisionCount(page, SPACES_WORLD)).toBe(rowsBefore + 1)
})
