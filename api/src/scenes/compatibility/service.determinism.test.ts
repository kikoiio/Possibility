import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createEmptyWorld,
  serialize,
  setBlockMut,
  type SceneBindingContext,
  type SceneWorkControl,
  type SerializedVoxelDocument,
  type SerializedVoxelSpaces,
} from '@possibility/voxel-contract'
import { createTestDb } from '../../test/db'
import { users, worldSceneRevisions, worlds } from '../../db/schema'
import { commitScene } from '../repository'
import { createCompatibilityDraft, inspectSceneCompatibility } from './service'
import type { SceneValidationAccess } from './context'

const NOW = '2026-10-06T00:00:00.000Z'
const ACTOR = { actorKey: 'determinism-actor', userId: 'determinism-user' }
const control = (): Partial<SceneWorkControl> => ({
  signal: new AbortController().signal,
  nowMs: () => 0,
  yieldControl: async () => {},
})
const access = (): SceneValidationAccess => ({
  bindings: {
    personIds: ['ada', 'bo'],
    locations: [{ name: 'Library', stableId: 'library' }],
    protectedObjects: [], protectedPlacements: [], locationBindings: [], personBindings: [], entries: [],
  } satisfies SceneBindingContext,
})

const keyReorderedAccess = (): SceneValidationAccess => ({
  bindings: {
    entries: [], personBindings: [], locationBindings: [], protectedPlacements: [], protectedObjects: [],
    locations: [{ stableId: 'library', name: 'Library' }], personIds: ['ada', 'bo'],
  } as SceneBindingContext,
})

const arrayReorderedAccess = (): SceneValidationAccess => ({
  bindings: {
    ...access().bindings,
    personIds: ['bo', 'ada'],
  },
})

function validDocument(id: string): SerializedVoxelDocument {
  const doc = createEmptyWorld({ width: 4, height: 3, depth: 4 }, 'mist-manor', id)
  for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) setBlockMut(doc, { x, y: 0, z }, 'grass')
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

function repairableMultiSpaceDocument(): SerializedVoxelSpaces {
  const garden = validDocument('garden')
  garden.assetPlacements = [{
    id: 'flower-1', assetId: 'veg-flower-a', anchor: [1, 0, 1], rotation: 0, seed: 7,
    vendorPlacement: { z: 'last', a: 'first', order: ['west', 'east'] },
  } as NonNullable<typeof garden.assetPlacements>[number]]
  garden.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: { x: 1, y: 0, z: 1 }, rotation: 0 })
  garden.objectCells.push({ objectId: 'keeper', cells: [{ x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }] })
  const hall = validDocument('hall')
  const gardenRaw = {
    ...garden,
    vendorSceneData: { z: 2, a: 1, orderedSteps: ['inspect', 'repair', 'publish'] },
  }
  const hallRaw = {
    ...hall,
    vendorSceneData: { label: 'untouched hall', orderedSteps: ['north', 'south'] },
  }
  return {
    format: 'voxel-spaces',
    version: 1,
    defaultSpaceId: 'garden',
    spaces: [
      { id: 'garden', name: '花园', document: gardenRaw as SerializedVoxelDocument },
      { id: 'hall', name: '大厅', document: hallRaw as SerializedVoxelDocument },
    ],
    vendorBundleData: { z: 'last', a: 'first', order: ['garden', 'hall'] },
  } as unknown as SerializedVoxelSpaces
}

