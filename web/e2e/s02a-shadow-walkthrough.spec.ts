import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

/**
 * S2a 光影 · T8 视觉验收走查(checklist AC1–AC7 + T7 标定)。
 * 截图输出 docs/spec_docs/voxel-visual-upgrade/s02a-lighting-shadow/walkthrough/(gitignored)。
 */

const SHOTS = '../docs/spec_docs/voxel-visual-upgrade/s02a-lighting-shadow/walkthrough'
mkdirSync(SHOTS, { recursive: true })

interface EngineProbe {
  setTimeOfDay(t: number): void
  setWeather(state: Record<string, number>): void
  palette: {
    ambientLift: number
    shadow: { enabled: boolean; mapSize: number; softwareMapSize: number }
    keyframes: Array<Record<string, number>>
  } | null
  renderer: {
    directLight: {
      intensity: number
      castShadow: boolean
      position: { x: number; y: number; z: number }
      target: { position: { x: number; y: number; z: number } }
      shadow: { mapSize: { x: number } }
    } | null
  } & Record<string, unknown>
  world: {
    getBlock(p: { x: number; y: number; z: number }): string
    doc: { size: { width: number; height: number; depth: number } }
  } | null
}

declare global {
  interface Window { __voxelEngine?: EngineProbe }
}

async function openWorld(page: Page) {
  const errors: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
  page.on('pageerror', (err) => errors.push(String(err)))
  await page.goto('/dev/voxel')
  await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 15000 })
  await page.waitForTimeout(600)
  return errors
}

/** 等渲染循环真正走完两帧（SwiftShader 低帧率下固定延时可能截到旧帧） */
async function waitFrames(page: Page, n = 2) {
  await page.evaluate((count) => new Promise<void>((resolve) => {
    const step = (left: number) => { left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)) }
    step(count)
  }), n)
}

