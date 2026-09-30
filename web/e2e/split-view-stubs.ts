import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'

/**
 * S1 分屏 e2e 共享 stub:体素文档 + 三时间线快照(左主线/右分叉/第三线供切换)。
 * 时间线:09:00 分叉;共同过去 08:00;左独有 10:00;右独有 09:30(首个分歧)/11:00。
 */
export const voxelDocument = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))

export const NOW = '2026-09-19T12:00:00.000Z'
export const FORK_AT = '2026-09-19T09:00:00.000Z'

const timelines = [
  { id: 'timeline-main', parentTimelineId: null, status: 'active', simNow: NOW, createdAt: '2026-09-18T09:00:00.000Z', forkScenario: null },
  { id: 'timeline-fork', parentTimelineId: 'timeline-main', status: 'active', simNow: NOW, createdAt: '2026-09-18T10:00:00.000Z', forkScenario: { whatIf: '那封信准时送达', changedVariable: '信件是否送达' } },
  { id: 'timeline-fork-2', parentTimelineId: 'timeline-main', status: 'active', simNow: NOW, createdAt: '2026-09-18T11:00:00.000Z', forkScenario: { whatIf: '暴雨没有来', changedVariable: '天气' } },
]

export const events = {
  shared: { id: 'ev-shared-1', simTime: '2026-09-19T08:00:00.000Z', title: '清晨的集市', description: '共同过去' },
  left: { id: 'ev-left-1', simTime: '2026-09-19T10:00:00.000Z', title: '信被退回', description: '主线独有' },
  rightEarly: { id: 'ev-right-1', simTime: '2026-09-19T09:30:00.000Z', title: '信准时送达', description: '分叉线独有' },
  rightLate: { id: 'ev-right-2', simTime: '2026-09-19T11:00:00.000Z', title: '赴约', description: '分叉线独有' },
}

const worldEvent = (e: { id: string; simTime: string; title: string; description: string }) => ({
  ...e, kind: 'action', actorPersonId: null, actorName: null, dialogueId: null, location: null, dialoguePreview: null,
})

export function snapshotFor(timelineId: string) {
  const own = timelineId === 'timeline-main' ? [events.left]
    : timelineId === 'timeline-fork' ? [events.rightEarly, events.rightLate]
    : []
  return {
    world: { id: 'world-1', name: '雾影庄', description: '体素世界', status: 'running', pauseReason: null, isDemo: false, callsToday: 0, locations: [{ name: '主楼', description: '庄园主楼' }] },
    timelines,
    currentTimelineId: timelineId,
    simNow: NOW,
    stateVersion: 1,
    worldModelVersion: 1,
    evidenceStatus: 'structured',
    evidence: { level: 'complete', reasonCodes: [] },
    currentFacts: [],
    locationBoard: [{ location: '主楼', persons: [{ id: 'person-1', name: '小夜', activity: '读书' }] }],
    events: [events.shared, ...own].map(worldEvent),
  }
}

export function comparisonFor(leftId: string, rightId: string) {
  return {
    worldId: 'world-1',
    interpretation: 'observed_differences_not_causal_claims',
    timeAlignment: 'same_sim_time',
    alignedAt: null,
    firstDivergence: rightId === 'timeline-fork' ? { simTime: events.rightEarly.simTime, eventId: events.rightEarly.id, side: 'right' } : null,
    left: { id: leftId, simNow: NOW, status: 'active', parentTimelineId: null, historyComplete: true },
    right: { id: rightId, simNow: NOW, status: 'active', parentTimelineId: 'timeline-main', historyComplete: true },
    sharedForkOrigin: { timelineId: 'timeline-main', leftFork: null, rightFork: { forkTimelineId: rightId, sourceSimTime: FORK_AT } },
    differences: {
      states: [],
      facts: [],
      worldModelVersions: { left: 1, right: 1 },
      events: {
        shared: [events.shared],
        leftOnly: [events.left],
        rightOnly: rightId === 'timeline-fork' ? [events.rightEarly, events.rightLate] : [],
      },
    },
    limitations: ['State values are current observations at each timeline’s own simNow; event differences identify records, not causes.'],
  }
}

export function stubSplitApis(page: Page) {
  return Promise.all([
    page.addInitScript(() => {
      localStorage.setItem('possibility_token', 'e2e-token')
      localStorage.setItem('possibility:flag:voxel', '1')
    }),
    page.route('**/api/worlds', (route) => route.fulfill({ json: { worlds: [{ id: 'world-1', name: '雾影庄' }] } })),
    page.route('**/api/worlds/world-1/stream**', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' })),
    page.route('**/api/worlds/world-1/map/bootstrap**', (route) => {
      const id = new URL(route.request().url()).searchParams.get('timelineId') ?? 'timeline-main'
      const snapshot = snapshotFor(id)
      return route.fulfill({
        json: {
          access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
          world: snapshot,
          scene: { status: 'ready', document: voxelDocument },
          presentation: { timelineId: id, stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
          theme: { id: 'mist-manor', assetVersion: 'e2e' },
          resume: { worldId: 'world-1', timelineId: id, spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow },
        },
      })
    }),
    page.route('**/api/worlds/world-1/map/resume', (route) => route.fulfill({ json: { ok: true } })),
    // 文字视图挂载期请求(未 stub 会打到真实后端 401 跳登录页)
    page.route('**/api/worlds/world-1/persona**', (route) => route.fulfill({ json: { persona: null, unread: 0 } })),
    page.route('**/api/worlds/world-1/state**', (route) => route.fulfill({ json: { timelineId: 'timeline-main', version: 1, worldModelVersion: 1, evidenceStatus: 'structured', current: [], facts: [] } })),
    page.route('**/api/worlds/world-1/return**', (route) => route.fulfill({ json: { timelineId: 'timeline-main', simNow: NOW, firstVisit: false, cursor: 0, events: [], commitments: [], unread: 0 } })),
    page.route('**/api/worlds/world-1/compare?*', (route) => {
      const url = new URL(route.request().url())
      return route.fulfill({ json: comparisonFor(url.searchParams.get('left') ?? 'timeline-main', url.searchParams.get('right') ?? 'timeline-fork') })
    }),
    page.route('**/api/worlds/world-1?*', (route) => {
      const id = new URL(route.request().url()).searchParams.get('timelineId') ?? 'timeline-main'
      return route.fulfill({ json: snapshotFor(id) })
    }),
    page.route('**/voxel-assets/**', (route) => route.fulfill({ status: 404, body: 'not found' })),
  ])
}

/** console/pageerror 红灯收集:任一有红即 FAIL(voxel-assets 404 回退为预期噪音) */
export function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    if (msg.text().includes('Failed to load resource') && (msg.location()?.url ?? '').includes('voxel-assets')) return
    errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))
  return errors
}
