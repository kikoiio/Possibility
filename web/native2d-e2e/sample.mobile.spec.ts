import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import {
  TESTIDS,
  createApiRequestRecorder,
  createIsolatedSampleContext,
  getObjectClickPoint,
  readDiagnostics,
  readLocalStorage,
} from './fixtures'

async function touchDrag(context: BrowserContext, page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const client = await context.newCDPSession(page)
  try {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + 20, y: from.y + 8, id: 1 }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: to.x, y: to.y, id: 1 }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await client.detach()
  }
}

async function dragObjectByTouch(context: BrowserContext, page: Page, objectId: string, dx: number, dy: number): Promise<void> {
  await page.getByTestId(TESTIDS.viewportHost).scrollIntoViewIfNeeded()
  const from = await getObjectClickPoint(page, objectId)
  if (!from) throw new Error(`missing object ${objectId}`)
  await touchDrag(context, page, from, { x: from.x + dx, y: from.y + dy })
}

async function touchPinch(context: BrowserContext, page: Page, expanding = true): Promise<void> {
  const box = await page.getByTestId(TESTIDS.viewportHost).boundingBox()
  if (!box) throw new Error('viewport host is not visible')
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const client = await context.newCDPSession(page)
  const near = expanding ? 26 : 50
  const far = expanding ? 50 : 26
  try {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: center.x - near, y: center.y, id: 1 },
        { x: center.x + near, y: center.y, id: 2 },
      ],
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: center.x - far, y: center.y, id: 1 },
        { x: center.x + far, y: center.y, id: 2 },
      ],
    })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await client.detach()
  }
}

test.describe('N2D1 mobile sample', () => {
  test('keeps controls reachable and supports touch selection and panels', async ({ browser }) => {
    const { page, context } = await createIsolatedSampleContext(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    })
    const recorder = createApiRequestRecorder(page)
    try {
      await page.goto('/dev/native-2d')
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
      await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(0)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
      await page.screenshot({ path: '/tmp/native2d-playwright-results/native2d-mobile-review.png', fullPage: true })

      const beforePinch = await readDiagnostics(page)
      const beforeWidth = beforePinch?.objectBounds['building:main-house']?.width ?? 0
      await touchPinch(context, page)
      await expect.poll(async () => (await readDiagnostics(page))?.objectBounds['building:main-house']?.width ?? 0).toBeGreaterThan(beforeWidth * 1.2)
      await touchPinch(context, page, false)

      await page.getByTestId(TESTIDS.panelToggle).click()
      await expect(page.getByTestId(TESTIDS.residentList)).toBeVisible()
      await page.getByTestId('native2d-resident-person-mugino-toru').click()
      await expect(page.getByTestId(TESTIDS.residentCardName)).toHaveText('雾野 透')
      await page.getByTestId(TESTIDS.followToggle).click()
      await expect(page.getByTestId(TESTIDS.followStatus)).toBeVisible()
      await page.getByTestId(TESTIDS.followToggle).click()
      await page.getByTestId(TESTIDS.hallExit).click()
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('庄园外景')
      await page.getByRole('button', { name: '关闭事实面板' }).click()
      await page.getByTestId(TESTIDS.refresh).click()
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')

      await page.getByTestId(TESTIDS.editPanelToggle).click()
      await expect(page.getByTestId(TESTIDS.buildingList)).toBeVisible()
      await page.getByTestId(TESTIDS.buildingList).selectOption('gatehouse')
      await page.getByTestId(TESTIDS.moveStart).click()
      await page.getByRole('button', { name: '关闭编辑面板' }).click()
      await dragObjectByTouch(context, page, 'building:gatehouse', -500, 0)
      await page.getByTestId(TESTIDS.editPanelToggle).click()
      await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('不可用')
      await page.getByTestId(TESTIDS.moveCancel).click()
      await page.getByTestId(TESTIDS.moveStart).click()
      await page.getByRole('button', { name: '关闭编辑面板' }).click()
      await dragObjectByTouch(context, page, 'building:gatehouse', 44, 22)
      await page.getByTestId(TESTIDS.editPanelToggle).click()
      await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('可应用')
      await page.getByTestId(TESTIDS.moveApply).click()
      await expect(page.getByTestId(TESTIDS.undo)).toBeEnabled()
      await page.getByTestId(TESTIDS.undo).click()
      await expect(page.getByTestId(TESTIDS.undo)).toBeDisabled()
      await page.getByTestId(TESTIDS.moveStart).click()
      await page.getByRole('button', { name: '关闭编辑面板' }).click()
      await dragObjectByTouch(context, page, 'building:gatehouse', 44, 22)
      await page.getByTestId(TESTIDS.editPanelToggle).click()
      await page.getByTestId(TESTIDS.moveApply).click()
      await page.reload()
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
      await expect(page.getByTestId(TESTIDS.undo)).toBeDisabled()
      await page.getByTestId(TESTIDS.editPanelToggle).click()
      await page.getByTestId(TESTIDS.reset).click()
      await expect(page.getByTestId(TESTIDS.resetConfirm)).toBeVisible()
      await page.getByTestId(TESTIDS.resetConfirm).click()
      expect(await readLocalStorage(page)).toEqual({})
      expect(recorder.records().some((record) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(record.method))).toBe(false)
    } finally {
      recorder.stop()
      await context.close()
    }
  })

  test('distinguishes a touch pan from a click', async ({ browser }) => {
    const { page, context } = await createIsolatedSampleContext(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    })
    try {
      await page.goto('/dev/native-2d')
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
      const host = page.getByTestId(TESTIDS.viewportHost)
      const box = await host.boundingBox()
      if (!box) throw new Error('viewport host is not visible')
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await touchDrag(context, page, { x, y }, { x: x + 55, y: y + 20 })
      await expect(page.getByTestId(TESTIDS.followStatus)).toHaveCount(0)
    } finally {
      await context.close()
    }
  })

  test('switches single and dual touch, then recovers from touch cancellation', async ({ browser }) => {
    const { page, context } = await createIsolatedSampleContext(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    })
    try {
      await page.goto('/dev/native-2d')
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
      await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(0)
      const box = await page.getByTestId(TESTIDS.viewportHost).boundingBox()
      if (!box) throw new Error('viewport host is not visible')
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      const client = await context.newCDPSession(page)
      try {
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 20, y: y + 8, id: 1 }] })
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [
            { x: x + 20, y: y + 8, id: 1 },
            { x: x + 70, y: y + 8, id: 2 },
          ],
        })
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            { x: x + 4, y: y + 8, id: 1 },
            { x: x + 86, y: y + 8, id: 2 },
          ],
        })
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: x + 4, y: y + 8, id: 1 }] })
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 28, y: y + 20, id: 1 }] })
        await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 3 }] })
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: box.x + box.width + 1, y, id: 3 }],
        })
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      } finally {
        await client.detach()
      }
      await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(1)
      await page.getByTestId(TESTIDS.panelToggle).click()
      await page.getByTestId('native2d-resident-person-mugino-toru').click()
      await expect(page.getByTestId(TESTIDS.residentCardName)).toHaveText('雾野 透')
      await expect(page.getByTestId(TESTIDS.followStatus)).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
})