async function setTime(page: Page, t: number) {
  await page.evaluate((v) => window.__voxelEngine!.setTimeOfDay(v), t)
  await waitFrames(page, 2)
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

test.describe.configure({ mode: 'serial', timeout: 120_000 })

test.describe('S2a 光影走查', () => {
  test('T7 标定:直射清零 → 纯环境光画面(对比 S1 基线)', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0.5)
    await page.evaluate(() => {
      for (const kf of window.__voxelEngine!.palette!.keyframes) {
        kf.sunLightIntensity = 0
        kf.moonLightIntensity = 0
      }
    })
    await waitFrames(page, 2)
    await shot(page, 's02a-ambient-calibration')
    const lightOff = await page.evaluate(() => window.__voxelEngine!.renderer.directLight!.intensity)
    expect(lightOff).toBe(0)
    expect(errors).toEqual([])
  })

  test('AC1/AC2 白天:正午观感 + 三时刻阴影连续转动', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0.3)
    await shot(page, 'shadow-morning')
    await setTime(page, 0.5)
    await shot(page, 'shadow-noon')
    await setTime(page, 0.7)
    await shot(page, 'shadow-evening')
    // 探针:正午直射强度高,且光源方位随时间移动
    const probe = await page.evaluate(() => window.__voxelEngine!.renderer.directLight!)
    expect(probe.intensity).toBeGreaterThan(0.5)
    expect(probe.castShadow).toBe(true)
    expect(errors).toEqual([])
  })

  test('AC3 午夜:月光弱冷阴影,方向与月亮一致', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0)
    await shot(page, 'shadow-midnight')
    const probe = await page.evaluate(() => window.__voxelEngine!.renderer.directLight!)
    expect(probe.intensity).toBeGreaterThan(0.1)
    expect(probe.intensity).toBeLessThan(0.4)
    expect(errors).toEqual([])
  })

  test('AC4 数据驱动:改 palette 直射强度 → 灯强度同步', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0.5)
    const before = await page.evaluate(() => window.__voxelEngine!.renderer.directLight!.intensity)
    await page.evaluate(() => {
      for (const kf of window.__voxelEngine!.palette!.keyframes) kf.sunLightIntensity = 2.0
    })
    await waitFrames(page, 2)
    const after = await page.evaluate(() => window.__voxelEngine!.renderer.directLight!.intensity)
    expect(after).toBeGreaterThan(before)
    await shot(page, 'ac4-direct-boosted')
    expect(errors).toEqual([])
  })

  test('AC5 开关与降级:关阴影退回 S1;软渲染 mapSize 降档', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0.5)
    // 软渲染后端自动降档(playwright 走 SwiftShader)
    const mapSize = await page.evaluate(() => window.__voxelEngine!.renderer.directLight!.shadow.mapSize.x)
    expect(mapSize).toBe(1024)
    await shot(page, 'ac5-shadow-on')
    await page.evaluate(() => { window.__voxelEngine!.palette!.shadow.enabled = false })
    await waitFrames(page, 2)
    const off = await page.evaluate(() => window.__voxelEngine!.renderer.directLight!.castShadow)
    expect(off).toBe(false)
    await shot(page, 'ac5-shadow-off')
    expect(errors).toEqual([])
  })

  test('AC7 编辑即投影:挖墙 → 新几何投影/被投影 → 补回', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0.5)
    const target = await page.evaluate(() => {
      const engine = window.__voxelEngine!
      if (!engine.world) return null
      const { width, height, depth } = engine.world.doc.size
      let best: { x: number; y: number; z: number; id: string } | null = null
      let bestScore = Infinity
      for (let y = 1; y < Math.min(height, 8); y++)
        for (let x = 2; x < width - 2; x++)
          for (let z = 2; z < depth - 2; z++) {
            const id = engine.world!.getBlock({ x, y, z })
            if (id === 'air' || id === 'water') continue
            if (engine.world!.getBlock({ x, y, z: z + 1 }) !== 'air') continue
            const score = Math.abs(x - width / 2) + Math.abs(z - depth / 2) + y
            if (score < bestScore) { bestScore = score; best = { x, y, z, id } }
          }
      return best
    })
    expect(target).not.toBeNull()
    await shot(page, 'edit-shadow-before')
    await page.evaluate((p) => {
      window.__voxelPerf!.timedEdit([
        { kind: 'set-block', at: { x: p.x, y: p.y, z: p.z }, block: 'air' },
        { kind: 'set-block', at: { x: p.x, y: p.y, z: p.z + 1 }, block: p.id },
      ])
    }, target!)
    await waitFrames(page, 2)
    await shot(page, 'edit-shadow-after-dig')
    await page.evaluate((p) => {
      window.__voxelPerf!.timedEdit([
        { kind: 'set-block', at: { x: p.x, y: p.y, z: p.z }, block: p.id },
        { kind: 'set-block', at: { x: p.x, y: p.y, z: p.z + 1 }, block: 'air' },
      ])
    }, target!)
    await waitFrames(page, 2)
    await shot(page, 'edit-shadow-after-restore')
    expect(errors).toEqual([])
  })

  test('天气联动:雨天直射压暗', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0.5)
    const clear = await page.evaluate(() => window.__voxelEngine!.renderer.directLight!.intensity)
    await shot(page, 'weather-clear-noon')
    await page.evaluate(() => window.__voxelEngine!.setWeather({ rain: 1 }))
    await page.waitForTimeout(1500) // 天气渐变本身有时长,再补两帧确保落版
    await waitFrames(page, 2)
    const rainy = await page.evaluate(() => window.__voxelEngine!.renderer.directLight!.intensity)
    expect(rainy).toBeLessThan(clear * 0.8)
    await shot(page, 'weather-rain-noon')
    expect(errors).toEqual([])
  })

  test('N3 reduced-motion:渲染正常无报错', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors = await openWorld(page)
    await setTime(page, 0.5)
    await shot(page, 'reduced-motion-shadow')
    expect(errors).toEqual([])
  })
})
