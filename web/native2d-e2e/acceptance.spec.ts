import { test, expect, type Browser, type Locator, type Page } from '@playwright/test'
import { ASSET_MANIFEST } from '../src/native2d/assets'
import { createFixtureReadModel, FIXTURE_PERSON_IDS } from '../src/native2d/fixtures'
import { MIST_MANOR_SCENE } from '../src/native2d/scene'
import type { GridPoint, LocalLayoutRecord } from '../src/native2d/types'
import {
  TESTIDS,
  assertReadOnlyApiRequests,
  buildPublicWorldSnapshot,
  createApiRequestRecorder,
  createIsolatedSampleContext,
  getObjectClickPoint,
  installPublicApiStub,
  publicDayResponse,
  publicRefreshResponse,
  readDiagnostics,
  readLocalStorage,
  seedLocalStorage,
} from './fixtures'

const FIXTURE_KEY = 'possibility.native2d.layout.v1:["fixture","fixture-world-mist-manor","fixture-timeline-mist-manor-001","mist-manor"]'
const PUBLIC_KEY = 'possibility.native2d.layout.v1:["public","demo-world-mist-manor","demo-timeline-mist-manor-001","mist-manor"]'

async function ready(page: Page) {
  await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新')
  await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(0)
}

async function open(browser: Browser) {
  const result = await createIsolatedSampleContext(browser, { viewport: { width: 1280, height: 720 } })
  await result.page.goto('/dev/native-2d')
  await ready(result.page)
  return result
}

async function publicSource(page: Page) {
  await page.getByTestId(TESTIDS.sourceKindPublic).click()
  await page.getByTestId(TESTIDS.sourceApply).click()
}

async function fixtureSource(page: Page) {
  await page.getByTestId(TESTIDS.sourceKindFixture).click()
  await page.getByTestId(TESTIDS.sourceFixtureSelect).selectOption('mist-manor-day')
  await page.getByTestId(TESTIDS.sourceApply).click()
  await ready(page)
}

async function record(page: Page, key: string): Promise<LocalLayoutRecord | null> {
  const records = await readLocalStorage(page)
  return records[key] ? JSON.parse(records[key]) as LocalLayoutRecord : null
}

async function dragBuilding(page: Page, buildingId: string, target: GridPoint) {
  await page.getByTestId(TESTIDS.viewportHost).scrollIntoViewIfNeeded()
  const before = (await readDiagnostics(page))?.drawCount ?? 0
  await page.getByTestId(TESTIDS.overview).click()
  await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(before)
  const start = await getObjectClickPoint(page, `building:${buildingId}`)
  const diagnostics = await readDiagnostics(page)
  const bounds = diagnostics?.objectBounds[`building:${buildingId}`]
  const definition = MIST_MANOR_SCENE.buildings.find((building) => building.id === buildingId)
  const entries = Object.values(await readLocalStorage(page))
    .map((value) => { try { return JSON.parse(value) as LocalLayoutRecord } catch { return null } })
  const sourceLabel = await page.getByTestId(TESTIDS.sourceLabel).innerText()
  const source = sourceLabel.includes('公开只读') ? 'public' : 'fixture'
  const origin = entries.find((entry) => entry?.scope.source === source)?.placements
    .find((placement) => placement.buildingId === buildingId)?.origin ?? definition?.initialOrigin
  if (!start || !bounds || !origin) throw new Error(`missing building ${buildingId}`)
  const zoom = bounds.width / ASSET_MANIFEST[buildingId].layers[0].pixelWidth
  const dx = (target.x - origin.x - (target.z - origin.z)) * 32 * zoom
  const dy = (target.x - origin.x + target.z - origin.z) * 16 * zoom
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 12 })
  await page.mouse.up()
  await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText(`候选位置 ${target.x}, ${target.z}`)
}

async function preview(page: Page, buildingId: string, target: GridPoint) {
  await page.getByTestId(TESTIDS.buildingList).selectOption(buildingId)
  await page.getByTestId(TESTIDS.moveStart).click()
  await dragBuilding(page, buildingId, target)
  await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('可应用')
}

async function move(page: Page, buildingId: string, target: GridPoint) {
  await preview(page, buildingId, target)
  await page.getByTestId(TESTIDS.moveApply).click()
  await expect(page.getByTestId(TESTIDS.moveStatus)).toHaveCount(0)
}

async function pan(page: Page) {
  const bounds = await page.getByTestId(TESTIDS.viewportHost).boundingBox()
  if (!bounds) throw new Error('missing viewport')
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 65, y + 24, { steps: 8 })
  await page.mouse.up()
}

function reiSnapshot(locationName: string, version: number, remove = false) {
  const model = createFixtureReadModel('public-mist-manor-day')
  return buildPublicWorldSnapshot({
    ...model,
    stateVersion: version,
    simNow: `2026-01-15T${String(version).padStart(2, '0')}:00:00.000Z`,
    residents: remove ? model.residents.filter((resident) => resident.personId !== FIXTURE_PERSON_IDS.shirakawaRei)
      : model.residents.map((resident) => resident.personId === FIXTURE_PERSON_IDS.shirakawaRei
        ? { ...resident, locationName, activity: `已知活动 ${version}` } : resident),
  })
}

