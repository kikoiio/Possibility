import { expect, test } from '@playwright/test'

test('mobile world browsing stays read only and explains desktop editing', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [{ id: 'world-1', name: '河畔街' }] } }))
  await page.route('**/api/worlds/world-1/stream**', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }))
  const scene = { schemaVersion: 1, themeId: 'contemporary-daily-life', size: { columns: 24, rows: 18 }, version: 2, terrain: [], paths: [], lockedObjectIds: [], lockedAreas: [], objects: [{ id: 'cafe', assetId: 'cafe-corner', position: { x: 8, y: 6 }, binding: { kind: 'location', locationName: '河畔咖啡馆' }, label: '河畔咖啡馆', purpose: null }] }
  const snapshot = { world: { id: 'world-1', name: '河畔街', description: '生活世界', status: 'running', pauseReason: null, isDemo: false, callsToday: 0, locations: [] }, timelines: [{ id: 'timeline-main', parentTimelineId: null, simNow: '2026-09-28T12:00:00.000Z' }], currentTimelineId: 'timeline-main', simNow: '2026-09-28T12:00:00.000Z', stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [], locationBoard: [], events: [] }
  await page.route('**/api/worlds/world-1**', route => {
    const url = route.request().url()
    if (url.includes('/map/bootstrap')) return route.fulfill({ json: { access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false }, world: snapshot, scene: { status: 'ready', document: scene }, presentation: { timelineId: 'timeline-main', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] }, theme: { id: 'contemporary-daily-life', assetVersion: 'e2e' }, resume: { worldId: 'world-1', timelineId: 'timeline-main', spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow } } })
    if (route.request().method() === 'PUT') return route.fulfill({ json: { ok: true } })
    return route.fulfill({ json: url.includes('/scene') ? { status: 'ready', document: scene, version: 2, contentHash: 'abc', createdAt: snapshot.simNow } : snapshot })
  })
  await page.goto('/worlds/world-1?timeline=timeline-main')
  await page.getByRole('tab', { name: '创造' }).click()
  await expect(page.getByText(/完整的场景创造和编辑建议在桌面端完成/)).toBeVisible()
})
