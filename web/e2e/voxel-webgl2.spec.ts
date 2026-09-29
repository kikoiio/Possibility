import { expect, test, chromium } from '@playwright/test'

/** N9：WebGL2 被禁用时显示明确降级提示而非白屏 */
test('WebGL2 disabled shows degradation notice (N9)', async () => {
  const browser = await chromium.launch({ args: ['--disable-webgl', '--disable-webgl2'] })
  try {
    const page = await browser.newPage({ baseURL: test.info().project.use.baseURL as string })
    await page.goto('/dev/voxel')
    const notice = page.getByTestId('voxel-error')
    await expect(notice).toBeVisible({ timeout: 15000 })
    await expect(notice).toContainText('WebGL2')
    // 页面仍有内容（非白屏）：提示文本可见且画布被错误层覆盖
    await expect(page.getByTestId('voxel-canvas')).toBeHidden()
  } finally {
    await browser.close()
  }
})
