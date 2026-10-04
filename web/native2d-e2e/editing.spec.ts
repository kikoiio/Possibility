import { test, expect, type Browser } from '@playwright/test'
import {
  TESTIDS,
  assertReadOnlyApiRequests,
  createApiRequestRecorder,
  createIsolatedSampleContext,
  getObjectClickPoint,
  installPublicApiStub,
  publicDayResponse,
  readLocalStorage,
  readDiagnostics,
  seedLocalStorage,
} from './fixtures'

async function openEditing(browser: Browser) {
  const { page, context } = await createIsolatedSampleContext(browser)
  await page.goto('/dev/native-2d')
  await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
  await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(0)
  return { page, context }
}

async function dragObject(page: import('@playwright/test').Page, objectId: string, dx: number, dy: number) {
  await page.getByTestId(TESTIDS.viewportHost).scrollIntoViewIfNeeded()
  const start = await getObjectClickPoint(page, objectId)
  if (!start) throw new Error(`missing object ${objectId}`)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 20, start.y + 20, { steps: 2 })
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 })
  await page.mouse.up()
}

async function dragViewport(page: import('@playwright/test').Page, dx: number, dy: number) {
  const box = await page.getByTestId(TESTIDS.viewportHost).boundingBox()
  if (!box) throw new Error('viewport host is not visible')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 8 })
  await page.mouse.up()
}

