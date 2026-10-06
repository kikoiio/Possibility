import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { applyEdits, createEmptyWorld, serialize, setBlockMut, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import { persons, worldPersons, worldSceneRevisions, worlds } from '../../db/schema'
import { createWorldFixture } from '../../test/world-fixture'
import { scenesRoutes } from '../routes'
import { cloneSceneStatements, commitScene } from '../repository'
import { loadWorldSceneBindings } from './context'
import { inspectSceneCompatibility } from './service'
import type { SceneWriteProof } from './write-proof'
import { buildTestPolicyActivationSql } from '../../../scripts/prepare-scene-compatibility-fixture'

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

async function hashDocument(documentJson: string, version: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ document: JSON.parse(documentJson), version })))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const NOW = '2026-10-06T00:00:00.000Z'
const locationsJson = JSON.stringify([{ name: 'Cafe', description: '' }, { name: 'Library', description: '' }])

describe('I09 clone scene semantics', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createWorldFixture>>> = []
  afterEach(() => fixtures.splice(0).forEach(fixture => fixture.close()))

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
