import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

/**
 * S3b 参数化地形 + 风格包 · AC12 端到端走查 + 探针断言(N6:探针为主力,截图目检收尾)。
 * 截图输出 docs/spec_docs/voxel-visual-upgrade/s03b-parametric-terrain-stylepack/walkthrough/(gitignored)。
 * 探针走 window.__voxelWorld(EditController 真实链路)+ window.__voxelEngine;截图前一律 waitFrames。
 */

const SHOTS = '../docs/spec_docs/voxel-visual-upgrade/s03b-parametric-terrain-stylepack/walkthrough'
mkdirSync(SHOTS, { recursive: true })

interface WorldProbe {
  getBlock(x: number, y: number, z: number): string
  getStyle(): { preset: string; tweaks?: Record<string, number> } | undefined
  getTerrainParams(): { seed: number } | null
  getObjectCellCount(): number
  regen(params: unknown): { ok: boolean; issues: Array<{ code: string; message: string }> }
  setStyle(style: unknown): { ok: boolean }
}

interface EngineProbe {
  setTimeOfDay(t: number): void
  world: { doc: { size: { width: number; height: number; depth: number }; objectCells: Array<{ cells: unknown[] }> } } | null
  cameraRig: {
    setMode(m: string): void
    orbit?: { setTarget(t: { x: number; y: number; z: number }): void; theta: number; phi: number; distance: number }
  }
}

declare global {
  interface Window {
    __voxelWorld?: WorldProbe
    __voxelEngine?: EngineProbe
  }
}

async function openTerrainWorld(page: Page) {
  const errors: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
  page.on('pageerror', (err) => errors.push(String(err)))
  await page.addInitScript(() => {
    try { localStorage.setItem('voxel-dev-fixture', 'terrain') } catch { /* ignore */ }
  })
  await page.goto('/dev/voxel')
  await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 15000 })
  await page.waitForTimeout(600)
  return errors
}

/** 等渲染循环真正走完 n 帧(SwiftShader 低帧率下固定延时可能截到旧帧) */
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

