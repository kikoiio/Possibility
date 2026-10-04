import { test, expect, type Page } from '@playwright/test'
import { TESTIDS, createIsolatedSampleContext, getObjectClickPoint, readDiagnostics, readLocalStorage } from './fixtures'
import { ASSET_MANIFEST } from '../src/native2d/assets'

async function ready(page: Page) {
  await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
  await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(0)
}

async function capture(page: Page, name: string) {
  // Screenshot readiness includes image decoding and the resulting Pixi redraw.
  await page.waitForLoadState('networkidle')
  await page.evaluate(async () => { for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame) })
  const path = `/tmp/native2d-final-evidence/${name}.png`
  await page.screenshot({ path, fullPage: true })
  await test.info().attach(name, { path, contentType: 'image/png' })
}

async function inspectLayers(page: Page) {
  return page.evaluate(() => {
    const applications = (window as unknown as { __native2dVisualApplications: { canvas: HTMLCanvasElement; renderer: unknown; stage: { children: { children: { label: string; alpha: number; zIndex: number; x: number; y: number }[] }[] } | null }[] }).__native2dVisualApplications
    const app = applications.find((item) => item.stage && item.renderer && item.canvas.isConnected)
    if (!app?.stage) return []
    return app.stage.children[0].children.map(({ label, alpha, zIndex, x, y }) => ({ label, alpha, zIndex, x, y }))
  })
}

async function observeRenderer(page: Page) {
  await page.route('**/src/native2d/viewport.ts*', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, body: `${await response.text()}\n
      const visualInit = Application.prototype.init;
      Application.prototype.init = async function (...args) {
        await visualInit.apply(this, args);
        (window.__native2dVisualApplications ??= []).push(this);
      };
    ` })
  })
}

async function drag(page: Page, id: string, gridDx: number, gridDz: number) {
  await page.getByTestId(TESTIDS.viewportHost).scrollIntoViewIfNeeded()
  const point = await getObjectClickPoint(page, `building:${id}`)
  const bounds = (await readDiagnostics(page))?.objectBounds[`building:${id}`]
  if (!point || !bounds) throw new Error(`missing building ${id}`)
  const zoom = bounds.width / ASSET_MANIFEST[id].layers[0].pixelWidth
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + (gridDx - gridDz) * 32 * zoom, point.y + (gridDx + gridDz) * 16 * zoom, { steps: 10 })
  await page.mouse.up()
}

