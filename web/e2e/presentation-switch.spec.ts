import { expect, test } from '@playwright/test'
import { stubSplitApis } from './split-view-stubs'

test.describe.configure({ mode: 'serial', timeout: 180_000 })

test('single world switches 3D to native 2D and back without changing its timeline', async ({ page }) => {
  await stubSplitApis(page)
  await page.goto('/worlds/world-1?timeline=timeline-main&view=history-check')
  await expect(page.locator('[data-voxel-instance="main"] [data-testid="voxel-viewport-canvas"]')).toBeVisible({ timeout: 30_000 })

  await page.getByRole('group', { name: '世界画面表现' }).getByRole('button', { name: '2D' }).click()
  await expect(page).toHaveURL(/presentation=native2d/)
  await expect(page).toHaveURL(/view=history-check/)
  await expect(page.getByTestId('comparison-workspace')).toBeVisible()
  await expect(page.getByTestId('pane-facts-single')).toContainText('timeline-main')
  await expect(page.getByTestId('pane-facts-single')).toContainText('owner')
  await expect(page.getByTestId('pane-facts-single')).toContainText('2026-09-19T12:00:00.000Z')
  await expect(page.locator('[data-presentation="native2d"] canvas')).toBeVisible({ timeout: 30_000 })

  await page.getByRole('group', { name: '世界画面表现' }).getByRole('button', { name: '3D' }).click()
  await expect(page).toHaveURL(/presentation=voxel3d/)
  await expect(page).toHaveURL(/view=history-check/)
  await expect(page.locator('[data-voxel-instance="single"] [data-testid="voxel-viewport-canvas"]')).toBeVisible({ timeout: 30_000 })
  await expect(page).not.toHaveURL(/timeline=timeline-fork/)
  await expect(page.getByTestId('pane-facts-single')).toContainText('owner')
  await expect(page.getByTestId('pane-facts-single')).toContainText('2026-09-19T12:00:00.000Z')
})

