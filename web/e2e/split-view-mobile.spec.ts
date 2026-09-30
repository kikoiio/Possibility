import { expect, test } from '@playwright/test'
import { events, stubSplitApis, watchErrors } from './split-view-stubs'

/**
 * S1 窄屏降级 e2e(N4):分屏在移动端降级为单视口 + 切换,入口提示保留。
 * 仅在 mobile-chromium project 运行(playwright.config testMatch)。
 */

test('窄屏:单视口 + 左右切换 + 大屏提示', async ({ page }) => {
  const errors = watchErrors(page)
  await stubSplitApis(page)
  await page.goto('/worlds/world-1?mode=possibility&timeline=timeline-main&right=timeline-fork')

  // 单视口:只有一个体素实例,降级容器与提示可见
  await expect(page.getByTestId('split-small')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-voxel-instance]')).toHaveCount(1)
  await expect(page.getByText(/大屏可同时分屏查看/)).toBeVisible()
  await expect(page.getByTestId('split-small-title')).toContainText('原来的发展 · 主线')

  // 切换到右线:同一视口换绑,标题与实例随之切换
  await page.getByTestId('split-small-toggle').click()
  await expect(page.getByTestId('split-small-title')).toContainText('另一种发展 · 分叉', { timeout: 10000 })
  await expect(page.locator('[data-voxel-instance="right"]')).toHaveCount(1)

  // 关闭分屏回到该线单视口
  await page.getByTestId('split-close-small').click()
  await expect(page.getByTestId('split-small')).toBeHidden()
  await expect(page.locator('[data-voxel-instance="main"]')).toHaveCount(1)
  expect(errors.filter((e) => !e.includes('net::'))).toEqual([])
})
