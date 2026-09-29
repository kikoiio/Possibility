import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

/**
 * S1 光影与地表风格化 · 截图内环基建(T1)。
 * 矩阵:fixture(平地/地形)× 时段(正午/黄昏/午夜)× 天气(晴/雨)共 12 张,
 * 落盘 docs/spec_docs/voxel-visual-upgrade/s01-lighting-terrain-stylization/walkthrough/。
 * 调参轮次中反复运行,人工目检迭代。
 */

const SHOTS = '../docs/spec_docs/voxel-visual-upgrade/s01-lighting-terrain-stylization/walkthrough'
mkdirSync(SHOTS, { recursive: true })

interface EngineProbe {
  setTimeOfDay(t: number): void
  setWeather(state: Record<string, number>): void
}

declare global {
  interface Window { __voxelEngine?: EngineProbe }
}

async function openWorld(page: Page, fixture: 'flat' | 'terrain') {
  const errors: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
  page.on('pageerror', (err) => errors.push(String(err)))
  if (fixture === 'terrain') {
    await page.addInitScript(() => { try { localStorage.setItem('voxel-dev-fixture', 'terrain') } catch { /* ignore */ } })
  }
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

async function setWeather(page: Page, rain: number) {
  await page.evaluate((r) => window.__voxelEngine!.setWeather({ rain: r }), rain)
  await page.waitForTimeout(1500) // 天气渐变时长,再补两帧确保落版
  await waitFrames(page, 2)
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

const TIMES = [
  ['noon', 0.5],
  ['dusk', 0.72],
  ['midnight', 0],
] as const

test.describe.configure({ mode: 'serial', timeout: 120_000 })

for (const fixture of ['flat', 'terrain'] as const) {
  test.describe(`S1 截图矩阵:${fixture}`, () => {
    for (const [timeName, t] of TIMES) {
      test(`${fixture}/${timeName} 晴+雨`, async ({ page }) => {
        const errors = await openWorld(page, fixture)
        await setTime(page, t)
        await shot(page, `${fixture}-${timeName}-clear`)
        await setWeather(page, 1)
        await shot(page, `${fixture}-${timeName}-rain`)
        expect(errors).toEqual([])
      })
    }
  })
}