test('keeps day and night exterior, hall, resident highlights and move feedback readable', async ({ browser }) => {
  const { page, context } = await createIsolatedSampleContext(browser)
  await observeRenderer(page)
  try {
    await page.goto('/dev/native-2d')
    await ready(page)
    for (const [fixture, period, residentId, hour] of [
      ['mist-manor-day', 'day', 'person-mugino-toru', '13:00'],
      ['mist-manor-night', 'night', 'person-sayo', '23:00'],
    ] as const) {
      await page.getByTestId(TESTIDS.sourceFixtureSelect).selectOption(fixture)
      await page.getByTestId(TESTIDS.sourceApply).click()
      await ready(page)
      await expect(page.getByTestId(TESTIDS.worldTime)).toContainText(hour)
      await capture(page, `${period}-exterior`)
      if (period === 'day') {
        const layers = await inspectLayers(page)
        expect(layers.some((layer) => layer.label?.endsWith(':highlight'))).toBe(false)
        const backdrop = layers.find((layer) => layer.label === 'ground-backdrop')
        expect(layers.filter((layer) => layer.label?.startsWith('decoration:path-road-')).every((layer) => layer.zIndex > backdrop!.zIndex)).toBe(true)
        await page.getByTestId('native2d-resident-person-shirakawa-rei').click()
        await expect.poll(async () => (await inspectLayers(page)).some((layer) => layer.label?.includes('tree-') && layer.label.endsWith(':occluder') && layer.alpha === 0.35)).toBe(true)
        await capture(page, 'day-exterior-selected')
      }
      await page.getByTestId(TESTIDS.hallEnter).click()
      await page.getByTestId(`native2d-resident-${residentId}`).click()
      await expect.poll(async () => (await inspectLayers(page)).find((layer) => layer.label === 'decoration:hall-wall:occluder')?.alpha).toBe(0.35)
      const layers = await inspectLayers(page)
      const highlight = layers.find((layer) => layer.label === `resident:${residentId}:highlight`)
      expect(highlight?.zIndex).toBeGreaterThan(Math.max(...layers.filter((layer) => !layer.label?.endsWith(':highlight')).map((layer) => layer.zIndex)))
      await capture(page, `${period}-hall-selected`)
      await page.getByTestId('native2d-location-大厅').click()
      await expect.poll(async () => (await inspectLayers(page)).find((layer) => layer.label === 'decoration:hall-wall:occluder')?.alpha).toBe(1)
      await page.getByTestId(TESTIDS.hallExit).click()
      if (period === 'day') {
        await page.getByTestId(TESTIDS.buildingList).selectOption('gatehouse')
        await page.getByTestId(TESTIDS.moveStart).click()
        await drag(page, 'gatehouse', 1, 0)
        await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('可应用')
        await capture(page, 'day-legal-preview')
        await page.getByTestId(TESTIDS.moveCancel).click()
        await page.getByTestId(TESTIDS.moveStart).click()
        await drag(page, 'gatehouse', -15, 0)
        await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('不可用')
        await expect(page.getByTestId(TESTIDS.moveApply)).toBeDisabled()
        await capture(page, 'day-invalid-preview')
        await page.getByTestId(TESTIDS.moveCancel).click()
      }
    }
    await page.getByTestId(TESTIDS.buildingList).selectOption('gatehouse')
    await page.getByTestId(TESTIDS.moveStart).click()
    await drag(page, 'gatehouse', 1, 0)
    await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('可应用')
    await capture(page, 'night-legal-preview')
    const previewLayers = await inspectLayers(page)
    expect(previewLayers.find((layer) => layer.label === 'move-preview')?.zIndex).toBeGreaterThan(1000)
    expect(previewLayers.some((layer) => layer.label === 'move-candidate')).toBe(true)
    await page.getByTestId(TESTIDS.moveCancel).click()
    await page.getByTestId(TESTIDS.moveStart).click()
    await drag(page, 'gatehouse', -15, 0)
    await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('不可用')
    await expect(page.getByTestId(TESTIDS.conflictReasons)).toBeVisible()
    await expect(page.getByTestId(TESTIDS.moveApply)).toBeDisabled()
    await capture(page, 'night-invalid-preview')
  } finally { await context.close() }
})

