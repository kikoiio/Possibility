import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { applyEdits, createEmptyWorld, deserialize, serialize, setBlockMut, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import {
  native2dLayoutHeads, native2dLayoutRevisions, persons, timelineSceneHeads, timelineSceneRevisions,
  worldPersons, worldSceneRevisions, worlds,
} from '../../db/schema'
import { createWorldFixture } from '../../test/world-fixture'
import { scenesRoutes } from '../routes'
import { cloneSceneStatements, commitScene } from '../repository'
import { loadWorldSceneBindings } from './context'
import { inspectSceneCompatibility } from './service'
import type { SceneWriteProof } from './write-proof'
import { buildTestPolicyActivationSql } from '../../../scripts/prepare-scene-compatibility-fixture'
import { cloneWorldGraph } from '../../demo/world-graph-cloner'
import { verifyClonedWorld } from '../../demo/clone-verification'
import { native2dContentHash } from '../../native2d/repository'
import type { Native2dLayout } from '../../native2d/schema'

function validSceneDocument(personId = 'person-source') {
  const base = createEmptyWorld({ width: 4, height: 3, depth: 4 }, 'mist-manor', 'clone-valid')
  const document = applyEdits(base, [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 3, y: 0, z: 3 }, block: 'grass' },
    { kind: 'place-object', objectId: 'bound-lantern', objectType: 'stone-lantern', anchor: { x: 1, y: 1, z: 1 }, rotation: 0 },
  ]).document
  document.objects[0]!.binding = { kind: 'person', personId }
  return document
}

function validScene(personId = 'person-source'): SerializedVoxelDocument {
  return JSON.parse(serialize(validSceneDocument(personId))) as SerializedVoxelDocument
}

function invalidScene(): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 4, height: 3, depth: 4 }, 'mist-manor', 'clone-invalid')
  const document = applyEdits(base, [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 3, y: 0, z: 3 }, block: 'grass' },
    { kind: 'place-object', objectId: 'lantern', objectType: 'stone-lantern', anchor: { x: 1, y: 1, z: 1 }, rotation: 0 },
  ]).document
  document.assetPlacements = [{ id: 'flower', assetId: 'veg-flower-a', anchor: [1, 1, 1], rotation: 0, seed: 1 }]
  return JSON.parse(serialize(document)) as SerializedVoxelDocument
}

function native2dLayout(worldId: string, timelineId: string): Native2dLayout {
  const cells = Array.from({ length: 16 }, (_, index) => ({ x: index % 4, z: Math.floor(index / 4) }))
  return {
    metadata: {
      schema: 'native2d-layout', schemaVersion: 1, layoutVersion: 1, sceneVersion: 1,
      worldId, timelineId, sceneId: 'clone-map',
      spaces: [{ spaceId: 'exterior', kind: 'exterior', width: 4, depth: 4, walkable: cells, connectivityRoot: { x: 0, z: 0 } }],
      buildings: [{ buildingId: 'house', spaceId: 'exterior', footprint: [{ x: 0, z: 0 }], entry: { x: 0, z: 0 } }],
    },
    placements: [{ buildingId: 'house', spaceId: 'exterior', origin: { x: 1, z: 1 } }],
  }
}

async function hashDocument(documentJson: string, version: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ document: JSON.parse(documentJson), version })))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const NOW = '2026-10-06T00:00:00.000Z'
const locationsJson = JSON.stringify([{ name: 'Cafe', description: '' }, { name: 'Library', description: '' }])