describe('scene compatibility deterministic inspection and drafts', () => {
  const fixtures: ReturnType<typeof createTestDb>[] = []
  afterEach(() => { fixtures.splice(0).forEach(fixture => fixture.close()) })

  it('repeats inspection and repair draft identically while preserving meaningful array order and extra data', async () => {
    const fixture = createTestDb()
    fixtures.push(fixture)
    await fixture.db.insert(users).values({
      id: 'determinism-user', username: 'determinism-user', passwordHash: 'unused', createdAt: NOW,
    })
    await fixture.db.insert(worlds).values({
      id: 'determinism-world', userId: 'determinism-user', name: 'Determinism', description: '',
    })
    const original = repairableMultiSpaceDocument()
    const seeded = await commitScene(fixture.db, {
      worldId: 'determinism-world', expectedVersion: 0, requestId: 'determinism-seed',
      document: original, summary: 'determinism source', kind: 'initial',
    })

    const inspectionA = await inspectSceneCompatibility(fixture.db, {
      worldId: 'determinism-world', access: access(), control: control(),
    })
    const inspectionB = await inspectSceneCompatibility(fixture.db, {
      worldId: 'determinism-world', access: keyReorderedAccess(), control: control(),
    })
    expect(inspectionA.status).toBe('ready')
    expect(inspectionB).toEqual(inspectionA)
    if (inspectionA.status !== 'ready' || inspectionB.status !== 'ready') return
    expect(inspectionB.basis).toEqual(inspectionA.basis)
    expect(inspectionB.report).toEqual(inspectionA.report)
    const reorderedArrayInspection = await inspectSceneCompatibility(fixture.db, {
      worldId: 'determinism-world', access: arrayReorderedAccess(), control: control(),
    })
    expect(reorderedArrayInspection.status).toBe('ready')
    if (reorderedArrayInspection.status !== 'ready') return
    expect(reorderedArrayInspection.basis.bindingHash).not.toBe(inspectionA.basis.bindingHash)
    expect(reorderedArrayInspection.basis.contextFingerprint).not.toBe(inspectionA.basis.contextFingerprint)

    const createDraft = (draftRequestId: string, draftAccess: SceneValidationAccess) => createCompatibilityDraft(fixture.db, {
      ...ACTOR,
      worldId: 'determinism-world',
      draftRequestId,
      purpose: 'repair-current',
      target: { kind: 'current' },
      expectedCurrentVersion: 1,
      access: draftAccess,
      control: control(),
    })
    const draftA = await createDraft('determinism-draft-a', access())
    const draftB = await createDraft('determinism-draft-b', keyReorderedAccess())
    const draftArrayReordered = await createDraft('determinism-draft-array-order', arrayReorderedAccess())
    expect(draftA.status).toBe('ready')
    expect(draftB.status).toBe('ready')
    expect(draftArrayReordered.status).toBe('ready')
    if (draftA.status !== 'ready' || draftB.status !== 'ready' || draftArrayReordered.status !== 'ready') return
    expect(draftB.basis).toEqual(draftA.basis)
    expect(draftB.report).toEqual(draftA.report)
    expect(draftB.candidate).toEqual(draftA.candidate)
    expect(draftB.changes).toEqual(draftA.changes)
    expect(draftArrayReordered.basis.bindingHash).not.toBe(draftA.basis.bindingHash)
    expect(draftA.basis.baseline).toBeNull()

    const rawCandidate = draftA.candidate as unknown as Record<string, unknown>
    const candidateSpaces = rawCandidate.spaces as Array<{ id: string; document: Record<string, unknown> }>
    expect(candidateSpaces.map(space => space.id)).toEqual(['garden', 'hall'])
    expect(rawCandidate.vendorBundleData).toEqual({ z: 'last', a: 'first', order: ['garden', 'hall'] })
    expect(candidateSpaces[0]!.document.vendorSceneData).toEqual({
      z: 2, a: 1, orderedSteps: ['inspect', 'repair', 'publish'],
    })
    const candidatePlacements = candidateSpaces[0]!.document.assetPlacements as Array<Record<string, unknown>>
    expect(candidatePlacements[0]).toMatchObject({
      vendorPlacement: { z: 'last', a: 'first', order: ['west', 'east'] },
    })
    expect(candidateSpaces[1]!.document).toEqual(original.spaces[1]!.document)
    expect(await fixture.db.select().from(worldSceneRevisions)
      .where(eq(worldSceneRevisions.worldId, 'determinism-world'))).toHaveLength(1)
    expect(seeded.version).toBe(1)
  })
})
