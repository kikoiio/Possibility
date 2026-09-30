import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

/**
 * S2a 资产仓库 · e2e 走查(AC4/AC5/AC6/AC8)。
 * ① 建筑 placement 渲染(AC6):fixture 文档含 bld-hut-a/bld-tower-a,实例化并截图
 * ② 植被回归(AC4/N1):地形 fixture 的全部 placements 都被实例化
 * ③ 清单 404 静默降级(AC4):世界正常显示、无资产
 * ④ prefers-reduced-motion(AC8/N5):摇摆静止(实例矩阵跨帧不变)
 */

const buildingDoc = readFileSync(new URL('./fixtures/voxel-assets-building.json', import.meta.url), 'utf8')

interface WorldProbe {
  getAssetPlacements(): Array<{ assetId: string }>
  getAssetInstanceCount(): number
}
interface EngineProbe {
  assets: {
    instanceCount: number
    groups: Map<string, { meshes: Array<{ instanceMatrix: { array: Float32Array } }> }>
  }
}

declare global {
  interface Window { __voxelWorld?: WorldProbe; __voxelEngine?: EngineProbe }
}

async function openDev(page: Page, init?: () => void, initArg?: unknown) {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(String(err)))
  if (init) await page.addInitScript(init, initArg)
  await page.goto('/dev/voxel')
  await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 15000 })
  await page.waitForTimeout(600)
  return errors
}

test.describe('S2a 资产仓库', () => {
  test('AC6:建筑 placement 实例化渲染(含多材质),截图目检', async ({ page }) => {
    const errors = await openDev(page, (doc) => {
      localStorage.setItem('voxel-dev-load', doc as string)
    }, buildingDoc)
    expect(errors).toEqual([])
    // hut + tower 各 1 实例
    expect(await page.evaluate(() => window.__voxelWorld!.getAssetInstanceCount())).toBe(2)
    // 多材质:hut 分组应含多个子网格 InstancedMesh(墙/顶/门/窗)
    const hutMeshes = await page.evaluate(() => window.__voxelEngine!.assets.groups.get('bld-hut-a')?.meshes.length ?? 0)
    expect(hutMeshes).toBeGreaterThan(1)
    await page.screenshot({ path: 'e2e/snapshots/s2a-building-placements.png' })
  })

  test('AC4/N1:地形 fixture 植被 placements 全部实例化', async ({ page }) => {
    const errors = await openDev(page, () => {
      try { localStorage.setItem('voxel-dev-fixture', 'terrain') } catch { /* ignore */ }
    })
    expect(errors).toEqual([])
    const [placements, instances] = await page.evaluate(() => [
      window.__voxelWorld!.getAssetPlacements(),
      window.__voxelWorld!.getAssetInstanceCount(),
    ] as const)
    expect(placements.length).toBeGreaterThan(0)
    expect(placements.some((p) => p.assetId === 'veg-tree-a')).toBe(true)
    expect(instances).toBe(placements.length)
  })

  test('AC4:清单 404 时静默降级,世界正常显示无资产', async ({ page }) => {
    await page.route('**/voxel-assets/library/manifest.json', (route) => route.fulfill({ status: 404, body: 'not found' }))
    const errors = await openDev(page, () => {
      try { localStorage.setItem('voxel-dev-fixture', 'terrain') } catch { /* ignore */ }
    })
    expect(errors).toEqual([])
    await expect(page.getByTestId('voxel-canvas')).toBeVisible()
    expect(await page.evaluate(() => window.__voxelWorld!.getAssetInstanceCount())).toBe(0)
    // 方块世界仍在(读取一个地面方块证明世界模型正常)
    expect(await page.evaluate(() => window.__voxelWorld!.getBlock(5, 0, 5))).not.toBe('air')
  })

  test('AC8/N5:prefers-reduced-motion 下植被摇摆静止', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors = await openDev(page, () => {
      try { localStorage.setItem('voxel-dev-fixture', 'terrain') } catch { /* ignore */ }
    })
    expect(errors).toEqual([])
    expect(await page.evaluate(() => window.__voxelWorld!.getAssetInstanceCount())).toBeGreaterThan(0)
    const sample = () => page.evaluate(() => {
      const group = window.__voxelEngine!.assets.groups.get('veg-tree-a')
      if (!group) return null
      return Array.from(group.meshes[0]!.instanceMatrix.array.slice(0, 16))
    })
    const first = await sample()
    expect(first).not.toBeNull()
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    }))
    const second = await sample()
    expect(second).toEqual(first)
  })
})
