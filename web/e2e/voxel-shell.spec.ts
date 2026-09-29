import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const voxelDocument = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))

const snapshot = {
  world: { id: 'world-1', name: '雾影庄', description: '体素世界', status: 'running', pauseReason: null, isDemo: false, callsToday: 0, locations: [{ name: '主楼', description: '庄园主楼' }] },
  timelines: [{ id: 'timeline-main', parentTimelineId: null, simNow: '2026-09-29T14:00:00.000Z' }],
  currentTimelineId: 'timeline-main', simNow: '2026-09-29T14:00:00.000Z', stateVersion: 1, worldModelVersion: 1,
  evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [],
  locationBoard: [{ location: '主楼', persons: [{ id: 'person-1', name: '小夜', activity: '读书' }] }],
  events: [],
}

function stubShellApis(page: import('@playwright/test').Page) {
  return Promise.all([
    page.addInitScript(() => {
      localStorage.setItem('possibility_token', 'e2e-token')
      localStorage.setItem('possibility:flag:voxel', '1')
    }),
    page.route('**/api/worlds', (route) => route.fulfill({ json: { worlds: [{ id: 'world-1', name: '雾影庄' }] } })),
    page.route('**/api/worlds/world-1/stream**', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' })),
    page.route('**/api/worlds/world-1/map/bootstrap**', (route) => route.fulfill({
      json: {
        access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
        world: snapshot,
        scene: { status: 'ready', document: voxelDocument },
        presentation: { timelineId: 'timeline-main', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
        theme: { id: 'mist-manor', assetVersion: 'e2e' },
        resume: { worldId: 'world-1', timelineId: 'timeline-main', spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow },
      },
    })),
    page.route('**/api/worlds/world-1/map/resume', (route) => route.fulfill({ json: { ok: true } })),
    // 拖慢图集请求，让加载进度可被断言（N4）
    page.route('**/voxel-assets/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700))
      return route.fulfill({ status: 404, body: 'not found' })
    }),
  ])
}

test.describe('voxel shell integration (T30, AC5)', () => {
  test('flag on: scene page mounts voxel viewport with staged loading progress', async ({ page }) => {
    await stubShellApis(page)
    await page.goto('/worlds/world-1')

    // N4：分阶段进度反馈可见，随后消失
    await expect(page.getByTestId('voxel-viewport-loading')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('voxel-viewport-progress')).toContainText('图集')
    await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })

    // 体素视口挂载，2D 画布不在
    await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible()
    await expect(page.getByTestId('world-canvas')).toBeHidden()

    // AC5：世界已加载并完成初始构图（场景网格存在、相机已 fit）
    const probe = await page.evaluate(() => {
      const engine = window.__voxelEngine as never as {
        world: { doc: { sections: Record<string, unknown> } } | null
        renderer: { scene: { children: unknown[] } }
      } | undefined
      return engine?.world ? { sections: Object.keys(engine.world.doc.sections).length, meshes: engine.renderer.scene.children.length } : null
    })
    expect(probe).not.toBeNull()
    expect(probe!.sections).toBeGreaterThan(0)
    expect(probe!.meshes).toBeGreaterThan(0)
  })
})