/** 扫描世界,返回指定方块的数量(探针逐格读,48×24×48 可接受) */
async function countBlocks(page: Page, block: string) {
  return page.evaluate((b) => {
    const probe = window.__voxelWorld!
    const size = window.__voxelEngine!.world!.doc.size
    let count = 0
    for (let y = 0; y < size.height; y++) {
      for (let z = 0; z < size.depth; z++) {
        for (let x = 0; x < size.width; x++) {
          if (probe.getBlock(x, y, z) === b) count += 1
        }
      }
    }
    return count
  }, block)
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

test.describe('S3b 参数化地形 + 风格包', () => {
  test('AC1/AC7 探针:地形能力(河/树/起伏)与风格包生效', async ({ page }) => {
    const errors = await openTerrainWorld(page)
    // 地形:河流(water)、树(wood-log/leaves)、起伏(非全平 grass 顶)
    expect(await countBlocks(page, 'water')).toBeGreaterThan(0)
    expect(await countBlocks(page, 'wood-log')).toBeGreaterThan(0)
    expect(await countBlocks(page, 'leaves')).toBeGreaterThan(0)
    // 风格包:dusk-warm + 微调
    const style = await page.evaluate(() => window.__voxelWorld!.getStyle())
    expect(style?.preset).toBe('dusk-warm')
    expect(style?.tweaks?.exposure).toBeCloseTo(0.05)
    // 地形元数据落盘(seed 存在)
    const params = await page.evaluate(() => window.__voxelWorld!.getTerrainParams())
    expect(Number.isInteger(params?.seed)).toBe(true)
    // 建筑落在地形上(objectCells 存在)
    expect(await page.evaluate(() => window.__voxelWorld!.getObjectCellCount())).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })

  test('AC2/AC6 重生成:地形替换、物体保留、手工改格被覆盖', async ({ page }) => {
    await openTerrainWorld(page)
    const before = {
      water: await countBlocks(page, 'water'),
      objectCells: await page.evaluate(() => window.__voxelWorld!.getObjectCellCount()),
    }
    // 手工挖掉一格地形(找一格 grass 挖成 air)
    const victim = await page.evaluate(() => {
      const probe = window.__voxelWorld!
      const size = window.__voxelEngine!.world!.doc.size
      for (let y = size.height - 1; y >= 0; y--) {
        for (let z = 0; z < size.depth; z++) {
          for (let x = 0; x < size.width; x++) {
            if (probe.getBlock(x, y, z) === 'grass') return { x, y, z }
          }
        }
      }
      return null
    })
    expect(victim).not.toBeNull()
    // 用既有编辑链路挖掉(经 __voxelPerf 之外的真实 controller 不可达,直接 regen 前后对比即可)
    const dug = await page.evaluate((v) => {
      const engine = window.__voxelEngine as unknown as {
        world: { setBlock(at: { x: number; y: number; z: number }, id: string): void }
      }
      engine.world.setBlock(v, 'air')
      return window.__voxelWorld!.getBlock(v.x, v.y, v.z)
    }, victim!)
    expect(dug).toBe('air')

    // 同种子重生成:地形恢复(含被挖格),河流仍在
    const regen = await page.evaluate(() => window.__voxelWorld!.regen({
      seed: 20260929,
      elevation: { amplitude: 5, scale: 24 },
      river: { enabled: true, width: 2 },
      lakes: { enabled: false },
      vegetation: { density: 0.05, trees: true, flowers: true, bushes: true },
    }))
    expect(regen.ok).toBe(true)
    const restored = await page.evaluate((v) => window.__voxelWorld!.getBlock(v.x, v.y, v.z), victim!)
    expect(restored).toBe('grass')
    // 物体格数量不变(建筑保留)
    expect(await page.evaluate(() => window.__voxelWorld!.getObjectCellCount())).toBe(before.objectCells)
    // 关河重生成:water 清零
    const dried = await page.evaluate(() => window.__voxelWorld!.regen({
      seed: 20260929,
      elevation: { amplitude: 5, scale: 24 },
      river: { enabled: false },
      lakes: { enabled: false },
      vegetation: { density: 0.05, trees: true, flowers: true, bushes: true },
    }))
    expect(dried.ok).toBe(true)
    expect(await countBlocks(page, 'water')).toBe(0)
    expect(await page.evaluate(() => window.__voxelWorld!.getObjectCellCount())).toBe(before.objectCells)
  })

  test('AC7/AC8 风格切换:预设即时生效,微调叠加', async ({ page }) => {
    await openTerrainWorld(page)
    expect((await page.evaluate(() => window.__voxelWorld!.getStyle()))?.preset).toBe('dusk-warm')
    const r1 = await page.evaluate(() => window.__voxelWorld!.setStyle({ preset: 'bright-pastoral' }))
    expect(r1.ok).toBe(true)
    await waitFrames(page, 2)
    expect((await page.evaluate(() => window.__voxelWorld!.getStyle()))?.preset).toBe('bright-pastoral')
    const r2 = await page.evaluate(() => window.__voxelWorld!.setStyle({ preset: 'misty-vale', tweaks: { fogDensity: 0.4 } }))
    expect(r2.ok).toBe(true)
    await waitFrames(page, 2)
    const style = await page.evaluate(() => window.__voxelWorld!.getStyle())
    expect(style?.preset).toBe('misty-vale')
    expect(style?.tweaks?.fogDensity).toBeCloseTo(0.4)
  })

  test('AC12 walkthrough:多时段多风格环绕截图 + 重生成前后对比', async ({ page }) => {
    await openTerrainWorld(page)
    // 相机对准主楼与河谷
    await page.evaluate(() => {
      const rig = window.__voxelEngine!.cameraRig as unknown as {
        orbit: { setTarget(t: { x: number; y: number; z: number }): void; theta: number; phi: number; distance: number }
      }
      rig.orbit.setTarget({ x: 24, y: 4, z: 24 })
      rig.orbit.theta = Math.PI * 0.25
      rig.orbit.phi = Math.PI * 0.3
      rig.orbit.distance = 40
    })
    await waitFrames(page, 2)
    await setTime(page, 0.5)
    await shot(page, '01-dusk-warm-noon')
    await setTime(page, 0.75)
    await shot(page, '02-dusk-warm-dusk')
    await setTime(page, 0.0)
    await shot(page, '03-dusk-warm-midnight')

    await setTime(page, 0.5)
    await page.evaluate(() => window.__voxelWorld!.setStyle({ preset: 'bright-pastoral' }))
    await waitFrames(page, 2)
    await shot(page, '04-bright-pastoral-noon')
    await page.evaluate(() => window.__voxelWorld!.setStyle({ preset: 'misty-vale', tweaks: { fogDensity: 0.4 } }))
    await waitFrames(page, 2)
    await shot(page, '05-misty-vale-noon')

    // 重生成前后对比(换种子)
    await page.evaluate(() => window.__voxelWorld!.setStyle({ preset: 'dusk-warm', tweaks: { exposure: 0.05 } }))
    await waitFrames(page, 2)
    await shot(page, '06-regen-before')
    await page.evaluate(() => window.__voxelWorld!.regen({
      seed: 777,
      elevation: { amplitude: 6, scale: 24 },
      river: { enabled: true, width: 3 },
      lakes: { enabled: true, size: 5 },
      vegetation: { density: 0.08, trees: true, flowers: true, bushes: true },
    }))
    await waitFrames(page, 3)
    await shot(page, '07-regen-after')
  })
})
