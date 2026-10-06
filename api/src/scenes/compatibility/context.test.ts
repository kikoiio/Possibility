import { afterEach, describe, expect, it } from 'vitest'
import { users, worlds, worldScenes, worldSceneRevisions } from '../../db/schema'
import { createTestDb } from '../../test/db'
import { loadSceneValidationContext, loadWorldSceneBindings } from './context'
import type { SceneBindingContext } from '@possibility/voxel-contract'

const NOW = '2026-10-06T00:00:00.000Z'

describe('scene compatibility context read scope', () => {
  const fixtures: ReturnType<typeof createTestDb>[] = []
  afterEach(() => { fixtures.splice(0).forEach(fixture => fixture.close()) })

  it('loads only the requested world scene and its bindings when another world also has scene history', async () => {
    const fixture = createTestDb()
    fixtures.push(fixture)
    await fixture.db.insert(users).values({ id: 'owner', username: 'owner', passwordHash: 'x', createdAt: NOW })
    await fixture.db.insert(worlds).values([
      { id: 'target-world', userId: 'owner', name: 'Target', description: '', locationsJson: '[{"name":"Target location","stableId":"target-location"}]' },
      { id: 'unrelated-world', userId: 'owner', name: 'Unrelated', description: '', locationsJson: '[{"name":"Unrelated secret","stableId":"unrelated-location"}]' },
    ])

    for (const worldId of ['target-world', 'unrelated-world']) {
      await fixture.db.insert(worldScenes).values({ worldId, currentVersion: 1, themeId: 'mist-manor', updatedAt: NOW })
      await fixture.db.insert(worldSceneRevisions).values({
        id: `${worldId}-v1`, worldId, version: 1, parentVersion: null,
        requestId: `${worldId}-request`, contentHash: `${worldId}-hash`,
        documentJson: JSON.stringify({ format: 'legacy-2d-scene', objects: [], locations: [], spaceEntries: [] }),
        summary: 'legacy fixture', kind: 'initial', compatibilityJson: null, validationJson: null,
        commitGuard: true, createdAt: NOW,
      })
    }

    fixture.queryLog.length = 0
    const bindings = await loadWorldSceneBindings(fixture.db, 'target-world')

    expect(bindings.locations).toEqual([{ name: 'Target location', stableId: 'target-location' }])
    expect(fixture.queryLog.some(({ params }) => params.includes('Unrelated secret') || params.includes('unrelated-location'))).toBe(false)
    const sceneReads = fixture.queryLog.filter(({ query }) => /\bworld_scenes\b|\bworld_scene_revisions\b/.test(query))
    expect(sceneReads.length, JSON.stringify(fixture.queryLog)).toBeGreaterThanOrEqual(2)
    for (const { query, params } of sceneReads) {
      expect(query.toLowerCase()).toMatch(/where[\s\S]*world_id/)
      expect(params).toContain('target-world')
      expect(params).not.toContain('unrelated-world')
    }
  })

  it('fingerprints object keys canonically while preserving array order and meaningful fields', async () => {
    const fixture = createTestDb()
    fixtures.push(fixture)
    const first: SceneBindingContext = {
      personIds: ['ada', 'bo'],
      locations: [{ name: 'Hall', stableId: 'hall' }],
      protectedObjects: [{ spaceId: 'main', objectId: 'door', reasons: ['entry', 'owner'] }],
      protectedPlacements: [], locationBindings: [], personBindings: [], entries: [],
    }
    const reordered = {
      entries: [], personBindings: [], locationBindings: [], protectedPlacements: [],
      protectedObjects: [{ reasons: ['entry', 'owner'], objectId: 'door', spaceId: 'main' }],
      locations: [{ stableId: 'hall', name: 'Hall' }], personIds: ['ada', 'bo'],
    } as SceneBindingContext
    const source = { worldId: 'world', version: 1, contentHash: 'hash' }
    const initialContext = await loadSceneValidationContext(fixture.db, 'world', source, { bindings: first })
    const reorderedContext = await loadSceneValidationContext(fixture.db, 'world', source, { bindings: reordered })
    expect(reorderedContext.bindingHash).toBe(initialContext.bindingHash)
    expect(reorderedContext.contextFingerprint).toBe(initialContext.contextFingerprint)

    const reorderedArray = structuredClone(reordered)
    reorderedArray.personIds.reverse()
    const changedContext = await loadSceneValidationContext(fixture.db, 'world', source, { bindings: reorderedArray })
    expect(changedContext.bindingHash).not.toBe(initialContext.bindingHash)

    const changedMeaning = structuredClone(first)
    changedMeaning.protectedObjects[0]!.reasons.push('new-protection')
    const changedMeaningContext = await loadSceneValidationContext(fixture.db, 'world', source, { bindings: changedMeaning })
    expect(changedMeaningContext.bindingHash).not.toBe(initialContext.bindingHash)
  })
})
