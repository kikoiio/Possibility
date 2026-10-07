import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import type { SerializedVoxelDocument } from '@possibility/voxel-contract'
import type { MapBootstrap, WorldCapabilities } from '../src/api/map'
import type { WorldSnapshot } from '../src/api/types'

export type FixtureSide = 'left' | 'right'
export type FixtureIdentity = 'owner' | 'guest' | 'readonly'
export type FixtureOutcome = 'ready' | 'denied' | 'error' | 'timeout' | 'offline' | 'slow'

/** Fixed latency for the slow-response fixture; slow requests then return a recoverable 503. */
export const PRESENTATION_SLOW_RESPONSE_DELAY_MS = 2500

export interface PresentationFixture {
  identity: FixtureIdentity
  bootstrap: MapBootstrap
}

const sceneJson = readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8')

function capabilities(identity: FixtureIdentity): WorldCapabilities {
  return {
    observe: true,
    participate: identity !== 'readonly',
    editScene: identity === 'owner',
    fork: identity !== 'readonly',
    compare: identity !== 'readonly',
    persist: identity === 'owner',
    resetDemo: identity === 'guest',
  }
}

/** Each invocation owns its complete response graph, including scene data. */
export function createPresentationFixtures(options: {
  sameWorld?: boolean
  leftIdentity?: FixtureIdentity
  rightIdentity?: FixtureIdentity
} = {}): Record<FixtureSide, PresentationFixture> {
  const make = (side: FixtureSide, identity: FixtureIdentity): PresentationFixture => {
    const worldId = side === 'left' || options.sameWorld ? 'presentation-world-a' : 'presentation-world-b'
    const timelineId = `${worldId}-${side === 'left' ? 'main' : 'fork'}`
    const simNow = side === 'left' ? '2026-10-01T08:00:00.000Z' : '2026-10-02T18:00:00.000Z'
    const stateVersion = side === 'left' ? 13 : 29
    const world: WorldSnapshot = {
      world: {
        id: worldId, name: worldId, description: 'Isolated presentation fixture',
        status: 'running', pauseReason: null, isDemo: identity === 'readonly', callsToday: 0,
        locations: [{ name: '主楼', description: 'Independent fixture location' }],
      },
      timelines: ['main', 'fork'].map((kind) => ({
        id: `${worldId}-${kind}`,
        parentTimelineId: kind === 'fork' ? `${worldId}-main` : null,
        status: 'active', simNow, createdAt: '2026-10-01T00:00:00.000Z', forkScenario: null,
      })),
      currentTimelineId: timelineId, simNow, stateVersion, worldModelVersion: 1,
      evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] },
      currentFacts: [], locationBoard: [], events: [],
    }
    return {
      identity,
      bootstrap: {
        access: capabilities(identity), world,
        scene: { status: 'ready', document: JSON.parse(sceneJson) as SerializedVoxelDocument },
        presentation: {
          timelineId, stateVersion, simNow, timeOfDay: side === 'left' ? 'day' : 'dusk',
          weather: { kind: null, label: null }, residents: [],
          locations: [{ name: '主楼', description: 'Independent fixture location', residentCount: 0 }],
          signals: [],
        },
        theme: { id: 'mist-manor', assetVersion: 'presentation-fixture-v1' },
        resume: { worldId, timelineId, spaceId: 'exterior', mode: 'possibility', updatedAt: simNow },
      },
    }
  }
  return {
    left: make('left', options.leftIdentity ?? 'owner'),
    right: make('right', options.rightIdentity ?? 'readonly'),
  }
}

/** Configure one side's failure/retry without mutating the other response. */
export async function installPresentationFixtures(
  page: Page,
  fixtures = createPresentationFixtures(),
  initialOutcomes: Partial<Record<FixtureSide, FixtureOutcome>> = {},
) {
  const outcomes: Record<FixtureSide, FixtureOutcome> = {
    left: initialOutcomes.left ?? 'ready', right: initialOutcomes.right ?? 'ready',
  }
  const reads: { side: FixtureSide; path: string }[] = []
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'presentation-fixture-token'))
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: { id: 'presentation-owner', username: 'presentation-owner' } } }))
  await page.route('**/api/persons', route => route.fulfill({ json: { persons: [] } }))
  await page.route('**/api/worlds', route => route.fulfill({
    status: route.request().method() === 'GET' ? 200 : 405,
    json: { worlds: Object.values(fixtures).map(value => value.bootstrap.world.world) },
  }))
  await page.route('**/api/worlds/*/map/resume', route => route.fulfill({ json: { ok: true } }))
  await page.route(/\/api\/(?:public\/)?worlds\/[^/?]+(?:\/map\/bootstrap|\/scene|\/stream)?(?:\?.*)?$/, async route => {
    const url = new URL(route.request().url())
    const worldId = decodeURIComponent(url.pathname.split('/worlds/')[1].split('/')[0])
    const timelineId = url.searchParams.get('timelineId')
    const side = (['left', 'right'] as const).find(candidate => {
      const bootstrap = fixtures[candidate].bootstrap
      return bootstrap.world.world.id === worldId &&
        (!timelineId || bootstrap.world.currentTimelineId === timelineId)
    })
    if (!side) return route.fulfill({ status: 404, json: { error: 'Unknown fixture world or timeline' } })
    if (route.request().method() !== 'GET') return route.fulfill({ status: 405, json: { error: 'Read fixture only' } })
    reads.push({ side, path: url.pathname })
    const outcome = outcomes[side]
    if (outcome === 'timeout') return route.abort('timedout')
    if (outcome === 'offline') return route.abort('internetdisconnected')
    if (outcome === 'slow') {
      await new Promise(resolve => setTimeout(resolve, PRESENTATION_SLOW_RESPONSE_DELAY_MS))
      return route.fulfill({ status: 503, json: { error: 'Fixture response delayed before temporary outage' } })
    }
    if (outcome !== 'ready') return route.fulfill({
      status: outcome === 'denied' ? 403 : 503,
      json: { error: outcome === 'denied' ? 'Fixture access denied' : 'Fixture unavailable' },
    })
    const bootstrap = structuredClone(fixtures[side].bootstrap)
    if (url.pathname.endsWith('/map/bootstrap')) return route.fulfill({ json: bootstrap })
    if (url.pathname.endsWith('/scene')) return route.fulfill({ json: { ...bootstrap.scene, version: 1, contentHash: 'fixture', createdAt: bootstrap.world.simNow } })
    if (url.pathname.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' })
    return route.fulfill({ json: bootstrap.world })
  })
  return {
    fixtures, reads,
    setOutcome(side: FixtureSide, outcome: FixtureOutcome) { outcomes[side] = outcome },
  }
}
