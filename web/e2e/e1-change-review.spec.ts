import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const now = '2026-09-28T20:00:00.000Z'
const checkpoint = '2026-09-28T18:00:00.000Z'
const scene = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))
const snapshot = {
  world: { id: 'world-1', name: '河畔街', description: '生活世界', status: 'running', pauseReason: null, isDemo: false,
    callsToday: 0, locations: [{ name: '河畔咖啡馆', description: '街角咖啡馆' }] },
  timelines: [{ id: 'timeline-main', parentTimelineId: null, simNow: now, status: 'active', createdAt: now, forkScenario: null }],
  currentTimelineId: 'timeline-main', simNow: now, stateVersion: 3, worldModelVersion: 1, evidenceStatus: 'structured',
  evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [], locationBoard: [], events: [],
}

test('E1 returns a recorded event, expands evidence, and opens F1 from a verified checkpoint', { timeout: 60_000 }, async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [{ id: 'world-1', name: '河畔街' }] } }))
  await page.route('**/api/worlds/world-1/stream**', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }))
  await page.route('**/api/worlds/world-1/map/bootstrap**', route => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
    world: snapshot, scene: { status: 'ready', document: scene },
    presentation: { timelineId: 'timeline-main', stateVersion: 3, simNow: now, timeOfDay: 'night', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
    theme: { id: 'fixture', assetVersion: 'e1' },
    resume: { worldId: 'world-1', timelineId: 'timeline-main', spaceId: 'exterior', mode: 'life', updatedAt: now },
  } }))
  await page.route('**/api/worlds/world-1/map/resume', route => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/worlds/world-1/scene', route => route.fulfill({ json: { status: 'ready', document: scene, version: 1, contentHash: 'e1', createdAt: now } }))
  await page.route('**/api/worlds/world-1/state**', route => route.fulfill({ json: { timelineId: 'timeline-main', version: 3, worldModelVersion: 1, evidenceStatus: 'structured', current: [], facts: [] } }))
  await page.route('**/api/worlds/world-1/return**', route => route.fulfill({ json: {
    timelineId: 'timeline-main', simNow: now, firstVisit: false, cursor: 0, eventCursor: 0, revisionVersion: 0,
    nextEventCursor: 3, nextRevisionVersion: 2, hasMore: false, summary: '新增 1 项记录，其中 1 项状态变化。',
    changes: [{ id: 'fact:weather-1', kind: 'fact', simTime: checkpoint, title: '河畔咖啡馆 · weather已变化',
      description: '记录值：起雾', eventId: 'command:env-1', eventCursor: 3, factId: 'weather-1',
      revisionVersion: 2, sourceCommandId: 'env-1', actorPersonId: null, actorName: null, highlight: 'state_change' }],
    events: [], commitments: [], unread: 0,
  } }))
  let evidenceReadCount = 0
  let evidenceMode: 'complete' | 'unsupported' = 'complete'
  await page.route('**/api/worlds/world-1/events/*/evidence**', route => {
    evidenceReadCount += 1
    if (evidenceReadCount === 1) return route.fulfill({ status: 503, json: { error: '证据服务暂不可用' } })
    const detail = {
    timelineId: 'timeline-main',
    event: { id: 'command:env-1', simTime: checkpoint, title: '河畔咖啡馆天气变化', description: '河畔咖啡馆的天气变为起雾。', kind: 'action', actorPersonId: null, actorName: null, location: '河畔咖啡馆' },
    command: { id: 'env-1', type: 'environment', version: 2, actorName: null },
    facts: [{ id: 'weather-1', factType: 'environment', simTime: checkpoint, version: 2, visibility: 'world',
      subjectId: '河畔咖啡馆:weather', value: { location: '河畔咖啡馆', condition: 'weather', value: '起雾' }, sourceCommandId: 'env-1' }],
    visibleKnowledge: [], stateSnapshot: [{ personName: 'Ada', location: '河畔咖啡馆', activity: '读书', mood: '平静' }],
    reconstruction: { status: 'complete', simTime: checkpoint, version: 2, completeDomains: ['states', 'schedules', 'events'], reason: null },
    gaps: [], forkAvailable: true,
    }
    if (evidenceMode === 'unsupported') return route.fulfill({ json: { ...detail,
      reconstruction: { status: 'unsupported', simTime: null, version: null, completeDomains: [], reason: '基线之前没有可重建状态。' },
      gaps: ['该时点无法完整重建：基线之前没有可重建状态。'], forkAvailable: false,
    } })
    return route.fulfill({ json: detail })
  })
  await page.route('**/api/worlds/world-1/timelines/timeline-main/history', route => route.fulfill({ json: { earliest: '2026-09-28T08:00:00.000Z', simNow: now } }))

  await page.goto('/worlds/world-1')
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 30_000 })
  await page.getByRole('button', { name: '你不在时' }).click()
  await expect(page.getByText('新增 1 项记录，其中 1 项状态变化。')).toBeVisible()
  await page.getByRole('button', { name: '查看来源与当时状态' }).click()
  await expect(page.getByRole('button', { name: '重试读取' })).toBeVisible()
  await page.getByRole('button', { name: '重试读取' }).click()
  await expect(page.getByTestId('event-evidence-detail')).toContainText('记录事实')
  await expect(page.getByTestId('event-evidence-detail')).toContainText('当时状态')
  await expect(page.getByTestId('event-evidence-detail')).toContainText('Ada')
  await page.getByTestId('fork-from-event').click()
  const dialog = page.getByRole('dialog', { name: '创建平行宇宙' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('#fork-what-if')).toHaveValue('围绕“河畔咖啡馆天气变化”探索另一种可能')
  await expect(dialog.getByTestId('fork-moment-input')).toHaveValue(checkpoint.slice(0, 16))
  await dialog.getByRole('button', { name: '取消' }).click()

  evidenceMode = 'unsupported'
  await page.getByRole('button', { name: '你不在时' }).click()
  await page.getByRole('button', { name: '查看来源与当时状态' }).click()
  await expect(page.getByTestId('event-evidence-detail')).toContainText('基线之前没有可重建状态')
  await expect(page.getByTestId('fork-from-event')).toHaveCount(0)
})
