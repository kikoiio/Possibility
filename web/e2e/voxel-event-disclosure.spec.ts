import { expect, test, type Page } from '@playwright/test'

/**
 * S3b 事件披露 e2e(AC2~AC6)。
 * fixture 四事件:婚礼(high,窗内)/集市(low,窗内)/火灾(high,已结束留痕)/花展(medium,未开始隐藏),
 * 参考时间 FIXTURE_SIM_NOW=2026-10-15T17:00Z(dev-harness 加载后自动下发)。
 * 全部经 window.__voxelEngine 探针断言,不靠截图像素。
 */

test.setTimeout(120_000)

interface DisclosureState { eventId: string; phase: 'hidden' | 'trace' | 'active'; level: 'none' | 'icon' | 'teaser' }

interface EventProbe {
  getZoomTier(): 'overview' | 'district' | 'close'
  getZoom(): number
  setSimNow(iso: string): void
  getEventDisclosure(): DisclosureState[]
  flyToEvent(id: string): boolean
  readonly disclosure: { screenAnchors(includeIconOnly: boolean): { eventId: string; x: number; y: number }[] } | null
  readonly cameraRig: { state: { target: { x: number; y: number; z: number } } }
}

function probe<T>(page: Page, fn: (engine: EventProbe) => T): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__voxelEngine)`) as Promise<T>
}

async function waitReady(page: Page) {
  await page.goto('/dev/voxel')
  await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 15000 })
}

function states(page: Page): Promise<DisclosureState[]> {
  return probe(page, (e) => e.getEventDisclosure())
}

function stateOf(list: DisclosureState[], id: string): DisclosureState {
  const s = list.find((x) => x.eventId === id)
  if (!s) throw new Error(`event ${id} not in disclosure states`)
  return s
}

/** 逐发滚轮 + 逐发轮询,到档即停(滞回带教训);deltaY<0 拉近 */
async function wheelToTier(page: Page, tier: 'overview' | 'district' | 'close', deltaY: number) {
  const canvas = page.getByTestId('voxel-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas not found')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 60; i++) {
    if ((await probe(page, (e) => e.getZoomTier())) === tier) return
    await page.mouse.wheel(0, deltaY)
    await page.waitForTimeout(60)
  }
  throw new Error(`tier ${tier} not reached, now ${await probe(page, (e) => e.getZoomTier())} zoom=${await probe(page, (e) => e.getZoom())}`)
}

/** 事件图标的屏幕坐标(client px;图标级含残影)。eventId 内联进 evaluate 字符串(闭包读不到 Node 变量) */
async function iconScreenPos(page: Page, eventId: string): Promise<{ x: number; y: number }> {
  const pos = await page.evaluate(
    `(() => window.__voxelEngine.disclosure?.screenAnchors(true).find((a) => a.eventId === ${JSON.stringify(eventId)}) ?? null)()`,
  ) as { x: number; y: number } | null
  if (!pos) throw new Error(`event ${eventId} has no screen anchor`)
  return pos
}

test.describe('S3b 事件披露', () => {
  test('overview 档:高重要度图标可见,低重要度/未开始隐藏,无浮层 DOM(AC2/AC5/AC7)', async ({ page }) => {
    await waitReady(page)
    await wheelToTier(page, 'overview', 120)
    const list = await states(page)
    expect(stateOf(list, 'evt-wedding')).toEqual({ eventId: 'evt-wedding', phase: 'active', level: 'icon' })
    expect(stateOf(list, 'evt-market').level).toBe('none')        // low 重要度过滤(F7)
    expect(stateOf(list, 'evt-fire')).toEqual({ eventId: 'evt-fire', phase: 'trace', level: 'icon' })
    expect(stateOf(list, 'evt-flower-show').phase).toBe('hidden') // 未来隐藏(防剧透)
    await expect(page.getByTestId('event-overlay')).toBeHidden()  // overview 零 DOM(N3)
  })

  test('district 档:预告浮层出现,含窗内事件、不含未开始/残影(AC2)', async ({ page }) => {
    await waitReady(page)
    await wheelToTier(page, 'district', -120)
    const list = await states(page)
    expect(stateOf(list, 'evt-wedding').level).toBe('teaser')
    expect(stateOf(list, 'evt-market').level).toBe('teaser')      // district 档全披露
    await expect(page.getByTestId('event-teaser-evt-wedding')).toBeVisible()
    await expect(page.getByTestId('event-teaser-evt-market')).toBeVisible()
    await expect(page.getByTestId('event-teaser-evt-flower-show')).toHaveCount(0)
    await expect(page.getByTestId('event-teaser-evt-fire')).toHaveCount(0) // 残影只有图标
  })

  test('时间联动:setSimNow 三态切换无需重载(AC3)', async ({ page }) => {
    await waitReady(page)
    // 火灾:窗内 → 活跃
    await probe(page, (e) => e.setSimNow('2026-10-14T11:00:00Z'))
    await expect.poll(async () => stateOf(await states(page), 'evt-fire').phase).toBe('active')
    // 火灾:窗后 → 留痕;婚礼:窗前 → 隐藏
    await probe(page, (e) => e.setSimNow('2026-10-15T15:00:00Z'))
    await expect.poll(async () => stateOf(await states(page), 'evt-fire').phase).toBe('trace')
    await expect.poll(async () => stateOf(await states(page), 'evt-wedding').phase).toBe('hidden')
    // 回到参考时间:婚礼恢复活跃
    await probe(page, (e) => e.setSimNow('2026-10-15T17:00:00Z'))
    await expect.poll(async () => stateOf(await states(page), 'evt-wedding').phase).toBe('active')
  })

  test('overview 档点击图标:相机飞向事件并落入 close 档(AC4)', async ({ page }) => {
    await waitReady(page)
    await wheelToTier(page, 'overview', 120)
    const pos = await iconScreenPos(page, 'evt-wedding')
    await page.mouse.click(pos.x, pos.y)
    await expect.poll(() => probe(page, (e) => e.getZoomTier()), { timeout: 10000 }).toBe('close')
    const target = await probe(page, (e) => e.cameraRig.state.target)
    expect(Math.abs(target.x - 23.5)).toBeLessThan(0.1) // 婚礼锚点 (23,1,34) 格心
    expect(Math.abs(target.z - 34.5)).toBeLessThan(0.1)
  })

  test('close 档点击标记打开面板;残影事件任意档点击直接开面板带「已落幕」(AC6)', async ({ page }) => {
    await waitReady(page)
    // 先飞到婚礼(orbit 档内点击 → close)
    await wheelToTier(page, 'overview', 120)
    const pos = await iconScreenPos(page, 'evt-wedding')
    await page.mouse.click(pos.x, pos.y)
    await expect.poll(() => probe(page, (e) => e.getZoomTier()), { timeout: 10000 }).toBe('close')
    // close 档再点 → 面板
    const closePos = await iconScreenPos(page, 'evt-wedding')
    await page.mouse.click(closePos.x, closePos.y)
    await expect(page.getByTestId('event-panel')).toBeVisible()
    await expect(page.getByTestId('event-panel-title')).toHaveText('婚礼')
    await expect(page.getByTestId('event-panel-scene')).toContainText('交换誓言')
    await expect(page.getByTestId('event-panel-trace')).toHaveCount(0)
    await page.getByRole('button', { name: '关闭事件详情' }).click()
    await expect(page.getByTestId('event-panel')).toHaveCount(0)
    // 残影(火灾):overview 档点击直接开面板,不飞
    await wheelToTier(page, 'overview', 120)
    const firePos = await iconScreenPos(page, 'evt-fire')
    const zoomBefore = await probe(page, (e) => e.getZoom())
    await page.mouse.click(firePos.x, firePos.y)
    await expect(page.getByTestId('event-panel')).toBeVisible()
    await expect(page.getByTestId('event-panel-trace')).toBeVisible()
    expect(await probe(page, (e) => e.getZoom())).toBeCloseTo(zoomBefore, 2) // 未触发飞行
  })

  test('reduced-motion:点击直切到位,无补间等待(N2)', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' })
    const page = await context.newPage()
    await waitReady(page)
    await wheelToTier(page, 'overview', 120)
    const pos = await iconScreenPos(page, 'evt-wedding')
    await page.mouse.click(pos.x, pos.y)
    // 直切:下一帧即 close(不给补间时间窗)
    await expect.poll(() => probe(page, (e) => e.getZoomTier()), { timeout: 2000, intervals: [50] }).toBe('close')
    await context.close()
  })
})
