import { afterEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  createEmptyWorld,
  serialize,
  setBlockMut,
  type SceneWorkControl,
  type SerializedVoxelDocument,
  type SerializedVoxelSpaces,
} from '@possibility/voxel-contract'
import { createTestDb } from '../../test/db'
import {
  events,
  persons,
  sceneCompatibilityRequests,
  sceneValidationPolicy,
  timelines,
  users,
  worldPersons,
  worldSceneRevisions,
  worlds,
} from '../../db/schema'
import { commitScene, readCurrentScene, readSceneVersion } from '../repository'
import { confirmCompatibility, createCompatibilityDraft } from './service'
import { loadWorldSceneBindings } from './context'
import type { SceneValidationAccess } from './context'

const NOW = '2026-10-06T00:00:00.000Z'
const ACTOR = { actorKey: 'a13-basis-actor', userId: 'a13-basis-user' }
const control = (): Partial<SceneWorkControl> => ({
  signal: new AbortController().signal,
  nowMs: () => 0,
  yieldControl: async () => {},
})

function validDocument(id: string): SerializedVoxelDocument {
  const doc = createEmptyWorld({ width: 4, height: 3, depth: 4 }, 'mist-manor', id)
  for (let z = 0; z < 4; z += 1) for (let x = 0; x < 4; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

function repairableMultiSpaceDocument(): SerializedVoxelSpaces {
  const garden = validDocument('garden')
  garden.assetPlacements = [{ id: 'flower-1', assetId: 'veg-flower-a', anchor: [1, 0, 1], rotation: 0, seed: 1 }]
  garden.objects.push({
    id: 'keeper', objectType: 'stone-lantern', anchor: { x: 1, y: 0, z: 1 }, rotation: 0,
    binding: { kind: 'person', personId: 'resident-1' },
  })
  garden.objectCells.push({ objectId: 'keeper', cells: [{ x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }] })
  garden.locations = [{ name: 'Library', objectId: 'keeper' }]
  garden.spaceEntries = [
    { spaceId: 'hall', label: 'To hall A', at: { x: 0, y: 1, z: 3 } },
    { spaceId: 'hall', label: 'To hall B', at: { x: 3, y: 1, z: 0 } },
  ]
  return {
    format: 'voxel-spaces', version: 1, defaultSpaceId: 'garden',
    spaces: [
      { id: 'garden', name: 'Garden', document: garden },
      { id: 'hall', name: 'Hall', document: validDocument('hall') },
    ],
  }
}

type BasisChange = {
  name: string
  activePolicy?: { rulesVersion: string; assetManifestHash: string; templateCatalogHash: string }
  changePolicy?: 'rulesVersion' | 'assetManifestHash' | 'templateCatalogHash'
  bindingChange?: 'person' | 'location' | 'connection' | 'protection'
}

describe('A13.4 compatibility preview basis changes', () => {
  const fixtures: ReturnType<typeof createTestDb>[] = []
  afterEach(() => { fixtures.splice(0).forEach(fixture => fixture.close()) })

  const changes: BasisChange[] = [
    {
      name: 'active rules', changePolicy: 'rulesVersion',
      activePolicy: { rulesVersion: 'rules-v1', assetManifestHash: 'assets-v1', templateCatalogHash: 'templates-v1' },
    },
    {
      name: 'asset manifest', changePolicy: 'assetManifestHash',
      activePolicy: { rulesVersion: 'rules-v1', assetManifestHash: 'assets-v1', templateCatalogHash: 'templates-v1' },
    },
    {
      name: 'template catalog', changePolicy: 'templateCatalogHash',
      activePolicy: { rulesVersion: 'rules-v1', assetManifestHash: 'assets-v1', templateCatalogHash: 'templates-v1' },
    },
    {
      name: 'person binding', bindingChange: 'person',
    },
    {
      name: 'location binding', bindingChange: 'location',
    },
    {
      name: 'connection binding', bindingChange: 'connection',
    },
    {
      name: 'protection binding', bindingChange: 'protection',
    },
  ]

  async function seed(worldId: string) {
    const fixture = createTestDb()
    fixtures.push(fixture)
    await fixture.db.insert(users).values({
      id: ACTOR.userId, username: `user-${worldId}`, passwordHash: 'unused', createdAt: NOW,
    })
    await fixture.db.insert(worlds).values({
      id: worldId, userId: ACTOR.userId, name: worldId, description: '',
      locationsJson: JSON.stringify([{ name: 'Library', stableId: 'library-v1' }]),
    })
    const initial = await commitScene(fixture.db, {
      worldId, expectedVersion: 0, requestId: `seed-${worldId}`, document: repairableMultiSpaceDocument(),
      summary: 'initial compatibility source', kind: 'initial',
    })
    return { fixture, initial }
  }

  it.each(changes)('rejects stale confirmation after $name changes without changing current or history', async scenario => {
    const worldId = `a134-${scenario.name.replaceAll(' ', '-')}`
    const { fixture } = await seed(worldId)
    if (scenario.activePolicy) {
      await fixture.db.insert(sceneValidationPolicy).values({ id: 'active', ...scenario.activePolicy, publishedAt: NOW })
    }
    if (scenario.bindingChange === 'person') {
      await fixture.db.insert(persons).values([
        { id: 'resident-1', userId: ACTOR.userId, name: 'Resident One', modelJson: '{}', isUser: false, createdAt: NOW },
        { id: 'resident-2', userId: ACTOR.userId, name: 'Resident Two', modelJson: '{}', isUser: false, createdAt: NOW },
      ])
      await fixture.db.insert(worldPersons).values({ worldId, personId: 'resident-1', joinedAt: NOW })
    }

    const derivedBindings = await loadWorldSceneBindings(fixture.db, worldId)
    const beforeBindings = structuredClone(derivedBindings)
    if (scenario.bindingChange === 'connection') beforeBindings.entries = [derivedBindings.entries[0]!]
    const beforeAccess: SceneValidationAccess = { bindings: beforeBindings }
    const draft = await createCompatibilityDraft(fixture.db, {
      ...ACTOR, worldId, draftRequestId: `draft-${scenario.name}`, purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: beforeAccess, control: control(),
    })
    expect(draft.status).toBe('ready')
    if (draft.status !== 'ready') return
    expect(draft.report).toMatchObject({ status: 'valid' })
    const currentBefore = await readCurrentScene(fixture.db, worldId)
    const historyBefore = await readSceneVersion(fixture.db, worldId, 1)
    const rowsBefore = await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, worldId))

    if (scenario.changePolicy) {
      if (scenario.changePolicy === 'rulesVersion') {
        await fixture.db.update(sceneValidationPolicy).set({ rulesVersion: 'rules-v2' }).where(eq(sceneValidationPolicy.id, 'active'))
      } else if (scenario.changePolicy === 'assetManifestHash') {
        await fixture.db.update(sceneValidationPolicy).set({ assetManifestHash: 'assets-v2' }).where(eq(sceneValidationPolicy.id, 'active'))
      } else {
        await fixture.db.update(sceneValidationPolicy).set({ templateCatalogHash: 'templates-v2' }).where(eq(sceneValidationPolicy.id, 'active'))
      }
    }
    let confirmAccess: SceneValidationAccess = beforeAccess
    if (scenario.bindingChange === 'person') {
      await fixture.db.insert(worldPersons).values({ worldId, personId: 'resident-2', joinedAt: NOW })
      confirmAccess = { bindings: await loadWorldSceneBindings(fixture.db, worldId) }
    }
    if (scenario.bindingChange === 'location') {
      await fixture.db.update(worlds).set({
        locationsJson: JSON.stringify([{ name: 'Library', stableId: 'library-v2' }]),
      }).where(eq(worlds.id, worldId))
      confirmAccess = { bindings: await loadWorldSceneBindings(fixture.db, worldId) }
    }
    if (scenario.bindingChange === 'connection') {
      const changedBindings = structuredClone(derivedBindings)
      changedBindings.entries = [derivedBindings.entries[1]!]
      confirmAccess = { bindings: changedBindings }
    }
    if (scenario.bindingChange === 'protection') {
      const changedBindings = structuredClone(derivedBindings)
      const protectedKeeper = changedBindings.protectedObjects.find(item => item.spaceId === 'garden' && item.objectId === 'keeper')
      if (protectedKeeper) protectedKeeper.reasons.push('owner-protected')
      else changedBindings.protectedObjects.push({ spaceId: 'garden', objectId: 'keeper', reasons: ['owner-protected'] })
      confirmAccess = { bindings: changedBindings }
    }
    const result = await confirmCompatibility(fixture.db, {
      ...ACTOR, worldId, draftId: draft.id, requestId: `confirm-${scenario.name}`,
      expectedCurrentVersion: 1, expectedAttempt: 0, access: confirmAccess, control: control(),
    })

    expect(result.status).toBe('not-committed')
    if (result.status === 'not-committed' && 'error' in result) expect(result.error.code).toBe('basis-changed')
    expect(await readCurrentScene(fixture.db, worldId)).toEqual(currentBefore)
    expect(await readSceneVersion(fixture.db, worldId, 1)).toEqual(historyBefore)
    expect(await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, worldId))).toEqual(rowsBefore)
    expect(await fixture.db.select().from(sceneCompatibilityRequests).where(and(
      eq(sceneCompatibilityRequests.worldId, worldId),
      eq(sceneCompatibilityRequests.requestId, `confirm-${scenario.name}`),
    )).get()).toMatchObject({
      state: 'not-committed', attempt: 0, resultVersion: null, failureCode: 'basis-changed',
    })
  })

  it('allows the same preview after an unrelated life event is added', async () => {
    const worldId = 'a134-life-only'
    const { fixture } = await seed(worldId)
    await fixture.db.insert(timelines).values({
      id: 'a134-life-timeline', worldId, parentTimelineId: null, forkScenarioJson: null,
      simNow: NOW, createdAt: NOW, status: 'active',
    })
    const beforeAccess: SceneValidationAccess = { bindings: await loadWorldSceneBindings(fixture.db, worldId) }
    const draft = await createCompatibilityDraft(fixture.db, {
      ...ACTOR, worldId, draftRequestId: 'life-only-draft', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: beforeAccess, control: control(),
    })
    expect(draft.status).toBe('ready')
    if (draft.status !== 'ready') return
    const originalHistory = await readSceneVersion(fixture.db, worldId, 1)
    await fixture.db.insert(events).values({
      id: 'a134-life-event', timelineId: 'a134-life-timeline', simTime: NOW,
      title: 'A resident watered the garden', description: 'The resident watered a flower after inspection.', kind: 'action',
    })

    const result = await confirmCompatibility(fixture.db, {
      ...ACTOR, worldId, draftId: draft.id, requestId: 'life-only-confirm',
      expectedCurrentVersion: 1, expectedAttempt: 0, access: beforeAccess, control: control(),
    })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.result.version).toBe(2)
    expect(await readSceneVersion(fixture.db, worldId, 1)).toEqual(originalHistory)
    expect(await readCurrentScene(fixture.db, worldId)).toMatchObject({ version: 2, contentHash: result.result.contentHash })
    expect(await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, worldId))).toHaveLength(2)
    expect(await fixture.db.select().from(events).where(eq(events.id, 'a134-life-event'))).toHaveLength(1)
    expect(await fixture.db.select().from(sceneCompatibilityRequests).where(and(
      eq(sceneCompatibilityRequests.worldId, worldId),
      eq(sceneCompatibilityRequests.requestId, 'life-only-confirm'),
    )).get()).toMatchObject({ state: 'completed', attempt: 0, resultVersion: 2, failureCode: null })
  })
})
