import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import type { WorldSnapshot } from '../src/api/types'
import {
  TESTIDS,
  assertReadOnlyApiRequests,
  createApiRequestRecorder,
  createIsolatedSampleContext,
  getObjectClickPoint,
} from './fixtures'

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

test.describe('N2D1 live public read', () => {
  test('reads the configured public demo without writes', async ({ browser }) => {
    const { page, context } = await createIsolatedSampleContext(browser)
    const recorder = createApiRequestRecorder(page)
    try {
      await page.goto('/dev/native-2d')
      await page.getByTestId(TESTIDS.sourceKindPublic).click()
      const response = page.waitForResponse((item) => /\/api\/public\/worlds\/[^/?]+(?:\?|$)/.test(item.url()) && item.status() === 200)
      await page.getByTestId(TESTIDS.sourceApply).click()
      const snapshot = await (await response).json() as WorldSnapshot
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新', { timeout: 15_000 })
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText('公开只读')
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText(snapshot.world.id)
      await expect(page.getByTestId(TESTIDS.sourceLabel)).toContainText(snapshot.currentTimelineId)
      await expect(page.getByTestId(TESTIDS.stateVersion)).toHaveText(`版本 ${snapshot.stateVersion}`)
      expect(snapshot.world.name).toContain('雾影庄')
      expect(snapshot.world.locations.map((location) => location.name).sort()).toEqual(['大厅', '书房', '餐厅', '图书室', '温室花房', '门房小屋', '后山散步道'].sort())
      const residents = snapshot.locationBoard.flatMap((entry) => entry.persons.map((person) => ({ ...person, location: entry.location })))
      await expect(page.getByTestId(TESTIDS.residentList).locator('.native2d-list-main')).toHaveCount(residents.length)
      for (const resident of residents) {
        await page.getByTestId(`native2d-resident-${resident.id}`).click()
        await expect(page.getByTestId(TESTIDS.residentCardName)).toHaveText(resident.name)
        await expect(page.getByTestId(TESTIDS.residentCardLocation)).toContainText(resident.location)
        await expect(page.getByTestId(TESTIDS.residentCardActivity)).toHaveText(resident.activity.trim() || '活动未知')
      }
      for (const location of snapshot.world.locations) {
        await page.getByTestId(`native2d-location-${location.name}`).click()
        await expect(page.getByTestId(TESTIDS.locationCard)).toContainText(location.description)
        for (const resident of residents.filter((person) => person.location === location.name)) {
          await expect(page.getByTestId(TESTIDS.locationCard)).toContainText(resident.name)
        }
      }
      await test.info().attach('real-public-snapshot-identity', { body: JSON.stringify({ worldId: snapshot.world.id, timelineId: snapshot.currentTimelineId, stateVersion: snapshot.stateVersion, locations: snapshot.world.locations, residents }, null, 2), contentType: 'application/json' })
      await expect(page.getByTestId(TESTIDS.residentList)).toBeVisible()
      await page.getByTestId(TESTIDS.residentList).locator('button').first().click()
      await expect(page.getByTestId(TESTIDS.residentCard)).toBeVisible()
      await page.getByTestId('native2d-location-大厅').click()
      await expect(page.getByTestId(TESTIDS.locationCard)).toBeVisible()
      await page.getByTestId(TESTIDS.hallEnter).click()
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('主楼 · 大厅')
      await page.getByTestId(TESTIDS.hallExit).click()
      await expect(page.getByTestId(TESTIDS.spaceLabel)).toHaveText('庄园外景')
      const refreshResponse = page.waitForResponse((item) => /\/api\/public\/worlds\/[^/?]+(?:\?|$)/.test(item.url()) && item.status() === 200)
      await page.getByTestId(TESTIDS.refresh).click()
      expect(new URL((await refreshResponse).url()).searchParams.get('timelineId')).toBe(snapshot.currentTimelineId)
      await expect(page.getByTestId(TESTIDS.readStatus)).toHaveText('事实已更新', { timeout: 15_000 })
      await page.getByTestId(TESTIDS.buildingList).selectOption('gatehouse')
      await page.getByTestId(TESTIDS.moveStart).click()
      await dragObject(page, 'building:gatehouse', 44, 22)
      await expect(page.getByTestId(TESTIDS.moveStatus)).toContainText('可应用')
      await page.getByTestId(TESTIDS.moveApply).click()
      await expect(page.getByTestId(TESTIDS.undo)).toBeEnabled()
      await page.getByTestId(TESTIDS.undo).click()
      assertReadOnlyApiRequests(recorder.records())
      const apiRecords = recorder.records()
      expect(apiRecords.every((record) => record.path.startsWith('/api/public/')), JSON.stringify(apiRecords)).toBe(true)
      await mkdir('/tmp/native2d-final-evidence', { recursive: true })
      await writeFile('/tmp/native2d-final-evidence/real-public-identity.json', JSON.stringify({
        worldId: snapshot.world.id, worldName: snapshot.world.name,
        timelineId: snapshot.currentTimelineId, stateVersion: snapshot.stateVersion,
        locations: snapshot.world.locations, residents, requests: apiRecords,
      }, null, 2))
    } finally {
      recorder.stop()
      await context.close()
    }
  })
})
