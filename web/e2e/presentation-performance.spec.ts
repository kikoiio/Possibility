import { expect, test } from '@playwright/test'
import { stubSplitApis } from './split-view-stubs'

test.describe.configure({ mode: 'serial', timeout: 240_000 })

interface PerformanceWindow {
  __voxelEngines?: Record<string, { world?: unknown } | undefined>
  performance: Performance & { memory?: { usedJSHeapSize: number } }
}

async function heapBytes(page: import('@playwright/test').Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as PerformanceWindow).performance.memory?.usedJSHeapSize ?? null)
}

test('records viewport readiness and renderer release observations', async ({ page }) => {
  await stubSplitApis(page)
  const observations: Record<string, number | null> = {}

  let started = Date.now()
  await page.goto('/worlds/world-1?timeline=timeline-main')
  await page.waitForFunction(() => !!(window as unknown as PerformanceWindow).__voxelEngines?.main?.world)
  observations.single3dReadyMs = Date.now() - started
  observations.single3dHeapBytes = await heapBytes(page)

  started = Date.now()
  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=native2d')
  await expect(page.locator('[data-presentation="native2d"] canvas')).toBeVisible()
  observations.single2dReadyMs = Date.now() - started
  observations.single2dHeapBytes = await heapBytes(page)

  started = Date.now()
  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=native2d&rightWorld=world-1&right=timeline-fork&rightPresentation=native2d')
  await expect(page.locator('[data-presentation="native2d"] canvas')).toHaveCount(2)
  observations.double2dReadyMs = Date.now() - started
  observations.double2dHeapBytes = await heapBytes(page)

  started = Date.now()
  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=voxel3d&rightWorld=world-1&right=timeline-fork&rightPresentation=voxel3d')
  await expect(page.locator('[data-voxel-instance="left"] canvas')).toBeVisible()
  await expect(page.locator('[data-voxel-instance="right"] canvas')).toBeVisible()
  await page.waitForFunction(() => {
    const engines = (window as unknown as PerformanceWindow).__voxelEngines
    return !!engines?.left?.world && !!engines?.right?.world
  })
  observations.double3dReadyMs = Date.now() - started
  observations.double3dHeapBytes = await heapBytes(page)
  observations.double3dRendererCount = await page.evaluate(() => Object.values((window as unknown as PerformanceWindow).__voxelEngines ?? {}).filter(Boolean).length)

  started = Date.now()
  await page.getByRole('button', { name: '关闭右侧' }).click()
  await expect(page.getByTestId('comparison-pane-right')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => Object.values((window as unknown as PerformanceWindow).__voxelEngines ?? {}).filter(Boolean).length)).toBe(1)
  observations.closeRightReadyMs = Date.now() - started
  observations.afterCloseRendererCount = await page.evaluate(() => Object.values((window as unknown as PerformanceWindow).__voxelEngines ?? {}).filter(Boolean).length)
  observations.afterCloseHeapBytes = await heapBytes(page)

  started = Date.now()
  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=native2d&rightWorld=world-1&right=timeline-fork&rightPresentation=voxel3d')
  await expect(page.locator('[data-presentation="native2d"] canvas')).toBeVisible()
  await page.waitForFunction(() => !!(window as unknown as PerformanceWindow).__voxelEngines?.right?.world)
  observations.mixed2d3dReadyMs = Date.now() - started
  observations.mixed2d3dRendererCount = await page.evaluate(() => Object.values((window as unknown as PerformanceWindow).__voxelEngines ?? {}).filter(Boolean).length)

  started = Date.now()
  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=voxel3d&rightWorld=world-1&right=timeline-fork&rightPresentation=native2d')
  await expect(page.locator('[data-presentation="native2d"] canvas')).toBeVisible()
  await page.waitForFunction(() => !!(window as unknown as PerformanceWindow).__voxelEngines?.left?.world)
  observations.mixed3d2dReadyMs = Date.now() - started
  observations.mixed3d2dRendererCount = await page.evaluate(() => Object.values((window as unknown as PerformanceWindow).__voxelEngines ?? {}).filter(Boolean).length)

  console.info(`PHASE3_PERF_OBSERVATIONS ${JSON.stringify({
    commit: process.env.GITHUB_SHA ?? 'workflow checkout commit',
    browser: 'GitHub Actions desktop Chromium',
    viewport: page.viewportSize(),
    observations,
  })}`)
  expect(observations.double3dRendererCount).toBe(2)
  expect(observations.afterCloseRendererCount).toBe(1)
  expect(observations.mixed2d3dRendererCount).toBe(1)
  expect(observations.mixed3d2dRendererCount).toBe(1)
})
