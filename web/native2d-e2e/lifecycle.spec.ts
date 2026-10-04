import { test, expect, type Page } from '@playwright/test'
import { TESTIDS, createIsolatedSampleContext, installPublicApiStub, publicDayResponse, readDiagnostics } from './fixtures'

async function navigate(page: Page, path: string) {
  await page.evaluate((destination) => {
    window.history.pushState({}, '', destination)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

test('disposes a viewport that finishes initializing after unmount without accumulating resources', async ({ browser }) => {
  const { page, context } = await createIsolatedSampleContext(browser)
  await page.addInitScript(() => {
    const state = {
      holdNext: true,
      waiting: 0,
      releases: [] as (() => void)[],
      applications: [] as { destroyed: boolean; canvas: HTMLCanvasElement | null }[],
      listeners: new Map<EventTarget, Map<string, Set<EventListenerOrEventListenerObject>>>(),
      observers: new Set<ResizeObserver>(),
      windowResize: new Set<EventListenerOrEventListenerObject>(),
    }
    Object.assign(window, { __native2dLifecycleTest: state })
    const add = EventTarget.prototype.addEventListener
    const remove = EventTarget.prototype.removeEventListener
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (listener && this instanceof HTMLElement && this.classList.contains('native2d-viewport-host')) {
        const events = state.listeners.get(this) ?? new Map()
        const listeners = events.get(type) ?? new Set()
        listeners.add(listener)
        events.set(type, listeners)
        state.listeners.set(this, events)
      }
      if (listener && this === window && type === 'resize') state.windowResize.add(listener)
      return add.call(this, type, listener, options)
    }
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      if (listener) state.listeners.get(this)?.get(type)?.delete(listener)
      if (listener && this === window && type === 'resize') state.windowResize.delete(listener)
      return remove.call(this, type, listener, options)
    }
    const NativeResizeObserver = ResizeObserver
    window.ResizeObserver = class extends NativeResizeObserver {
      observe(target: Element, options?: ResizeObserverOptions) {
        if (target.classList.contains('native2d-viewport-host')) state.observers.add(this)
        super.observe(target, options)
      }
      disconnect() {
        state.observers.delete(this)
        super.disconnect()
      }
    }
  })

  // Delay the real Pixi initializer after it allocates its renderer, so route
  // teardown happens while the component is still awaiting initialization.
  await page.route('**/src/native2d/viewport.ts*', async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    await route.fulfill({ response, body: `${source}\n
      const lifecycle = window.__native2dLifecycleTest;
      const originalInit = Application.prototype.init;
      const originalDestroy = Application.prototype.destroy;
      const entries = new WeakMap();
      Application.prototype.init = async function (...args) {
        await originalInit.apply(this, args);
        const entry = { destroyed: false, canvas: this.canvas };
        entries.set(this, entry);
        lifecycle.applications.push(entry);
        if (lifecycle.holdNext) {
          lifecycle.waiting += 1;
          await new Promise((resolve) => { lifecycle.releases.push(resolve); });
          lifecycle.waiting -= 1;
        }
      };
      Application.prototype.destroy = function (...args) {
        const result = originalDestroy.apply(this, args);
        const entry = entries.get(this);
        if (entry) entry.destroyed = true;
        return result;
      };
    ` })
  })

  const resources = () => page.evaluate(() => {
    const state = (window as unknown as { __native2dLifecycleTest: {
      waiting: number
      applications: { destroyed: boolean; canvas: HTMLCanvasElement | null }[]
      listeners: Map<EventTarget, Map<string, Set<unknown>>>
      observers: Set<unknown>
      windowResize: Set<unknown>
    } }).__native2dLifecycleTest
    return {
      waiting: state.waiting,
      liveApplications: state.applications.filter((app) => !app.destroyed).length,
      attachedCanvases: state.applications.filter((app) => app.canvas?.isConnected).length,
      inputListeners: [...state.listeners.values()].reduce((total, events) => total + [...events.values()].reduce((count, listeners) => count + listeners.size, 0), 0),
      observers: state.observers.size,
      windowResize: state.windowResize.size,
    }
  })

  try {
    await page.goto('/dev/native-2d')
    await expect.poll(async () => (await resources()).waiting).toBeGreaterThan(0)
    await expect(page.getByTestId(TESTIDS.viewportHost).locator('canvas')).toHaveCount(0)
    await navigate(page, '/login')
    await expect(page.getByTestId(TESTIDS.viewportHost)).toHaveCount(0)
    await page.evaluate(() => {
      const state = (window as unknown as { __native2dLifecycleTest: { holdNext: boolean; releases: (() => void)[] } }).__native2dLifecycleTest
      state.holdNext = false
      state.releases.splice(0).forEach((resolve) => resolve())
    })
    const released = { waiting: 0, liveApplications: 0, attachedCanvases: 0, inputListeners: 0, observers: 0, windowResize: 0 }
    await expect.poll(resources).toEqual(released)
    await expect.poll(() => page.evaluate(() => window.__native2dDiagnostics)).toBeUndefined()

    for (const size of [{ width: 1280, height: 720 }, { width: 1100, height: 760 }, { width: 1280, height: 720 }]) {
      await page.setViewportSize(size)
      await navigate(page, '/dev/native-2d')
      await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(0)
      await expect.poll(resources).toEqual({ ...released, liveApplications: 1, attachedCanvases: 1, inputListeners: 6, observers: 1, windowResize: 1 })
      await expect.poll(() => page.evaluate(async () => {
        const before = window.__native2dDiagnostics?.()?.drawCount
        for (let frame = 0; frame < 15; frame++) await new Promise(requestAnimationFrame)
        return (window.__native2dDiagnostics?.()?.drawCount ?? 0) - (before ?? 0)
      })).toBe(0)
      await navigate(page, '/login')
      await expect.poll(resources).toEqual(released)
      await expect.poll(() => page.evaluate(() => window.__native2dDiagnostics)).toBeUndefined()
    }
  } finally {
    await context.close()
  }
})

test('aborts a pending old source on unmount and ignores its late response after re-entry', async ({ browser }) => {
  const { page, context } = await createIsolatedSampleContext(browser)
  await installPublicApiStub(page, { worlds: [{ kind: 'json', body: publicDayResponse() }] })
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let started = false
  let replied = false
  let aborted = false
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/public/worlds/')) aborted = true
  })
  await page.route('**/api/public/worlds/**', async (route) => {
    started = true
    await held
    await route.fulfill({ json: { ...publicDayResponse(), stateVersion: 777 } })
    replied = true
  })
  try {
    await page.goto('/dev/native-2d')
    await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
    await page.getByTestId(TESTIDS.sourceKindPublic).click()
    await page.getByTestId(TESTIDS.sourceApply).click()
    await expect.poll(() => started).toBe(true)
    await navigate(page, '/login')
    await expect(page.getByTestId(TESTIDS.viewportHost)).toHaveCount(0)
    await expect.poll(() => aborted).toBe(true)
    await navigate(page, '/dev/native-2d')
    await expect(page.getByTestId(TESTIDS.stateVersion)).toHaveText('版本 101')
    release()
    await expect.poll(() => replied).toBe(true)
    await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText('fixture-timeline-mist-manor-001')
    await expect(page.getByTestId(TESTIDS.stateVersion)).toHaveText('版本 101')
    await expect(page.getByTestId(TESTIDS.staleBadge)).toHaveCount(0)
  } finally { release(); await context.close() }
})