test('browser preference restores on reload while explicit URL presentation takes precedence', async ({ page }) => {
  await stubSplitApis(page)
  await page.addInitScript(() => localStorage.setItem('possibility:presentation:preferred', JSON.stringify({
    formatVersion: 1,
    preferredPresentation: 'native2d',
    savedAt: Date.now(),
  })))

  await page.goto('/worlds/world-1?timeline=timeline-main')
  await expect(page.locator('[data-presentation="native2d"] canvas')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('pane-facts-single')).toContainText('timeline-main')
  await page.reload()
  await expect(page.locator('[data-presentation="native2d"] canvas')).toBeVisible({ timeout: 30_000 })

  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=voxel3d')
  await expect(page.locator('[data-voxel-instance="single"] [data-testid="voxel-viewport-canvas"]')).toBeVisible({ timeout: 30_000 })
  await page.reload()
  await expect(page.locator('[data-voxel-instance="single"] [data-testid="voxel-viewport-canvas"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('pane-facts-single')).toContainText('timeline-main')
})

test('3D camera restores from its world, timeline and presentation scope after reload', async ({ page }) => {
  await stubSplitApis(page)
  const pose = { theta: 1.25, phi: 0.8, distance: 88, target: { x: 4, y: 3, z: -2 } }
  await page.addInitScript(value => localStorage.setItem(
    'possibility:presentation:camera:["world-1","timeline-main","voxel3d"]',
    JSON.stringify({
      formatVersion: 1,
      worldId: 'world-1',
      timelineId: 'timeline-main',
      presentation: 'voxel3d',
      camera: { kind: 'voxel3d', version: 1, pose: value },
      savedAt: Date.now(),
    }),
  ), pose)
  const restoredTheta = async () => page.evaluate(() => {
    const engine = (window as unknown as {
      __voxelEngines?: Record<string, { world?: unknown; getOrbitPose(): { theta: number } | null }>
    }).__voxelEngines?.single
    return engine?.world ? engine.getOrbitPose()?.theta ?? null : null
  })

  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=voxel3d')
  await expect.poll(restoredTheta).toBeCloseTo(pose.theta, 2)
  await page.reload()
  await expect.poll(restoredTheta).toBeCloseTo(pose.theta, 2)
})

test('2D camera restores after refresh and stays scoped to each timeline and presentation', async ({ page }) => {
  await stubSplitApis(page)
  const mainCamera = { pan: { x: 71, y: -33 }, zoom: 1.4 }
  const forkCamera = { pan: { x: -24, y: 56 }, zoom: 0.8 }
  await page.addInitScript(({ main, fork }) => {
    const key = (timeline: string, presentation: string) =>
      `possibility:presentation:camera:${JSON.stringify(['world-1', timeline, presentation])}`
    const record = (timeline: string, presentation: 'native2d' | 'voxel3d', camera: unknown) => ({
      formatVersion: 1, worldId: 'world-1', timelineId: timeline, presentation,
      camera: presentation === 'native2d'
        ? { kind: presentation, version: 1, camera }
        : { kind: presentation, version: 1, pose: camera },
      savedAt: Date.now(),
    })
    localStorage.setItem(key('timeline-main', 'native2d'), JSON.stringify(record('timeline-main', 'native2d', main)))
    localStorage.setItem(key('timeline-fork', 'native2d'), JSON.stringify(record('timeline-fork', 'native2d', fork)))
    localStorage.setItem(key('timeline-main', 'voxel3d'), JSON.stringify(record('timeline-main', 'voxel3d', {
      theta: 2.2, phi: 0.9, distance: 70, target: { x: 2, y: 1, z: -3 },
    })))
  }, { main: mainCamera, fork: forkCamera })

  const host = page.getByTestId('presentation-host-single')
  const view = host.locator('[data-presentation]')
  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=native2d')
  await expect(host.locator('[data-presentation="native2d"] canvas')).toBeVisible({ timeout: 30_000 })
  await expect(host).toHaveAttribute('data-camera-state', JSON.stringify({ kind: 'native2d', version: 1, camera: mainCamera }))

  await page.getByLabel('single时间线').selectOption('timeline-fork')
  await expect(page).toHaveURL(/timeline=timeline-fork/)
  await expect(host).toHaveAttribute('data-camera-state', JSON.stringify({ kind: 'native2d', version: 1, camera: forkCamera }))
  await page.reload()
  await expect(host.locator('[data-presentation="native2d"] canvas')).toBeVisible({ timeout: 30_000 })
  await expect(host).toHaveAttribute('data-camera-state', JSON.stringify({ kind: 'native2d', version: 1, camera: forkCamera }))

  await page.getByRole('group', { name: '世界画面表现' }).getByRole('button', { name: '3D' }).click()
  await expect(view).toHaveAttribute('data-presentation', 'voxel3d')
  await expect(host).toHaveAttribute('data-camera-state', /"kind":"voxel3d"/)
  await page.getByRole('group', { name: '世界画面表现' }).getByRole('button', { name: '2D' }).click()
  await expect(view).toHaveAttribute('data-presentation', 'native2d')
  await expect(host).toHaveAttribute('data-camera-state', JSON.stringify({ kind: 'native2d', version: 1, camera: forkCamera }))
})

test('unavailable browser storage does not prevent the requested world from opening', async ({ page }) => {
  await stubSplitApis(page)
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    Storage.prototype.getItem = function (key) {
      if (key.startsWith('possibility:presentation:')) throw new DOMException('Storage blocked', 'SecurityError')
      return getItem.call(this, key)
    }
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('possibility:presentation:')) throw new DOMException('Storage blocked', 'SecurityError')
      return setItem.call(this, key, value)
    }
  })
  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=native2d')
  await expect(page.getByTestId('pane-facts-single')).toContainText('timeline-main')
  await expect(page.locator('[data-testid="presentation-host-single"] [data-presentation="native2d"] canvas')).toBeVisible({ timeout: 30_000 })
})

test('corrupt preference and camera records fall back to a usable 2D viewport', async ({ page }) => {
  await stubSplitApis(page)
  await page.addInitScript(() => {
    localStorage.setItem('possibility:presentation:preferred', '{not-json')
    localStorage.setItem('possibility:presentation:camera:["world-1","timeline-main","native2d"]', JSON.stringify({
      formatVersion: 1, worldId: 'world-1', timelineId: 'timeline-main', presentation: 'native2d',
      camera: { kind: 'native2d', version: 1, camera: { pan: { x: 'bad', y: 2 }, zoom: -1 } }, savedAt: Date.now(),
    }))
  })
  await page.goto('/worlds/world-1?timeline=timeline-main&presentation=native2d')
  await expect(page.getByTestId('pane-facts-single')).toContainText('timeline-main')
  await expect(page.locator('[data-testid="presentation-host-single"] [data-presentation="native2d"] canvas')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('presentation-host-single')).toHaveAttribute('data-camera-state', /"kind":"native2d"/)
  const camera = JSON.parse((await page.getByTestId('presentation-host-single').getAttribute('data-camera-state'))!)
  expect(camera.camera.pan.x).not.toBe('bad')
  expect(camera.camera.zoom).toBeGreaterThan(0)
})
