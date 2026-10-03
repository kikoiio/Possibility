import { expect, test, type Page } from '@playwright/test'
import { comparisonFor, NOW, snapshotFor, stubSplitApis, stubTimelines, voxelDocument } from './split-view-stubs'

test.use({ timezoneId: 'America/New_York' })
const model = { identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] }

async function stubExternalFont(page: Page) {
  // The CI/browser sandbox cannot reach Google Fonts; a pending font stylesheet delays paint/effects.
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }))
}

for (const zone of ['Asia/Tokyo', undefined]) {
  test(`same world clock on home, list, person, canvas and comparison (${zone ?? 'legacy UTC'})`, async ({ page }) => {
    await stubExternalFont(page)
    await stubSplitApis(page)
    const time = zone ? '2026-09-19 21:00 (Asia/Tokyo)' : '2026-09-19 12:00 (UTC)'
    const timelines = stubTimelines.map(t => ({ ...t, timeZone: zone }))
    const snapshot = { ...snapshotFor('timeline-main'), world: { ...snapshotFor('timeline-main').world, isDemo: false, timeZone: zone }, timelines }
    const world = { ...snapshot.world, personIds: ['p'], personCount: 1, simNow: NOW, callsToday: 0, todayEventCount: 0, hasScene: true }
    await page.route('**/api/home', route => route.fulfill({ json: { persons: [], worlds: [world], timelines: [] } }))
    await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [world] } }))
    await page.route('**/api/persons/p', route => route.fulfill({ json: {
      person: { id: 'p', name: '林晚', model, createdAt: NOW }, world: { id: 'world-1', name: '雾影庄', description: '', timeZone: zone },
      state: { simTime: NOW, location: '主楼', activity: '读书', mood: '平静', goal: '休息' }, timelines,
    } }))
    await page.route('**/api/timelines/timeline-main', route => route.fulfill({ json: {
      timeline: timelines[0], world: { id: 'world-1', name: '雾影庄', timeZone: zone }, person: { id: 'p', name: '林晚' }, events: [],
      state: { simTime: NOW, location: '主楼', activity: '读书', mood: '平静', goal: '休息' }, evidence: { level: 'incomplete', reasonCodes: [] },
    } }))
    await page.route('**/api/worlds/world-1/map/bootstrap**', route => route.fulfill({ json: {
      access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
      world: snapshot, scene: { status: 'ready', document: voxelDocument },
      presentation: { timelineId: 'timeline-main', stateVersion: 1, simNow: NOW, residents: [], locations: [], signals: [], weather: { kind: null, label: null } },
      theme: { id: 'fixture', assetVersion: 'fixture' }, resume: { timelineId: 'timeline-main', spaceId: 'exterior', mode: 'life' },
    } }))
    await page.route('**/api/worlds/world-1/compare?*', route => route.fulfill({ json: comparisonFor('timeline-main', 'timeline-fork') }))

    await page.goto('/home')
    await expect(page.getByText(`世界时间 ${time}`, { exact: false })).toBeVisible()
    await page.goto('/worlds')
    await expect(page.getByText(`世界时间 ${time}`, { exact: false })).toBeVisible()
    await page.goto('/people/p')
    await expect(page.getByText(time, { exact: false })).toBeVisible()
    await page.getByRole('button', { name: '时间线', exact: true }).click()
    await expect(page.getByText(`时间：${time}`, { exact: false }).first()).toBeVisible()
    await page.goto('/worlds/world-1')
    await expect(page.getByText(`世界时间 ${time}`, { exact: false })).toBeVisible()
    await page.getByRole('button', { name: '对照宇宙', exact: true }).click()
    await expect(page.getByLabel('左侧')).toContainText(time)
    await expect(page.getByLabel('右侧')).toContainText(time)
  })
}

test('failed owner zone save preserves applied clock and draft; retry succeeds without advancing simulation', async ({ page }) => {
  await stubExternalFont(page)
  await stubSplitApis(page)
  const snapshot = snapshotFor('timeline-main')
  await page.route('**/api/worlds/world-1/map/bootstrap**', route => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
    world: { ...snapshot, world: { ...snapshot.world, isDemo: false, timeZone: 'UTC' } }, scene: { status: 'ready', document: voxelDocument },
    presentation: { timelineId: 'timeline-main', stateVersion: 1, simNow: NOW, residents: [], locations: [], signals: [], weather: { kind: null, label: null } },
    theme: { id: 'fixture', assetVersion: 'fixture' }, resume: { timelineId: 'timeline-main', spaceId: 'exterior', mode: 'life' },
  } }))
  let saves = 0
  await page.route('**/api/worlds/world-1/time-zone', route => {
    saves += 1
    expect(route.request().postDataJSON()).toEqual({ timeZone: 'Asia/Tokyo' })
    return saves === 1 ? route.fulfill({ status: 503, json: { error: '暂时无法保存，请重试。' } }) : route.fulfill({ json: { timeZone: 'Asia/Tokyo' } })
  })
  await page.goto('/worlds/world-1')
  await page.getByLabel('世界时区').selectOption('Asia/Tokyo')
  await page.getByRole('button', { name: '保存时区' }).click()
  await expect(page.getByText('暂时无法保存，请重试。')).toBeVisible()
  await expect(page.getByText('世界时间 2026-09-19 12:00 (UTC)', { exact: false })).toBeVisible()
  await expect(page.getByLabel('世界时区')).toHaveValue('Asia/Tokyo')
  await page.getByRole('button', { name: '保存时区' }).click()
  await expect(page.getByText('世界时间 2026-09-19 21:00 (Asia/Tokyo)', { exact: false })).toBeVisible()
  expect(saves).toBe(2)
})
