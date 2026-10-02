import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const scene = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))
const snapshot = (timelineId = 'timeline-main', simNow = '2026-09-28T20:00:00.000Z') => ({ world: { id: 'world-1', name: '河畔街', description: '生活世界', status: 'running', pauseReason: null, isDemo: false, callsToday: 0, locations: [{ name: '河畔咖啡馆', description: '咖啡馆' }] }, timelines: [{ id: 'timeline-main', parentTimelineId: null, simNow }, { id: 'timeline-other', parentTimelineId: 'timeline-main', simNow: '2026-09-28T12:00:00.000Z' }], currentTimelineId: timelineId, simNow, stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [{ factType: 'environment', value: { condition: 'weather', value: 'rain' } }], locationBoard: [{ location: '河畔咖啡馆', persons: [{ id: 'person-1', name: 'Ada', activity: '读书' }] }], events: [] })

test('shows a live scene and two recorded timeline states in possibility mode', { timeout: 60_000 }, async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [{ id: 'world-1', name: '河畔街' }] } }))
  await page.route('**/api/worlds/world-1/stream**', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }))
  await page.route('**/api/worlds/world-1?*', route => {
    const id = new URL(route.request().url()).searchParams.get('timelineId')
    return route.fulfill({ json: snapshot(id ?? 'timeline-main', id === 'timeline-other' ? '2026-09-28T12:00:00.000Z' : undefined) })
  })
  await page.route('**/api/worlds/world-1/map/bootstrap**', route => {
    const id = new URL(route.request().url()).searchParams.get('timelineId') ?? 'timeline-main'
    const state = snapshot(id, id === 'timeline-other' ? '2026-09-28T12:00:00.000Z' : undefined)
    return route.fulfill({ json: { access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false }, world: state, scene: { status: 'ready', document: scene }, presentation: { timelineId: state.currentTimelineId, stateVersion: state.stateVersion, simNow: state.simNow, timeOfDay: 'night', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] }, theme: { id: 'contemporary-daily-life', assetVersion: 'e2e' }, resume: { worldId: 'world-1', timelineId: state.currentTimelineId, spaceId: 'exterior', mode: 'life', updatedAt: state.simNow } } })
  })
  await page.route('**/api/worlds/world-1/map/resume', route => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/worlds/world-1/scene', route => route.fulfill({ json: { status: 'ready', document: scene, version: 1, contentHash: 'abc', createdAt: '2026-09-28T00:00:00.000Z' } }))
  await page.route('**/api/worlds/world-1/compare?*', route => route.fulfill({ json: {
    worldId: 'world-1', interpretation: 'observed_differences_not_causal_claims', timeAlignment: 'same_sim_time', alignedAt: null, firstDivergence: null,
    left: { id: 'timeline-main', simNow: '2026-09-28T20:00:00.000Z', status: 'active', parentTimelineId: null, historyComplete: true },
    right: { id: 'timeline-other', simNow: '2026-09-28T12:00:00.000Z', status: 'active', parentTimelineId: 'timeline-main', historyComplete: true },
    sharedForkOrigin: { timelineId: 'timeline-main', leftFork: null, rightFork: null },
    differences: { facts: [{ key: 'weather' }], states: [{ personId: 'person-1' }], worldModelVersions: { left: 1, right: 1 }, events: { shared: [], leftOnly: [{ id: 'event-1', simTime: '2026-09-28T18:00:00.000Z' }], rightOnly: [] } },
    limitations: [],
  } }))
  await page.goto('/worlds/world-1?mode=possibility&timeline=timeline-main', { timeout: 60_000 })
  await expect(page.getByTestId('split-title-left')).toBeVisible({ timeout: 30000 })
  await expect(page.getByTestId('split-title-left')).toContainText('原来的发展 · 主线')
  await expect(page.getByTestId('split-title-right')).toContainText('另一种发展 · 分叉')
  await expect(page.getByTestId('split-compare-summary')).toContainText('1 项事实差异、1 组人物状态差异、1 条分支独有事件')
})
