import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const scene = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))

test('mobile world browsing keeps editing controls reachable', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [{ id: 'world-1', name: '河畔街' }] } }))
  await page.route('**/api/worlds/world-1/stream**', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }))
  const snapshot = { world: { id: 'world-1', name: '河畔街', description: '生活世界', status: 'running', pauseReason: null, isDemo: false, callsToday: 0, locations: [] }, timelines: [{ id: 'timeline-main', parentTimelineId: null, simNow: '2026-09-28T12:00:00.000Z' }], currentTimelineId: 'timeline-main', simNow: '2026-09-28T12:00:00.000Z', stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [], locationBoard: [], events: [] }
  await page.route('**/api/worlds/world-1**', route => {
    const url = route.request().url()
    if (url.includes('/map/bootstrap')) return route.fulfill({ json: { access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false }, world: snapshot, scene: { status: 'ready', document: scene }, presentation: { timelineId: 'timeline-main', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] }, theme: { id: 'mist-manor', assetVersion: 'e2e' }, resume: { worldId: 'world-1', timelineId: 'timeline-main', spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow } } })
    if (route.request().method() === 'PUT') return route.fulfill({ json: { ok: true } })
    return route.fulfill({ json: url.includes('/scene') ? { status: 'ready', document: scene, version: 2, contentHash: 'abc', createdAt: snapshot.simNow } : snapshot })
  })
  await page.goto('/worlds/world-1?timeline=timeline-main')
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 30000 })
  // 移动端：干预按钮仍可展开干预面板（当前产品无独立「创造」页签）
  await page.getByRole('button', { name: '干预' }).click()
  await expect(page.getByTestId('inject-overlay')).toBeVisible()
})