test('picks residents, locations and buildings with current camera coordinates and fits full bounds', async ({ browser }) => {
  const { page, context } = await createIsolatedSampleContext(browser, { hasTouch: true })
  try {
    await page.goto('/dev/native-2d')
    await ready(page)
    const unchanged = await readLocalStorage(page)
    const client = await context.newCDPSession(page)
    try {
      for (const transformed of [false, true]) {
        if (transformed) {
          const box = await page.getByTestId(TESTIDS.viewportHost).boundingBox()
          if (!box) throw new Error('missing viewport')
          const x = box.x + box.width / 2
          const y = box.y + box.height / 2
          await page.mouse.move(x, y)
          await page.mouse.down()
          await page.mouse.move(x + 45, y - 40, { steps: 6 })
          await page.mouse.up()
          const beforeZoom = (await readDiagnostics(page))?.objectBounds['building:main-house'].width ?? 0
          await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 30, y, id: 1 }, { x: x + 30, y, id: 2 }] })
          await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 36, y, id: 1 }, { x: x + 36, y, id: 2 }] })
          await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          await expect.poll(async () => (await readDiagnostics(page))?.objectBounds['building:main-house'].width ?? 0).toBeGreaterThan(beforeZoom)
        }
        for (const [id, kind] of [['building:gatehouse', 'building'], ['resident:person-shirakawa-rei', 'resident'], ['location:hill-path', 'location']] as const) {
          const point = await getObjectClickPoint(page, id)
          if (!point) throw new Error(`missing ${id}`)
          await page.mouse.click(point.x, point.y)
          if (kind === 'building') await expect(page.getByText('BUILDING RECORD', { exact: true })).toHaveCount(1)
          if (kind === 'resident') await expect(page.getByTestId(TESTIDS.residentCardName)).toHaveText('白川 怜')
          if (kind === 'location') await expect(page.getByTestId(TESTIDS.locationCard)).toContainText('后山散步道')
        }
      }
    } finally { await client.detach() }
    expect(await readLocalStorage(page)).toEqual(unchanged)
    await page.getByTestId(TESTIDS.overview).click()
    await expect.poll(async () => {
      const diagnostics = await readDiagnostics(page)
      if (!diagnostics) return false
      return ['main-house', 'greenhouse', 'gatehouse'].every((id) => {
        const bounds = diagnostics.objectBounds[`building:${id}`]
        return bounds && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= diagnostics.width + 1 && bounds.y + bounds.height <= diagnostics.height + 1
      })
    }).toBe(true)
  } finally { await context.close() }
})

test('moves three independent building layers without leaving old sprites and retains the main hall binding', async ({ browser }) => {
  const { page, context } = await createIsolatedSampleContext(browser)
  await observeRenderer(page)
  try {
    await page.goto('/dev/native-2d')
    await ready(page)
    await capture(page, 'buildings-before-moves')
    for (const [id, dx, dz] of [['gatehouse', 1, 0], ['greenhouse', 0, 1], ['main-house', 0, 1]] as const) {
      await page.getByTestId(TESTIDS.buildingList).selectOption(id)
      await page.getByTestId(TESTIDS.moveStart).click()
      await expect.poll(async () => (await inspectLayers(page)).some((layer) => layer.label === `building:${id}:highlight`)).toBe(true)
      const before = (await inspectLayers(page)).filter((layer) => layer.label?.startsWith(`building:${id}:`) && !layer.label.endsWith(':highlight'))
      const stored = await readLocalStorage(page)
      await drag(page, id, dx, dz)
      await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('可应用')
      expect(await readLocalStorage(page)).toEqual(stored)
      await page.getByTestId(TESTIDS.moveApply).click()
      await expect.poll(async () => (await inspectLayers(page)).filter((layer) => layer.label?.startsWith(`building:${id}:`) && !layer.label.endsWith(':highlight'))).toEqual(before.map((layer) => ({ ...layer, x: layer.x + (dx - dz) * 32, y: layer.y + (dx + dz) * 16, zIndex: layer.zIndex + (dx + dz) * 10 })))
      await capture(page, `${id}-moved`)
      if (id === 'main-house') {
        const point = await getObjectClickPoint(page, 'building:main-house')
        if (!point) throw new Error('missing moved main house')
        await page.mouse.click(point.x, point.y)
        await expect(page.getByText('BUILDING RECORD', { exact: true })).toHaveCount(1)
        await page.getByTestId(TESTIDS.hallEnter).click()
        await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('主楼 · 大厅')
        for (const name of ['书房', '餐厅', '图书室']) {
          await page.getByTestId(`native2d-location-${name}`).click()
          await expect(page.getByTestId(TESTIDS.locationCard)).toContainText(name)
          await expect(page.getByTestId(`native2d-location-${name}`)).toContainText('未提供室内')
        }
        await page.getByTestId(TESTIDS.hallExit).click()
      }
      await page.getByTestId(TESTIDS.undo).click()
    }
  } finally { await context.close() }
})