describe('I09 clone scene semantics', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createWorldFixture>>> = []
  afterEach(() => fixtures.splice(0).forEach(fixture => fixture.close()))

  it('clones timeline scene identities and native2d revision lineage into the target scope', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    await fixture.db.insert(persons).values({ id: 'person-source', userId: 'owner', name: '来源居民', modelJson: '{}', createdAt: NOW })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'person-source', joinedAt: NOW })
    fixture.sqlite.exec(await buildTestPolicyActivationSql())
    const document = validScene()
    const sourceScope = { worldId: 'home-world', timelineId: 'home-main', representation: 'voxel' }
    await commitScene(fixture.db, { worldId: 'home-world', scope: sourceScope, expectedVersion: 0,
      requestId: 'source-timeline-init', document, summary: 'timeline init', kind: 'initial' })
    const followup = applyEdits(deserialize(JSON.stringify(document)), [
      { kind: 'place-object', objectId: 'clone-person-followup', objectType: 'stone-lantern', anchor: { x: 2, y: 1, z: 2 }, rotation: 0 },
    ]).document
    await commitScene(fixture.db, { worldId: 'home-world', scope: sourceScope, expectedVersion: 1,
      requestId: 'source-timeline-followup', document: JSON.parse(serialize(followup)) as SerializedVoxelDocument, summary: 'timeline follow-up', kind: 'voxel-edit' })

    const layoutOne = native2dLayout('home-world', 'home-main')
    const layoutTwo: Native2dLayout = { ...layoutOne, placements: [{ ...layoutOne.placements[0]!, origin: { x: 2, z: 2 } }] }
    await fixture.db.insert(native2dLayoutRevisions).values([
      { id: 'source-native-v1', worldId: 'home-world', timelineId: 'home-main', sceneId: 'clone-map', version: 1, parentVersion: null,
        requestId: 'source-native-init', contentHash: native2dContentHash(layoutOne), layoutJson: JSON.stringify(layoutOne), createdAt: NOW },
      { id: 'source-native-v2', worldId: 'home-world', timelineId: 'home-main', sceneId: 'clone-map', version: 2, parentVersion: 1,
        requestId: 'source-native-edit', contentHash: native2dContentHash(layoutTwo), layoutJson: JSON.stringify(layoutTwo), createdAt: NOW },
    ])
    await fixture.db.insert(native2dLayoutHeads).values({ worldId: 'home-world', timelineId: 'home-main', sceneId: 'clone-map',
      currentRevisionId: 'source-native-v2', currentVersion: 2, updatedAt: NOW })

    const clone = await cloneWorldGraph(fixture.db, { sourceWorldId: 'home-world', targetOwnerId: 'other', requestId: 'timeline-clone' })
    const cloneTimelineId = clone.timelineIds.get('home-main')!
    const clonePersonId = clone.personIds.get('person-source')!
    const sceneRows = await fixture.db.select().from(timelineSceneRevisions).where(eq(timelineSceneRevisions.worldId, clone.worldId)).all()
    expect(sceneRows).toHaveLength(2)
    const initialCloneScene = sceneRows.find(row => row.version === 1)!
    const followupCloneScene = sceneRows.find(row => row.version === 2)!
    expect(initialCloneScene.timelineId).toBe(cloneTimelineId)
    expect(initialCloneScene.snapshotJson).toContain(clonePersonId)
    expect(initialCloneScene.snapshotJson).not.toContain('person-source')
    for (const row of sceneRows) {
      expect(row.contentHash).toBe(await hashDocument(row.snapshotJson, row.version))
      expect(JSON.parse(row.validationJson!).scope).toEqual({ worldId: clone.worldId, timelineId: cloneTimelineId, representation: 'voxel' })
      expect(row.snapshotJson).toContain(clonePersonId)
      expect(row.snapshotJson).not.toContain('person-source')
      expect(row.snapshotJson).not.toContain('home-main')
      expect(row.validationJson).not.toContain('person-source')
      expect(row.validationJson).not.toContain('home-main')
    }
    expect(followupCloneScene.historyParentRevisionId).toBe(initialCloneScene.id)
    const sceneHead = await fixture.db.select().from(timelineSceneHeads).where(eq(timelineSceneHeads.worldId, clone.worldId)).get()
    expect(sceneRows.find(row => row.id === sceneHead?.currentRevisionId)).toMatchObject({ timelineId: cloneTimelineId, version: sceneHead?.currentVersion })

    const nativeRows = await fixture.db.select().from(native2dLayoutRevisions).where(eq(native2dLayoutRevisions.worldId, clone.worldId)).all()
    expect(nativeRows.map(row => row.parentVersion)).toEqual(expect.arrayContaining([null, 1]))
    for (const row of nativeRows) {
      const layout = JSON.parse(row.layoutJson) as Native2dLayout
      expect(layout.metadata).toMatchObject({ worldId: clone.worldId, timelineId: cloneTimelineId })
      expect(row.contentHash).toBe(native2dContentHash(layout))
    }
    const nativeHead = await fixture.db.select().from(native2dLayoutHeads).where(eq(native2dLayoutHeads.worldId, clone.worldId)).get()
    expect(nativeRows.find(row => row.id === nativeHead?.currentRevisionId)).toMatchObject({ version: nativeHead?.currentVersion, timelineId: cloneTimelineId })
    const verification = await verifyClonedWorld(fixture.db, { sourceWorldId: 'home-world', targetOwnerId: 'other',
      worldId: clone.worldId, mainTimelineId: clone.mainTimelineId, personIds: clone.personIds,
      timelineIds: clone.timelineIds, commandIds: clone.commandIds })
    expect(verification.issues).toEqual([])
  })

  it('remaps clone identities, rebuilds clone-copy proof/hash, diagnoses invalid clones, and rejects HTTP bypass fields', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    await fixture.db.insert(persons).values([
      { id: 'person-source', userId: 'owner', name: '来源居民', modelJson: '{}', createdAt: NOW },
      { id: 'person-copy', userId: 'owner', name: '副本居民', modelJson: '{}', createdAt: NOW },
    ])
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'person-source', joinedAt: NOW })
    fixture.sqlite.exec(await buildTestPolicyActivationSql())

    const sourceOne = validScene()
    await commitScene(fixture.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'source-init', document: sourceOne, summary: 'init', kind: 'initial' })
    const sourceTwoDocument = validSceneDocument()
    setBlockMut(sourceTwoDocument, { x: 3, y: 0, z: 3 }, 'dirt')
    const sourceTwo = JSON.parse(serialize(sourceTwoDocument)) as SerializedVoxelDocument
    await commitScene(fixture.db, { worldId: 'home-world', expectedVersion: 1, requestId: 'source-edit', document: sourceTwo, summary: 'edit', kind: 'voxel-edit' })
    const sourceRows = await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, 'home-world')).all()
    const sourceByVersion = new Map(sourceRows.map(row => [row.version, row]))
    expect(JSON.parse(sourceByVersion.get(2)!.validationJson!) as SceneWriteProof).toMatchObject({ mode: 'valid' })

    await fixture.db.insert(worlds).values({ id: 'valid-copy', userId: 'owner', name: '有效副本', description: '', locationsJson, status: 'running' })
    await fixture.db.insert(worldPersons).values({ worldId: 'valid-copy', personId: 'person-copy', joinedAt: NOW })
    const sourcePointer = (await fixture.db.select().from(worlds).where(eq(worlds.id, 'home-world')).get())!
    const scenePointer = (await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, 'home-world')).all())
    const pointer = { worldId: 'home-world', currentVersion: 2, themeId: 'mist-manor', updatedAt: NOW }
    const cloneStatements = await cloneSceneStatements(fixture.db, {
      sourceWorldId: 'home-world', targetWorldId: 'valid-copy', targetOwnerId: sourcePointer.userId,
      pendingBindings: { personIds: ['person-copy'], locations: [{ name: 'Cafe' }, { name: 'Library' }] },
      pointer, revisions: scenePointer,
      revisionIdFor: async row => `valid-copy-rev-${row.version}`,
      requestIdFor: async row => `valid-copy-req-${row.version}`,
      remapDocument: json => json.replaceAll('person-source', 'person-copy'),
      issuedAt: NOW,
    })
    await fixture.db.batch(cloneStatements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])

    const copiedRows = await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, 'valid-copy')).all()
    expect(copiedRows).toHaveLength(2)
    for (const row of copiedRows) {
      const proof = JSON.parse(row.validationJson!) as SceneWriteProof
      expect(proof.mode).toBe('clone-copy')
      if (proof.mode !== 'clone-copy') continue
      expect(proof.source).toEqual({ worldId: 'home-world', version: row.version, contentHash: sourceByVersion.get(row.version)!.contentHash })
      expect(proof.targetOwnerId).toBe('owner')
      expect(proof.candidate).toEqual({ version: row.version, contentHash: row.contentHash })
      expect(row.validationJson).not.toBe(sourceByVersion.get(row.version)!.validationJson)
      expect(row.documentJson).toContain('person-copy')
      expect(row.documentJson).not.toContain('person-source')
      expect(row.contentHash).toBe(await hashDocument(row.documentJson, row.version))
      expect(row.contentHash).not.toBe(sourceByVersion.get(row.version)!.contentHash)
    }

    await fixture.db.insert(worlds).values({ id: 'invalid-source', userId: 'owner', name: '无效来源', description: '', locationsJson, status: 'running' })
    const invalid = invalidScene()
    await commitScene(fixture.db, { worldId: 'invalid-source', expectedVersion: 0, requestId: 'invalid-init', document: invalid, summary: 'invalid', kind: 'initial' })
    await fixture.db.insert(worlds).values({ id: 'invalid-copy', userId: 'owner', name: '无效副本', description: '', locationsJson, status: 'running' })
    const invalidPointer = { worldId: 'invalid-source', currentVersion: 1, themeId: 'mist-manor', updatedAt: NOW }
    const invalidRows = await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, 'invalid-source')).all()
    await fixture.db.batch(await cloneSceneStatements(fixture.db, {
      sourceWorldId: 'invalid-source', targetWorldId: 'invalid-copy', targetOwnerId: 'owner',
      pendingBindings: { personIds: [], locations: [{ name: 'Cafe' }, { name: 'Library' }] },
      pointer: invalidPointer, revisions: invalidRows,
      revisionIdFor: async row => `invalid-copy-rev-${row.version}`,
      requestIdFor: async row => `invalid-copy-req-${row.version}`,
      remapDocument: json => json,
      issuedAt: NOW,
    }) as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])

    const copiedProof = JSON.parse((await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, 'invalid-copy')).get())!.validationJson!) as SceneWriteProof
    expect(copiedProof.mode).toBe('clone-copy')
    const inspection = await inspectSceneCompatibility(fixture.db, {
      worldId: 'invalid-copy', access: { bindings: await loadWorldSceneBindings(fixture.db, 'invalid-copy') },
    })
    expect(inspection.status).toBe('ready')
    if (inspection.status === 'ready') {
      expect(inspection.report.status).toBe('invalid')
      expect(inspection.canCreateRepairDraft).toBe(true)
      expect(inspection.report.issues.some(issue => issue.code === 'asset-overlap')).toBe(true)
    }

    const before = await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, 'invalid-source')).all()
    const bypass = await scenesRoutes.request('/worlds/invalid-source/scene/voxel-revision', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'http-copy-bypass', expectedVersion: 1, document: invalid,
        mode: 'clone-copy', source: { worldId: 'valid-copy', version: 1, contentHash: 'forged' },
        targetOwnerId: 'owner', validationJson: { mode: 'clone-copy' },
      }),
    }, fixture.env)
    expect(bypass.status).toBe(422)
    expect(await bypass.json()).toMatchObject({ error: '体素场景未通过校验', issues: [{ code: 'asset-overlap' }] })
    expect(await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, 'invalid-source')).all()).toEqual(before)
  })
})
