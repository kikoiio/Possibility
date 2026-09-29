import { expect, test, type Page } from '@playwright/test'

interface EngineProbe {
  world: { doc: { sections: Record<string, unknown> } } | null
  cameraRig: { camera: unknown }
  renderer: { scene: { children: unknown[] } }
}

declare global {
  interface Window { __voxelEngine?: EngineProbe }
}

async function probe(page: Page) {
  return page.evaluate(() => {
    const engine = window.__voxelEngine
    if (!engine?.world) return null
    return {
      sections: Object.keys(engine.world.doc.sections).length,
      meshes: engine.renderer.scene.children.length,
    }
  })
}

test.describe('voxel dev harness', () => {
  test('loads fixture world and renders sections (AC5 雏形)', async ({ page }) => {
    await page.goto('/dev/voxel')
    await expect(page.getByTestId('voxel-canvas')).toBeVisible()
    await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 15000 })
    const state = await probe(page)
    expect(state).not.toBeNull()
    expect(state!.sections).toBeGreaterThan(0)
    expect(state!.meshes).toBeGreaterThan(0)
    await page.screenshot({ path: 'e2e/snapshots/voxel-dev-fixture.png' })
  })

  test('camera orbits on drag', async ({ page }) => {
    await page.goto('/dev/voxel')
    await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 15000 })
    const before = await page.evaluate(() => JSON.stringify(window.__voxelEngine!.cameraRig.camera.position))
    const canvas = page.getByTestId('voxel-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 10 })
    await page.mouse.up()
    const after = await page.evaluate(() => JSON.stringify(window.__voxelEngine!.cameraRig.camera.position))
    expect(after).not.toBe(before)
  })
})