async function refreshTo(page: Page, version: number) {
  await page.getByTestId(TESTIDS.refresh).click()
  await expect(page.getByTestId(TESTIDS.stateVersion)).toHaveText(`版本 ${version}`)
  await ready(page)
}

async function tabTo(page: Page, locator: Locator, accessibleName: string) {
  await expect(locator).toHaveAccessibleName(accessibleName)
  let reached = false
  for (let step = 0; step < 65; step += 1) {
    await page.keyboard.press('Tab')
    if (await locator.evaluate((element) => document.activeElement === element)) {
      reached = true
      break
    }
  }
  expect(reached, `keyboard reaches ${accessibleName}`).toBe(true)
  await expect(locator).toBeFocused()
  expect(await locator.evaluate((element) => {
    const style = getComputedStyle(element)
    return element.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
  }), `visible focus on ${accessibleName}`).toBe(true)
}

test.describe('N2D1 acceptance gaps', () => {
  test('keeps actual resident bounds stable through repeated identical exterior and hall refreshes', async ({ browser }) => {
    const { page, context } = await open(browser)
    try {
      const facts = await page.getByTestId(TESTIDS.residentList).textContent() ?? ''
      for (const space of ['exterior', 'hall']) {
        if (space === 'hall') await page.getByTestId(TESTIDS.hallEnter).click()
        const beforeOverview = (await readDiagnostics(page))?.drawCount ?? 0
        await page.getByTestId(TESTIDS.overview).click()
        await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(beforeOverview)
        const residents = async () => Object.fromEntries(Object.entries((await readDiagnostics(page))?.objectBounds ?? {}).filter(([id]) => id.startsWith('resident:')))
        const stable = await residents()
        expect(Object.keys(stable).length).toBeGreaterThan(0)
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const before = (await readDiagnostics(page))?.drawCount ?? 0
          await page.getByTestId(TESTIDS.refresh).click()
          await ready(page)
          await expect.poll(async () => (await readDiagnostics(page))?.drawCount ?? 0).toBeGreaterThan(before)
          await expect.poll(residents).toEqual(stable)
          await expect(page.getByTestId(TESTIDS.residentList)).toHaveText(facts)
          await expect(page.getByTestId(TESTIDS.stateVersion)).toHaveText('版本 101')
          await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText(space === 'hall' ? '主楼 · 大厅' : '庄园外景')
          await expect(page.getByText('固定斜俯视 · 观察模式')).toBeVisible()
        }
        await test.info().attach(`stable-${space}-resident-bounds`, { body: JSON.stringify(stable), contentType: 'application/json' })
      }
    } finally { await context.close() }
  })

  test('shows unknown world time and removes time-dependent warm layers without inventing a day phase', async ({ browser }) => {
    const { page, context } = await createIsolatedSampleContext(browser)
    await page.route('**/src/native2d/viewport.ts*', async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, body: `${await response.text()}\n
        const timeFeedbackInit = Application.prototype.init;
        Application.prototype.init = async function (...args) {
          await timeFeedbackInit.apply(this, args);
          (window.__native2dTimeApplications ??= []).push(this);
        };
      ` })
    })
    const labels = () => page.evaluate(() => {
      const applications = (window as unknown as { __native2dTimeApplications: { canvas: HTMLCanvasElement; stage: { children: { children: { label: string }[] }[] } | null }[] }).__native2dTimeApplications
      const app = applications?.find((item) => item.stage && item.canvas.isConnected)
      return app?.stage?.children[0].children.map((layer) => layer.label) ?? []
    })
    try {
      await page.goto('/dev/native-2d')
      await ready(page)
      await page.getByTestId(TESTIDS.sourceFixtureSelect).selectOption('mist-manor-night')
      await page.getByTestId(TESTIDS.sourceApply).click()
      await ready(page)
      await expect(page.getByTestId(TESTIDS.worldTime)).toContainText('23:00')
      await expect.poll(async () => (await labels()).filter((label) => label?.endsWith(':accent')).length).toBeGreaterThan(0)
      await page.getByTestId(TESTIDS.sourceFixtureSelect).selectOption('mist-manor-unknown-time')
      await page.getByTestId(TESTIDS.sourceApply).click()
      await ready(page)
      await expect(page.getByTestId(TESTIDS.worldTime)).toHaveText('时间未知')
      await expect(page.getByTestId(TESTIDS.worldTimeZone)).toHaveText('Asia/Tokyo')
      await expect(page.getByTestId(TESTIDS.stateVersion)).toHaveText('版本 105')
      await expect.poll(async () => (await labels()).filter((label) => label?.endsWith(':accent'))).toEqual([])
      await expect.poll(async () => (await labels()).includes('building:main-house:base')).toBe(true)
      await test.info().attach('unknown-time-render-feedback', { body: JSON.stringify({
        time: await page.getByTestId(TESTIDS.worldTime).textContent(),
        timeZone: await page.getByTestId(TESTIDS.worldTimeZone).textContent(),
        layers: await labels(), diagnostics: await readDiagnostics(page),
      }), contentType: 'application/json' })
    } finally { await context.close() }
  })

  test('matches fixed identities, time and every resident and location to the input', async ({ browser }) => {
    const { page, context } = await open(browser)
    const model = createFixtureReadModel('mist-manor-day')
    try {
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('庄园外景')
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText(`固定数据 · ${model.worldName}`)
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText(`${model.scope.worldId} / ${model.scope.timelineId}`)
      await expect(page.getByTestId(TESTIDS.worldTimeZone)).toHaveText(model.timeZone)
      await expect(page.getByTestId(TESTIDS.worldTime)).toHaveText(new Intl.DateTimeFormat('zh-CN', {
        timeZone: model.timeZone, dateStyle: 'medium', timeStyle: 'short', hour12: false,
      }).format(new Date(model.simNow!)))
      await expect(page.getByTestId(TESTIDS.stateVersion)).toHaveText(`版本 ${model.stateVersion}`)
      await expect(page.getByTestId(TESTIDS.residentList).locator('.native2d-list-row')).toHaveCount(model.residents.length)
      for (const resident of model.residents) {
        await page.getByTestId(`native2d-resident-${resident.personId}`).click()
        await expect(page.getByTestId(TESTIDS.residentCardName)).toHaveText(resident.name)
        await expect(page.getByTestId(TESTIDS.residentCardLocation)).toContainText(resident.locationName ?? '地点未知')
        await expect(page.getByTestId(TESTIDS.residentCardActivity)).toHaveText(resident.activity ?? '活动未知')
      }
      await expect(page.getByTestId(TESTIDS.locationList).locator('button')).toHaveCount(model.locations.length)
      for (const location of model.locations) {
        await page.getByTestId(`native2d-location-${location.name}`).click()
        await expect(page.getByTestId(TESTIDS.locationCardDescription)).toHaveText(location.description)
        const names = model.residents.filter((resident) => resident.locationName === location.name).map((resident) => resident.name)
        await expect(page.getByTestId(TESTIDS.locationCard)).toContainText(`在场居民：${names.length ? names.join('、') : '无已知居民'}`)
      }
    } finally { await context.close() }
  })

  test('pins the successful public timeline through multiple manual refresh requests', async ({ browser }) => {
    const { page, context } = await open(browser)
    await installPublicApiStub(page, { worlds: [
      { kind: 'json', body: publicDayResponse() },
      { kind: 'json', body: publicRefreshResponse() },
      { kind: 'json', body: publicRefreshResponse() },
    ] })
    const requests = createApiRequestRecorder(page)
    try {
      await publicSource(page)
      await ready(page)
      const label = await page.getByTestId(TESTIDS.sourceLabel).textContent() ?? ''
      await refreshTo(page, 9)
      await page.getByTestId(TESTIDS.refresh).click()
      await ready(page)
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toHaveText(label)
      const reads = requests.records().filter((request) => request.path.startsWith('/api/public/worlds/'))
      expect(reads).toHaveLength(3)
      expect(new URL(reads[0].url).searchParams.get('timelineId')).toBeNull()
      for (const request of reads.slice(1)) expect(new URL(request.url).searchParams.get('timelineId')).toBe('demo-timeline-mist-manor-001')
      expect(requests.records().filter((request) => request.path === '/api/public/demo')).toHaveLength(1)
      assertReadOnlyApiRequests(requests.records())
    } finally { requests.stop(); await context.close() }
  })

  test('keeps unknown, unmapped and overcrowded residents factual without fabricated positions', async ({ browser }) => {
    const { page, context } = await open(browser)
    try {
      await page.getByTestId(`native2d-resident-${FIXTURE_PERSON_IDS.hiiragiKazunari}`).click()
      await expect(page.getByTestId(TESTIDS.residentCardLocation)).toHaveText('地点未知')
      await expect(page.getByTestId(TESTIDS.residentCardActivity)).toHaveText('活动未知')
      await page.getByTestId(TESTIDS.followToggle).click()
      await expect(page.getByTestId(TESTIDS.followStatus)).toContainText('目标地点未知')
      expect((await readDiagnostics(page))?.objectBounds[`resident:${FIXTURE_PERSON_IDS.hiiragiKazunari}`]).toBeUndefined()

      await page.getByTestId(TESTIDS.sourceFixtureSelect).selectOption('mist-manor-overcrowded')
      await page.getByTestId(TESTIDS.sourceApply).click()
      await ready(page)
      if (await page.getByTestId(TESTIDS.hallEnter).count()) await page.getByTestId(TESTIDS.hallEnter).click()
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('主楼 · 大厅')
      const model = createFixtureReadModel('mist-manor-overcrowded')
      const hall = MIST_MANOR_SCENE.locationBindings.find((binding) => binding.sourceLocationName === '大厅')!
      const representation = hall.representation
      if (representation.kind !== 'interior') throw new Error('hall is not interior')
      const sortedIds = model.residents.map((resident) => resident.personId).sort()
      const shown = sortedIds.slice(0, representation.residentSlots.length)
      const overflow = sortedIds.slice(representation.residentSlots.length)
      await expect.poll(async () => Object.keys((await readDiagnostics(page))?.objectBounds ?? {}).filter((id) => id.startsWith('resident:')).sort()).toEqual(shown.map((id) => `resident:${id}`).sort())
      for (const personId of overflow) {
        await page.getByTestId(`native2d-resident-${personId}`).click()
        await expect(page.getByTestId(TESTIDS.residentCardLocation)).toHaveText('大厅')
        await page.getByTestId(TESTIDS.followToggle).click()
        await expect(page.getByTestId(TESTIDS.followStatus)).toContainText('示意站位不足')
        expect((await readDiagnostics(page))?.objectBounds[`resident:${personId}`]).toBeUndefined()
      }

      const unmappedModel = createFixtureReadModel('public-mist-manor-day')
      const unmapped = buildPublicWorldSnapshot({
        ...unmappedModel,
        locations: [...unmappedModel.locations, { name: '未映射的真实地点', description: '公开来源有此地点，样板没有空间映射。' }],
        residents: unmappedModel.residents.map((resident) => resident.personId === FIXTURE_PERSON_IDS.shirakawaRei
          ? { ...resident, locationName: '未映射的真实地点', activity: null } : resident),
      })
      await installPublicApiStub(page, { worlds: [{ kind: 'json', body: unmapped }] })
      await publicSource(page)
      await ready(page)
      await expect(page.getByTestId('native2d-location-未映射的真实地点')).toContainText('场景映射未知')
      await expect(page.getByTestId('native2d-location-未映射的真实地点')).toBeDisabled()
      await page.getByTestId(`native2d-resident-${FIXTURE_PERSON_IDS.shirakawaRei}`).click()
      await expect(page.getByTestId(TESTIDS.residentCardLocation)).toContainText('未映射的真实地点')
      await expect(page.getByTestId(TESTIDS.residentCardActivity)).toHaveText('活动未知')
      await page.getByTestId(TESTIDS.followToggle).click()
      await expect(page.getByTestId(TESTIDS.followStatus)).toContainText('场景')
      expect((await readDiagnostics(page))?.objectBounds[`resident:${FIXTURE_PERSON_IDS.shirakawaRei}`]).toBeUndefined()
    } finally { await context.close() }
  })

  test('rejects collision, protected anchors and blocked entrances while allowing a bypassing move', async ({ browser }) => {
    const { page, context } = await open(browser)
    try {
      const candidates = [
        { buildingId: 'greenhouse', target: { x: 3, z: 2 }, reason: '与建筑 main-house 的占地重叠' },
        { buildingId: 'gatehouse', target: { x: 8, z: 4 }, reason: '与固定阻挡物件重叠' },
        { buildingId: 'gatehouse', target: { x: 10, z: 10 }, reason: '落在不可放置地面' },
        { buildingId: 'gatehouse', target: { x: 13, z: 12 }, reason: '覆盖固定地点锚点或居民站位' },
        { buildingId: 'gatehouse', target: { x: 6, z: 7 }, reason: '建筑 gatehouse 的入口 (7,9) 不在可通行地面' },
        { buildingId: 'gatehouse', target: { x: 4, z: 4 }, reason: '建筑 main-house 的入口 (5,5) 被建筑占地覆盖' },
        { buildingId: 'main-house', target: { x: 7, z: 6 }, reason: '连通起点 (8,7) 被建筑占地覆盖' },
      ]
      for (const candidate of candidates) {
        await page.getByTestId(TESTIDS.buildingList).selectOption(candidate.buildingId)
        await page.getByTestId(TESTIDS.moveStart).click()
        await dragBuilding(page, candidate.buildingId, candidate.target)
        await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('不可用')
        await expect(page.getByTestId(TESTIDS.conflictReasons)).toContainText(candidate.reason)
        await expect(page.getByTestId(TESTIDS.moveApply)).toBeDisabled()
        expect(await readLocalStorage(page)).toEqual({})
        await page.getByTestId(TESTIDS.moveCancel).click()
      }
      // The fixed estate has open bypasses; disconnected-only corridors use the pure synthetic scene tests.
      await move(page, 'gatehouse', { x: 0, z: 9 })
      expect((await record(page, FIXTURE_KEY))?.placements.find((placement) => placement.buildingId === 'gatehouse')?.origin).toEqual({ x: 0, z: 9 })
    } finally { await context.close() }
  })

  test('cancelled damaged-record recovery leaves its original data and edit gate intact', async ({ browser }) => {
    const { page, context } = await createIsolatedSampleContext(browser)
    await seedLocalStorage(page, { [FIXTURE_KEY]: '{broken-layout' })
    try {
      await page.goto('/dev/native-2d')
      await ready(page)
      await expect(page.getByTestId(TESTIDS.restoreStatus)).toBeVisible()
      await page.getByTestId(TESTIDS.restoreReset).click()
      await page.getByTestId(TESTIDS.resetCancel).click()
      await expect(page.getByTestId(TESTIDS.resetConfirm)).toHaveCount(0)
      await expect(page.getByTestId(TESTIDS.restoreStatus)).toBeVisible()
      await expect(page.getByTestId(TESTIDS.moveStart)).toBeDisabled()
      await expect(page.getByTestId(TESTIDS.moveApply)).toBeDisabled()
      expect(await readLocalStorage(page)).toEqual({ [FIXTURE_KEY]: '{broken-layout' })
      await page.getByTestId(TESTIDS.restoreReset).click()
      await page.getByTestId(TESTIDS.resetConfirm).click()
      await expect(page.getByTestId(TESTIDS.restoreStatus)).toHaveCount(0)
      await expect(page.getByTestId(TESTIDS.moveStart)).toBeEnabled()
      expect(await readLocalStorage(page)).toEqual({})
    } finally { await context.close() }
  })

  test('undo remains functional after quota failure and retry persists the undone layout', async ({ browser }) => {
    const { page, context } = await open(browser)
    try {
      await move(page, 'gatehouse', { x: 4, z: 10 })
      const persisted = await record(page, FIXTURE_KEY)
      await page.evaluate(() => {
        const target = window as typeof window & { __native2dQuotaFailure?: boolean }
        target.__native2dQuotaFailure = true
        const original = Storage.prototype.setItem
        Storage.prototype.setItem = function (key: string, value: string) {
          if (target.__native2dQuotaFailure && key.startsWith('possibility.native2d.layout.v1:')) throw new DOMException('布局配额不足', 'QuotaExceededError')
          return original.call(this, key, value)
        }
      })
      await move(page, 'gatehouse', { x: 5, z: 10 })
      await expect(page.getByTestId(TESTIDS.saveStatus)).toContainText('布局配额不足')
      expect(await record(page, FIXTURE_KEY)).toEqual(persisted)
      await page.getByTestId(TESTIDS.undo).click()
      await expect(page.getByTestId(TESTIDS.saveStatus)).toContainText('布局配额不足')
      await expect(page.getByTestId(TESTIDS.undo)).toBeEnabled()
      await page.evaluate(() => { (window as typeof window & { __native2dQuotaFailure?: boolean }).__native2dQuotaFailure = false })
      await tabTo(page, page.getByTestId(TESTIDS.saveRetry), '重试保存')
      await page.keyboard.press('Enter')
      await expect(page.getByTestId(TESTIDS.saveStatus)).toHaveText('布局仅保存在此浏览器')
      expect((await record(page, FIXTURE_KEY))?.placements).toEqual(persisted?.placements)
      await page.reload()
      await ready(page)
      await expect(page.getByTestId(TESTIDS.undo)).toBeDisabled()
      expect((await record(page, FIXTURE_KEY))?.placements).toEqual(persisted?.placements)
      // A fresh canvas drag must start from the restored placement, not just leave the old record on disk.
      await preview(page, 'gatehouse', { x: 5, z: 10 })
      await page.getByTestId(TESTIDS.moveCancel).click()
    } finally { await context.close() }
  })

  test('shows an initial read failure and retries without presenting success', async ({ browser }) => {
    const { page, context } = await createIsolatedSampleContext(browser)
    await page.addInitScript(() => {
      const target = window as typeof window & { __native2dFailInitialRead?: boolean }
      target.__native2dFailInitialRead = true
      const original = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!
      Object.defineProperty(AbortSignal.prototype, 'aborted', {
        ...original,
        get(this: AbortSignal) {
          // Limit the platform fault to the data adapter, leaving viewport startup usable.
          if (target.__native2dFailInitialRead && new Error().stack?.includes('/native2d/world-source.ts')) throw new Error('浏览器首读环境故障')
          return original.get!.call(this)
        },
      })
    })
    try {
      await page.goto('/dev/native-2d')
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('读取失败')
      await expect(page.getByTestId(TESTIDS.readError)).toContainText('浏览器首读环境故障')
      await expect(page.getByTestId(TESTIDS.residentList).locator('button')).toHaveCount(0)
      await expect(page.getByText('暂无可显示的世界数据')).toBeVisible()
      await page.evaluate(() => { (window as typeof window & { __native2dFailInitialRead?: boolean }).__native2dFailInitialRead = false })
      await tabTo(page, page.getByTestId(TESTIDS.readRetry), '重试读取')
      await page.keyboard.press('Enter')
      await ready(page)
      await expect(page.getByTestId(TESTIDS.readError)).toHaveCount(0)
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText('fixture-timeline-mist-manor-001')
    } finally { await context.close() }
  })

  test('keeps the old identity and layout when a new source fails, then clears old interaction on success', async ({ browser }) => {
    const { page, context } = await open(browser)
    await installPublicApiStub(page, { worlds: [
      { kind: 'error', status: 503, message: '公开目标暂不可用' },
      { kind: 'json', body: publicDayResponse() },
    ] })
    try {
      await move(page, 'gatehouse', { x: 4, z: 10 })
      const oldRecord = await record(page, FIXTURE_KEY)
      await page.getByTestId(`native2d-resident-${FIXTURE_PERSON_IDS.shirakawaRei}`).click()
      await page.getByTestId(TESTIDS.followToggle).click()
      await preview(page, 'gatehouse', { x: 5, z: 10 })
      await page.getByTestId(`native2d-resident-${FIXTURE_PERSON_IDS.shirakawaRei}`).click()
      await expect(page.getByTestId(TESTIDS.residentCard)).toBeVisible()
      await expect(page.getByTestId(TESTIDS.followStatus)).toBeVisible()
      const oldFacts = await page.getByTestId(TESTIDS.residentList).textContent() ?? ''
      const oldTime = await page.getByTestId(TESTIDS.worldTime).textContent() ?? ''
      await publicSource(page)
      await expect(page.getByTestId(TESTIDS.staleBadge)).toContainText('当前仍显示上次成功读取的事实')
      await expect(page.getByTestId(TESTIDS.staleBadge)).toContainText('读取雾影庄公开数据失败（HTTP 503）')
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText('固定数据')
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText('fixture-timeline-mist-manor-001')
      await expect(page.getByTestId(TESTIDS.residentList)).toHaveText(oldFacts)
      await expect(page.getByTestId(TESTIDS.worldTime)).toHaveText(oldTime)
      expect(await record(page, FIXTURE_KEY)).toEqual(oldRecord)
      await page.getByTestId(TESTIDS.readRetry).click()
      await ready(page)
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText('公开只读')
      await expect(page.getByTestId(TESTIDS.moveStatus)).toHaveCount(0)
      await expect(page.getByTestId(TESTIDS.residentCard)).toHaveCount(0)
      await expect(page.getByTestId(TESTIDS.followStatus)).toHaveCount(0)
      await expect(page.getByTestId(TESTIDS.undo)).toBeDisabled()
      expect(await record(page, PUBLIC_KEY)).toBeNull()
      await fixtureSource(page)
      expect(await record(page, FIXTURE_KEY)).toEqual(oldRecord)
      await expect(page.getByTestId(TESTIDS.undo)).toBeDisabled()
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText('固定数据')
      await preview(page, 'gatehouse', { x: 5, z: 10 })
      await page.getByTestId(TESTIDS.moveCancel).click()
      expect(await record(page, FIXTURE_KEY)).toEqual(oldRecord)
    } finally { await context.close() }
  })

  test('pauses unrepresented follow, resumes at known positions, and clears a missing target', async ({ browser }) => {
    const { page, context } = await open(browser)
    await installPublicApiStub(page, { worlds: [
      { kind: 'json', body: reiSnapshot('后山散步道', 7) },
      { kind: 'json', body: reiSnapshot('书房', 8) },
      { kind: 'json', body: reiSnapshot('书房', 9) },
      { kind: 'json', body: reiSnapshot('大厅', 10) },
      { kind: 'json', body: reiSnapshot('后山散步道', 11) },
      { kind: 'json', body: reiSnapshot('后山散步道', 12, true) },
    ] })
    try {
      await publicSource(page)
      await ready(page)
      await page.getByTestId(`native2d-resident-${FIXTURE_PERSON_IDS.shirakawaRei}`).click()
      await page.getByTestId(TESTIDS.followToggle).click()
      await expect(page.getByTestId(TESTIDS.followStatus)).toContainText('正在跟随 白川 怜')
      await refreshTo(page, 8)
      await expect(page.getByTestId(TESTIDS.followStatus)).toContainText('保留跟随意图')
      await expect(page.getByTestId(TESTIDS.residentCardLocation)).toContainText('书房')
      await expect(page.getByTestId(TESTIDS.residentCardActivity)).toHaveText('已知活动 8')
      expect((await readDiagnostics(page))?.objectBounds[`resident:${FIXTURE_PERSON_IDS.shirakawaRei}`]).toBeUndefined()
      await refreshTo(page, 9)
      await expect(page.getByTestId(TESTIDS.followStatus)).toContainText('目标在「书房」')
      await refreshTo(page, 10)
      await expect(page.getByTestId(TESTIDS.followStatus)).toContainText('正在跟随 白川 怜')
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('主楼 · 大厅')
      await expect.poll(async () => (await readDiagnostics(page))?.objectBounds[`resident:${FIXTURE_PERSON_IDS.shirakawaRei}`] ?? null).not.toBeNull()
      await refreshTo(page, 11)
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('庄园外景')
      await expect(page.getByTestId(TESTIDS.residentCardLocation)).toHaveText('后山散步道')
      await refreshTo(page, 12)
      await expect(page.getByTestId(TESTIDS.residentCard)).toHaveCount(0)
      await expect(page.getByTestId(TESTIDS.followStatus)).toHaveCount(0)
      await expect(page.getByText('所选居民「白川 怜」已不在最新快照中，选择已清除', { exact: false })).toBeVisible()
      expect((await readDiagnostics(page))?.objectBounds[`resident:${FIXTURE_PERSON_IDS.shirakawaRei}`]).toBeUndefined()
    } finally { await context.close() }
  })

  test('cancel and free pan keep the camera free after a later follow target refresh', async ({ browser }) => {
    const { page, context } = await open(browser)
    await installPublicApiStub(page, { worlds: [
      { kind: 'json', body: reiSnapshot('后山散步道', 7) },
      { kind: 'json', body: reiSnapshot('大厅', 8) },
      { kind: 'json', body: reiSnapshot('后山散步道', 9) },
    ] })
    try {
      await publicSource(page)
      await ready(page)
      await page.getByTestId(`native2d-resident-${FIXTURE_PERSON_IDS.shirakawaRei}`).click()
      await page.getByTestId(TESTIDS.followToggle).click()
      await page.getByTestId(TESTIDS.followToggle).click()
      await refreshTo(page, 8)
      await expect(page.getByTestId(TESTIDS.followStatus)).toHaveCount(0)
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('庄园外景')
      await page.getByTestId(TESTIDS.followToggle).click()
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('主楼 · 大厅')
      await pan(page)
      await expect(page.getByTestId(TESTIDS.followStatus)).toHaveCount(0)
      await refreshTo(page, 9)
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('主楼 · 大厅')
      await expect(page.getByTestId(TESTIDS.followStatus)).toHaveCount(0)
    } finally { await context.close() }
  })

  test('refresh preserves local move history and undo changes only layout, with cancellation and hall edit gates', async ({ browser }) => {
    const { page, context } = await open(browser)
    await installPublicApiStub(page, { worlds: [
      { kind: 'json', body: publicDayResponse() },
      { kind: 'json', body: publicRefreshResponse() },
    ] })
    const requests = createApiRequestRecorder(page)
    try {
      await publicSource(page)
      await ready(page)
      await move(page, 'gatehouse', { x: 4, z: 10 })
      const first = await record(page, PUBLIC_KEY)
      await move(page, 'gatehouse', { x: 5, z: 10 })
      const second = await record(page, PUBLIC_KEY)
      await move(page, 'greenhouse', { x: 11, z: 3 })
      const third = await record(page, PUBLIC_KEY)
      await preview(page, 'gatehouse', { x: 6, z: 10 })
      await page.getByTestId(TESTIDS.moveCancel).click()
      expect(await record(page, PUBLIC_KEY)).toEqual(third)
      await refreshTo(page, 9)
      expect(await record(page, PUBLIC_KEY)).toEqual(third)
      await expect(page.getByTestId(TESTIDS.undo)).toBeEnabled()
      const fresh = createFixtureReadModel('mist-manor-refresh')
      for (const resident of fresh.residents) {
        await page.getByTestId(`native2d-resident-${resident.personId}`).click()
        await expect(page.getByTestId(TESTIDS.residentCardLocation)).toContainText(resident.locationName!)
        await expect(page.getByTestId(TESTIDS.residentCardActivity)).toHaveText(resident.activity!)
      }
      await expect(page.getByTestId(`native2d-resident-${FIXTURE_PERSON_IDS.hiiragiKazunari}`)).toHaveCount(0)
      await expect(page.getByTestId(TESTIDS.worldTime)).toHaveText(new Intl.DateTimeFormat('zh-CN', {
        timeZone: fresh.timeZone, dateStyle: 'medium', timeStyle: 'short', hour12: false,
      }).format(new Date(fresh.simNow!)))
      const facts = await page.getByTestId(TESTIDS.residentList).textContent() ?? ''
      const time = await page.getByTestId(TESTIDS.worldTime).textContent() ?? ''

      for (const expected of [second, first]) {
        await page.getByTestId(TESTIDS.undo).click()
        expect((await record(page, PUBLIC_KEY))?.placements).toEqual(expected?.placements)
        await expect(page.getByTestId(TESTIDS.residentList)).toHaveText(facts)
        await expect(page.getByTestId(TESTIDS.worldTime)).toHaveText(time)
        await expect(page.getByTestId(TESTIDS.stateVersion)).toHaveText('版本 9')
      }
      await page.getByTestId(TESTIDS.undo).click()
      await expect(page.getByTestId(TESTIDS.undo)).toBeDisabled()
      const undone = await record(page, PUBLIC_KEY)
      expect(undone?.placements.map((placement) => [placement.buildingId, placement.origin])).toEqual(
        MIST_MANOR_SCENE.buildings.map((building) => [building.id, building.initialOrigin]),
      )
      await page.getByTestId(TESTIDS.hallEnter).click()
      await expect(page.getByTestId(TESTIDS.moveStart)).toBeDisabled()
      await expect(page.getByTestId(TESTIDS.moveApply)).toBeDisabled()
      await expect(page.getByTestId(TESTIDS.moveStatus)).toHaveCount(0)
      await page.getByTestId(TESTIDS.hallExit).click()
      await page.reload()
      await ready(page)
      await publicSource(page)
      await ready(page)
      expect((await record(page, PUBLIC_KEY))?.placements).toEqual(undone?.placements)
      await expect(page.getByTestId(TESTIDS.undo)).toBeDisabled()
      expect(Object.keys(undone ?? {}).sort()).toEqual(['formatVersion', 'placements', 'savedAt', 'scope'])
      assertReadOnlyApiRequests(requests.records())
    } finally { requests.stop(); await context.close() }
  })

  test('reports storage object and getItem failures, blocks edits, and recovers by retry', async ({ browser }) => {
    for (const mode of ['provider', 'getItem'] as const) {
      const { page, context } = await createIsolatedSampleContext(browser)
      await page.addInitScript((failureMode) => {
        const target = window as typeof window & { __native2dStorageFailure?: boolean }
        target.__native2dStorageFailure = true
        if (failureMode === 'provider') {
          const original = Object.getOwnPropertyDescriptor(window, 'localStorage')!
          Object.defineProperty(window, 'localStorage', {
            ...original,
            get() {
              if (target.__native2dStorageFailure) throw new Error('本地存储对象不可访问')
              return original.get!.call(window)
            },
          })
        } else {
          const original = Storage.prototype.getItem
          Storage.prototype.getItem = function (key: string) {
            if (target.__native2dStorageFailure && key.startsWith('possibility.native2d.layout.v1:')) throw new Error('本地布局读取故障')
            return original.call(this, key)
          }
        }
      }, mode)
      try {
        await page.goto('/dev/native-2d')
        await ready(page)
        await expect(page.getByTestId(TESTIDS.restoreStatus)).toContainText(mode === 'provider' ? '本地存储对象不可访问' : '本地布局读取故障')
        await expect(page.getByTestId(TESTIDS.moveStart)).toBeDisabled()
        await page.evaluate(() => { (window as typeof window & { __native2dStorageFailure?: boolean }).__native2dStorageFailure = false })
        await tabTo(page, page.getByTestId(TESTIDS.restoreRetry), '重新读取')
        await page.keyboard.press('Enter')
        await expect(page.getByTestId(TESTIDS.restoreStatus)).toHaveCount(0)
        await expect(page.getByTestId(TESTIDS.moveStart)).toBeEnabled()
        expect(await readLocalStorage(page)).toEqual({})
      } finally { await context.close() }
    }
  })

  test('failed deletion preserves layout, undo history and other scope records', async ({ browser }) => {
    const { page, context } = await open(browser)
    await installPublicApiStub(page, { worlds: [{ kind: 'json', body: publicDayResponse() }] })
    try {
      await publicSource(page)
      await ready(page)
      await move(page, 'gatehouse', { x: 4, z: 10 })
      const publicRecord = await record(page, PUBLIC_KEY)
      await fixtureSource(page)
      await move(page, 'gatehouse', { x: 4, z: 10 })
      const allBefore = await readLocalStorage(page)
      await page.evaluate(() => {
        const original = Storage.prototype.removeItem
        Storage.prototype.removeItem = function (key: string) {
          if (key.startsWith('possibility.native2d.layout.v1:')) throw new Error('删除布局失败')
          return original.call(this, key)
        }
      })
      await page.getByTestId(TESTIDS.reset).click()
      await expect(page.getByRole('alertdialog')).toContainText('仅删除当前来源、世界与时间线')
      await page.getByTestId(TESTIDS.resetConfirm).click()
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
      await expect(page.getByText('重置失败：删除布局失败（当前布局与本地记录保持不变）')).toBeVisible()
      expect(await readLocalStorage(page)).toEqual(allBefore)
      await expect(page.getByTestId(TESTIDS.undo)).toBeEnabled()
      await page.getByTestId(TESTIDS.undo).click()
      expect((await record(page, FIXTURE_KEY))?.placements.find((placement) => placement.buildingId === 'gatehouse')?.origin).toEqual({ x: 3, z: 10 })
      expect(await record(page, PUBLIC_KEY)).toEqual(publicRecord)
      await publicSource(page)
      await ready(page)
      expect(await record(page, PUBLIC_KEY)).toEqual(publicRecord)
    } finally { await context.close() }
  })

  test('keyboard reaches named important controls with visible focus and activates edit and reset actions', async ({ browser }) => {
    const { page, context } = await open(browser)
    try {
      for (const [id, name] of [[TESTIDS.sourceApply, '载入来源'], [TESTIDS.refresh, '刷新事实'], [TESTIDS.overview, '返回全景'], [TESTIDS.hallEnter, '进入大厅']] as const) {
        await tabTo(page, page.getByTestId(id), name)
      }
      await page.keyboard.press('Enter')
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('主楼 · 大厅')
      await tabTo(page, page.getByTestId(TESTIDS.hallExit), '返回外景')
      await page.keyboard.press('Enter')
      await page.getByTestId(TESTIDS.buildingList).selectOption('gatehouse')
      await tabTo(page, page.getByTestId(TESTIDS.moveStart), '移动建筑')
      await page.keyboard.press('Enter')
      await dragBuilding(page, 'gatehouse', { x: 4, z: 10 })
      await tabTo(page, page.getByTestId(TESTIDS.moveCancel), '取消预览')
      await page.keyboard.press('Enter')
      await expect(page.getByTestId(TESTIDS.undo)).toBeDisabled()
      expect(await readLocalStorage(page)).toEqual({})
      await preview(page, 'gatehouse', { x: 4, z: 10 })
      await tabTo(page, page.getByTestId(TESTIDS.moveApply), '应用位置')
      await page.keyboard.press('Enter')
      await tabTo(page, page.getByTestId(TESTIDS.undo), '撤销')
      await page.keyboard.press('Enter')
      await expect(page.getByTestId(TESTIDS.undo)).toBeDisabled()
      const beforeReset = await readLocalStorage(page)
      await tabTo(page, page.getByTestId(TESTIDS.reset), '重置布局')
      await page.keyboard.press('Enter')
      await tabTo(page, page.getByTestId(TESTIDS.resetCancel), '取消')
      await page.keyboard.press('Enter')
      expect(await readLocalStorage(page)).toEqual(beforeReset)
      await tabTo(page, page.getByTestId(TESTIDS.reset), '重置布局')
      await page.keyboard.press('Enter')
      await tabTo(page, page.getByTestId(TESTIDS.resetConfirm), '确认重置')
      await page.keyboard.press('Enter')
      expect(await readLocalStorage(page)).toEqual({})
    } finally { await context.close() }
  })
})
