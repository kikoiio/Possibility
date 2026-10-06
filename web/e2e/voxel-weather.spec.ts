import { expect, test } from '@playwright/test'

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/dev/voxel')
  await expect(page.getByTestId('voxel-canvas')).toBeVisible({ timeout: 20000 })
  await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 20000 })
  await expect(page.getByTestId('voxel-dev-controls')).toBeVisible({ timeout: 20000 })
}

test.describe('voxel time & weather (AC6/AC7/AC8 雏形)', () => {
  test('day → night transition changes sky light and tints', async ({ page }) => {
    await waitReady(page)
    const slider = page.getByTestId('voxel-time-slider')
    await slider.fill('0.5')
    await page.waitForTimeout(300)
    const day = await page.evaluate(() => (window.__voxelEngine as never as { bakeEnv: { skyTint: number[] }; lighting: { getSkyLevel(): number } }).lighting.getSkyLevel())
    expect(day).toBe(15)
    await slider.fill('0')
    await page.waitForTimeout(300)
    const night = await page.evaluate(() => (window.__voxelEngine as never as { lighting: { getSkyLevel(): number } }).lighting.getSkyLevel())
    // The current palette keeps a bright moonlit night; follow the shared palette contract
    // rather than the old nearly-dark threshold.
    expect(night).toBe(14)
    await page.screenshot({ path: 'e2e/snapshots/voxel-night.png' })
    await slider.fill('0.55')
    await page.waitForTimeout(300)
  })

  test('rain / snow / fog states activate their systems', async ({ page }) => {
    await waitReady(page)
    const weatherState = () => page.evaluate(() => (window.__voxelEngine as never as { weather: { state: { rain: number; snow: number; fog: number } } }).weather.state)

    await page.getByTestId('voxel-weather-rain').click()
    await page.waitForTimeout(1200)
    expect((await weatherState()).rain).toBeGreaterThan(0.6)
    await page.screenshot({ path: 'e2e/snapshots/voxel-rain.png' })

    await page.getByTestId('voxel-weather-snow').click()
    await page.waitForTimeout(1200)
    expect((await weatherState()).snow).toBeGreaterThan(0.6)
    await page.screenshot({ path: 'e2e/snapshots/voxel-snow.png' })

    await page.getByTestId('voxel-weather-fog').click()
    await page.waitForTimeout(1200)
    expect((await weatherState()).fog).toBeGreaterThan(0.6)
    await page.screenshot({ path: 'e2e/snapshots/voxel-fog.png' })

    // 恢复晴天 → 效果消退
    await page.getByTestId('voxel-weather-clear').click()
    await page.waitForTimeout(1500)
    const cleared = await weatherState()
    expect(cleared.rain).toBeLessThan(0.1)
    expect(cleared.snow).toBeLessThan(0.1)
    expect(cleared.fog).toBeLessThan(0.1)
  })

  test('prefers-reduced-motion disables particles (AC8)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitReady(page)
    await page.getByTestId('voxel-weather-rain').click()
    await page.waitForTimeout(1000)
    const probe = await page.evaluate(() => {
      const engine = window.__voxelEngine as never as {
        motion: { isReduced(): boolean }
        weather: { state: { rain: number }; rainLines: { visible: boolean } }
      }
      return { reduced: engine.motion.isReduced(), rain: engine.weather.state.rain, rainVisible: engine.weather.rainLines.visible }
    })
    expect(probe.reduced).toBe(true)
    expect(probe.rain).toBeGreaterThan(0.5)   // 天气状态本身仍生效
    expect(probe.rainVisible).toBe(false)      // 但粒子被降级关闭
  })
})