test.describe('N2D1 desktop local layout', () => {
  test('previews invalid moves, applies a legal move, then undoes it', async ({ browser }) => {
    const { page, context } = await openEditing(browser)
    const recorder = createApiRequestRecorder(page)
    try {
      await page.getByTestId(TESTIDS.buildingList).selectOption('gatehouse')
      await page.getByTestId(TESTIDS.moveStart).click()
      await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('拖动建筑')
      await dragObject(page, 'building:gatehouse', -500, 0)
      await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('不可用')
      await page.getByTestId(TESTIDS.moveCancel).click()
      await expect(page.getByTestId(TESTIDS.moveStatus)).toHaveCount(0)

      await page.getByTestId(TESTIDS.moveStart).click()
      await dragObject(page, 'building:gatehouse', 44, 22)
      await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('可应用')
      await page.getByTestId(TESTIDS.moveApply).click()
      await expect(page.getByTestId(TESTIDS.undo)).toBeEnabled()
      const saved = await readLocalStorage(page)
      expect(Object.keys(saved).some((key) => key.startsWith('possibility.native2d.layout.v1:'))).toBe(true)
      await page.getByTestId(TESTIDS.undo).click()
      await expect(page.getByTestId(TESTIDS.undo)).toBeDisabled()

      // 温室也能独立移动；从 z=2 向可放置的西南格移动一格。
      await page.getByTestId(TESTIDS.buildingList).selectOption('greenhouse')
      await page.getByTestId(TESTIDS.moveStart).click()
      await dragObject(page, 'building:greenhouse', -43, 22)
      await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('可应用')
      await page.getByTestId(TESTIDS.moveApply).click()
      await expect(page.getByTestId(TESTIDS.undo)).toBeEnabled()
      await page.getByTestId(TESTIDS.undo).click()

      // 移动主楼后仍使用同一大厅入口，并在刷新后恢复布局但不恢复会话撤销栈。
      await page.getByTestId(TESTIDS.buildingList).selectOption('main-house')
      await page.getByTestId(TESTIDS.moveStart).click()
      await dragObject(page, 'building:main-house', -29, 14)
      await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('可应用')
      await page.getByTestId(TESTIDS.moveApply).click()
      await page.getByTestId(TESTIDS.hallEnter).click()
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('主楼 · 大厅')
      await page.getByTestId(TESTIDS.hallExit).click()
      const storedBeforeReload = await readLocalStorage(page)
      await page.reload()
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
      await expect(page.getByTestId(TESTIDS.undo)).toBeDisabled()
      expect(await readLocalStorage(page)).toEqual(storedBeforeReload)
      assertReadOnlyApiRequests(recorder.records())
    } finally {
      recorder.stop()
      await context.close()
    }
  })

  test('samples render feedback during a building move preview', async ({ browser }) => {
    const { page, context } = await openEditing(browser)
    try {
      const before = await readDiagnostics(page)
      await page.getByTestId(TESTIDS.buildingList).selectOption('gatehouse')
      await page.getByTestId(TESTIDS.moveStart).click()
      const startedAt = performance.now()
      await dragObject(page, 'building:gatehouse', 44, 22)
      const elapsedMs = performance.now() - startedAt
      await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('可应用')
      await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(before?.drawCount ?? 0)
      const after = await readDiagnostics(page)
      console.log(JSON.stringify({
        sample: 'building-move-preview',
        renderer: after?.renderer,
        resolution: after?.resolution,
        viewport: [after?.width, after?.height],
        drawDelta: (after?.drawCount ?? 0) - (before?.drawCount ?? 0),
        elapsedMs: Math.round(elapsedMs),
        lastRenderMs: after?.lastRenderMs,
      }))
    } finally {
      await context.close()
    }
  })

  test('keeps facts unchanged while reset confirmation is explicit', async ({ browser }) => {
    const { page, context } = await openEditing(browser)
    try {
      await expect(page.getByTestId(TESTIDS.residentList).locator('button').first()).toBeVisible()
      const before = await page.getByTestId(TESTIDS.residentList).innerText()
      await page.getByTestId(TESTIDS.reset).click()
      await expect(page.getByTestId(TESTIDS.resetConfirm)).toBeVisible()
      await page.getByTestId(TESTIDS.resetCancel).click()
      await expect(page.getByTestId(TESTIDS.resetConfirm)).toHaveCount(0)
      await page.getByTestId(TESTIDS.reset).click()
      await page.getByTestId(TESTIDS.resetConfirm).click()
      await expect(page.getByTestId(TESTIDS.residentList).innerText()).resolves.toBe(before)
    } finally {
      await context.close()
    }
  })

  test('keeps public layout storage isolated from fixture scope', async ({ browser }) => {
    const { page, context } = await openEditing(browser)
    await installPublicApiStub(page, { worlds: [{ kind: 'json', body: publicDayResponse() }] })
    try {
      const before = await readLocalStorage(page)
      await page.getByTestId(TESTIDS.sourceKindPublic).click()
      await page.getByTestId(TESTIDS.sourceApply).click()
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText('公开只读')
      const after = await readLocalStorage(page)
      expect(Object.keys(after).length).toBeGreaterThanOrEqual(Object.keys(before).length)
    } finally {
      await context.close()
    }
  })

  test('keeps damaged and incompatible records until an explicit recovery choice', async ({ browser }) => {
    const key = 'possibility.native2d.layout.v1:["fixture","fixture-world-mist-manor","fixture-timeline-mist-manor-001","mist-manor"]'
    const records = [
      '{not-json',
      JSON.stringify({
        formatVersion: 99,
        sceneVersion: 1,
        scope: {
          source: 'fixture',
          worldId: 'fixture-world-mist-manor',
          timelineId: 'fixture-timeline-mist-manor-001',
          sceneId: 'mist-manor',
          sceneVersion: 1,
        },
        placements: [],
        savedAt: '2026-10-04T00:00:00.000Z',
      }),
    ]

    for (const record of records) {
      const { page, context } = await createIsolatedSampleContext(browser)
      await seedLocalStorage(page, { [key]: record })
      try {
        await page.goto('/dev/native-2d')
        await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
        await expect(page.getByTestId(TESTIDS.restoreStatus)).toBeVisible()
        await expect(page.getByTestId(TESTIDS.moveStart)).toBeDisabled()
        expect(await readLocalStorage(page)).toEqual({ [key]: record })
        await page.getByTestId(TESTIDS.restoreReset).click()
        await expect(page.getByTestId(TESTIDS.resetConfirm)).toBeVisible()
        expect(await readLocalStorage(page)).toEqual({ [key]: record })
        await page.getByTestId(TESTIDS.resetConfirm).click()
        await expect(page.getByTestId(TESTIDS.restoreStatus)).toHaveCount(0)
        expect(await readLocalStorage(page)).toEqual({})
      } finally {
        await context.close()
      }
    }
  })

  test('retains an applied layout after a quota failure and saves on retry', async ({ browser }) => {
    const { page, context } = await createIsolatedSampleContext(browser)
    await page.addInitScript(() => {
      const mutableWindow = window as Window & { __native2dAllowLayoutSave?: boolean }
      const nativeSetItem = Storage.prototype.setItem
      mutableWindow.__native2dAllowLayoutSave = false
      Storage.prototype.setItem = function (key: string, value: string): void {
        if (key.startsWith('possibility.native2d.layout.v1:') && !mutableWindow.__native2dAllowLayoutSave) {
          throw new DOMException('storage quota reached', 'QuotaExceededError')
        }
        nativeSetItem.call(this, key, value)
      }
    })
    try {
      await page.goto('/dev/native-2d')
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
      await page.getByTestId(TESTIDS.buildingList).selectOption('gatehouse')
      await page.getByTestId(TESTIDS.moveStart).click()
      await dragObject(page, 'building:gatehouse', 44, 22)
      await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('可应用')
      await page.getByTestId(TESTIDS.moveApply).click()
      await expect(page.getByTestId(TESTIDS.saveStatus)).toContainText('storage quota reached')
      await expect(page.getByTestId(TESTIDS.saveRetry)).toBeVisible()
      await expect(page.getByTestId(TESTIDS.undo)).toBeEnabled()
      await page.evaluate(() => { (window as Window & { __native2dAllowLayoutSave?: boolean }).__native2dAllowLayoutSave = true })
      await page.getByTestId(TESTIDS.saveRetry).click()
      await expect(page.getByTestId(TESTIDS.saveStatus)).toHaveText('布局仅保存在此浏览器')
      await page.reload()
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
      await expect(page.getByTestId(TESTIDS.undo)).toBeDisabled()
      expect(Object.keys(await readLocalStorage(page))).toContain('possibility.native2d.layout.v1:["fixture","fixture-world-mist-manor","fixture-timeline-mist-manor-001","mist-manor"]')
    } finally {
      await context.close()
    }
  })

  test('recovers from a missing texture and keeps the viewport usable', async ({ browser }) => {
    const { page, context } = await createIsolatedSampleContext(browser)
    await page.route('**/native2d/mist-manor/**/*.png', (route) => route.abort())
    try {
      await page.goto('/dev/native-2d')
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
      await expect(page.getByTestId(TESTIDS.assetError)).toBeVisible()
      await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(0)
      await page.unroute('**/native2d/mist-manor/**/*.png')
      await page.getByTestId(TESTIDS.assetRetry).click()
      await expect(page.getByTestId(TESTIDS.assetError)).toHaveCount(0)
      await page.getByTestId(TESTIDS.overview).click()
      await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(1)
    } finally {
      await context.close()
    }
  })

  test('retries a renderer initialization failure without losing loaded facts', async ({ browser }) => {
    const { page, context } = await createIsolatedSampleContext(browser)
    await page.addInitScript(() => {
      const target = window as typeof window & { __failNative2dRenderer?: boolean }
      target.__failNative2dRenderer = true
      const prototype = HTMLCanvasElement.prototype
      const original = prototype.getContext
      Object.defineProperty(prototype, 'getContext', {
        configurable: true,
        value: function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
          if (target.__failNative2dRenderer && (type.startsWith('webgl') || type === '2d')) return null
          return Reflect.apply(original, this, [type, ...args])
        },
      })
    })
    try {
      await page.goto('/dev/native-2d')
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
      await expect(page.getByTestId(TESTIDS.viewportError)).toBeVisible()
      await expect(page.getByTestId(TESTIDS.residentList).locator('button').first()).toHaveCount(1)
      await page.evaluate(() => {
        ;(window as typeof window & { __failNative2dRenderer?: boolean }).__failNative2dRenderer = false
      })
      await page.getByTestId(TESTIDS.viewportRetry).click()
      await expect(page.getByTestId(TESTIDS.viewportError)).toHaveCount(0)
      await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(0)
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('庄园外景')
    } finally {
      await context.close()
    }
  })

  test('cleans up diagnostics on route changes and rebuilds after resize and re-entry', async ({ browser }) => {
    const { page, context } = await createIsolatedSampleContext(browser, { viewport: { width: 1280, height: 720 } })
    try {
      await page.goto('/dev/native-2d')
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
      await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(0)

      for (const size of [{ width: 1100, height: 760 }, { width: 1280, height: 720 }]) {
        await page.setViewportSize(size)
        await expect.poll(async () => (await readDiagnostics(page))?.width ?? 0).toBeGreaterThan(0)
        await page.evaluate(() => {
          window.history.pushState({}, '', '/dev/asset-shot')
          window.dispatchEvent(new PopStateEvent('popstate'))
        })
        await expect(page.getByTestId(TESTIDS.viewportHost)).toHaveCount(0)
        await expect.poll(() => page.evaluate(() => window.__native2dDiagnostics)).toBeUndefined()
        await page.evaluate(() => {
          window.history.pushState({}, '', '/dev/native-2d')
          window.dispatchEvent(new PopStateEvent('popstate'))
        })
        await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
        await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(0)
        await expect(page.getByTestId(TESTIDS.viewportHost).locator('canvas')).toHaveCount(1)
      }
    } finally {
      await context.close()
    }
  })
})
