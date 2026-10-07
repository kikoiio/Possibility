import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { applyEdits, createEmptyWorld, isSerializedVoxelDocument, serialize, type EditOperation, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import { compatibilityRoutes } from './routes'
import { commitScene } from '../repository'
import { createWorldFixture, WORLD_TIME } from '../../test/world-fixture'
import {
  conversations, events, memories, messages, personStates, persons, schedules,
  timelines, universeEvidence, worldCommands, worldPersons,
} from '../../db/schema'

const ownerHeaders = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
const compatibilityPath = '/worlds/home-world/scene/compatibility'

function validDocument(): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'scope-valid')
  const document = applyEdits(base, [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
  ]).document
  return JSON.parse(serialize(document)) as SerializedVoxelDocument
}

function repairableDocument(): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'scope-invalid')
  const operations: EditOperation[] = [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
    { kind: 'place-object', objectId: 'lantern-1', objectType: 'stone-lantern', anchor: { x: 2, y: 1, z: 2 }, rotation: 0 },
    { kind: 'place-asset', assetId: 'veg-flower-a', placementId: 'flower-1', anchor: { x: 2, y: 1, z: 2 }, rotation: 0 },
  ]
  return JSON.parse(serialize(applyEdits(base, operations).document)) as SerializedVoxelDocument
}

function call(f: Awaited<ReturnType<typeof createWorldFixture>>, path: string, init?: RequestInit) {
  return compatibilityRoutes.request(path, init, f.env)
}

function post(f: Awaited<ReturnType<typeof createWorldFixture>>, path: string, body: unknown) {
  return call(f, path, { method: 'POST', headers: ownerHeaders, body: JSON.stringify(body) })
}

const LIFE_TABLES = [
  'person_states', 'schedules', 'memories', 'events', 'world_commands', 'world_facts',
  'conversations', 'messages', 'chat_requests', 'dialogues', 'dialogue_turns',
] as const
const UNIVERSE_TABLES = ['worlds', 'timelines', 'world_model_versions', 'universe_revisions', 'universe_evidence', 'timeline_anchors'] as const

function snapshotTables(f: Awaited<ReturnType<typeof createWorldFixture>>, tables: readonly string[]) {
  return Object.fromEntries(tables.map(table => [
    table,
    f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]))
}

function preventLifeMutation(f: Awaited<ReturnType<typeof createWorldFixture>>) {
  for (const table of LIFE_TABLES) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      f.sqlite.exec(`CREATE TRIGGER scope_guard_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
        BEGIN SELECT RAISE(ABORT, 'compatibility route touched life/chat/action data'); END`)
    }
  }
}

async function seedLifeAndChat(f: Awaited<ReturnType<typeof createWorldFixture>>) {
  await f.db.insert(universeEvidence).values({ timelineId: 'other-main', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_fixture_complete"]', assessedAt: WORLD_TIME })
  await f.db.insert(persons).values([
    { id: 'scope-home-person', userId: 'owner', name: 'Home resident', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'scope-other-person', userId: 'other', name: 'Other resident', modelJson: '{}', createdAt: WORLD_TIME },
  ])
  await f.db.insert(worldPersons).values([
    { worldId: 'home-world', personId: 'scope-home-person', joinedAt: WORLD_TIME },
    { worldId: 'other-world', personId: 'scope-other-person', joinedAt: WORLD_TIME },
  ])
  await f.db.insert(personStates).values([
    { personId: 'scope-home-person', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe', activity: 'reading', mood: 'calm', goal: 'finish a book', updatedRealAt: WORLD_TIME, currentDialogueId: null, lastBeatSimTime: WORLD_TIME },
    { personId: 'scope-other-person', timelineId: 'other-main', simTime: WORLD_TIME, location: 'Library', activity: 'writing', mood: 'focused', goal: 'write a letter', updatedRealAt: WORLD_TIME, currentDialogueId: null, lastBeatSimTime: WORLD_TIME },
  ])
  await f.db.insert(schedules).values([
    { personId: 'scope-home-person', timelineId: 'home-main', worldDate: '2026-09-21', itemsJson: '[{"start":"08:00","activity":"reading"}]', generatedAt: WORLD_TIME, createdVersion: 0 },
    { personId: 'scope-other-person', timelineId: 'other-main', worldDate: '2026-09-21', itemsJson: '[{"start":"08:00","activity":"writing"}]', generatedAt: WORLD_TIME, createdVersion: 0 },
  ])
  await f.db.insert(memories).values([
    { id: 'scope-home-memory', personId: 'scope-home-person', timelineId: 'home-main', type: 'world', content: 'Home memory sentinel', simTime: WORLD_TIME, createdAt: WORLD_TIME },
    { id: 'scope-other-memory', personId: 'scope-other-person', timelineId: 'other-main', type: 'world', content: 'Other memory sentinel', simTime: WORLD_TIME, createdAt: WORLD_TIME },
  ])
  await f.db.insert(events).values([
    { id: 'scope-home-event', timelineId: 'home-main', simTime: WORLD_TIME, title: 'Home action', description: 'Home action sentinel', kind: 'action', actorPersonId: 'scope-home-person' },
    { id: 'scope-other-event', timelineId: 'other-main', simTime: WORLD_TIME, title: 'Other action', description: 'Other action sentinel', kind: 'action', actorPersonId: 'scope-other-person' },
  ])
  await f.db.insert(worldCommands).values([
    { id: 'scope-home-command', worldId: 'home-world', timelineId: 'home-main', actorKind: 'person', actorId: 'scope-home-person', type: 'move', payloadJson: '{}', expectedVersion: 0, resultVersion: 1, createdAt: WORLD_TIME },
    { id: 'scope-other-command', worldId: 'other-world', timelineId: 'other-main', actorKind: 'person', actorId: 'scope-other-person', type: 'move', payloadJson: '{}', expectedVersion: 0, resultVersion: 1, createdAt: WORLD_TIME },
  ])
  await f.db.insert(conversations).values([
    { id: 'scope-home-chat', userId: 'owner', personId: 'scope-home-person', timelineId: 'home-main' },
    { id: 'scope-other-chat', userId: 'other', personId: 'scope-other-person', timelineId: 'other-main' },
  ])
  await f.db.insert(messages).values([
    { id: 'scope-home-message', conversationId: 'scope-home-chat', role: 'person', content: 'Home chat sentinel', createdAt: WORLD_TIME },
    { id: 'scope-other-message', conversationId: 'scope-other-chat', role: 'person', content: 'Other chat sentinel', createdAt: WORLD_TIME },
  ])
}

describe('A1 compatibility scope', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createWorldFixture>>> = []
  afterEach(() => fixtures.splice(0).forEach(f => f.close()))

  it('inspect, repair confirm and history restore stay within scene history and preserve every life/chat/action row', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    await seedLifeAndChat(f)
    await commitScene(f.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'scope-home-v1', document: validDocument(), summary: 'valid base', kind: 'initial' })
    await commitScene(f.db, { worldId: 'home-world', expectedVersion: 1, requestId: 'scope-home-v2', document: repairableDocument(), summary: 'legacy invalid scene', kind: 'voxel-edit' })
    await commitScene(f.db, { worldId: 'other-world', expectedVersion: 0, requestId: 'scope-other-v1', document: validDocument(), summary: 'other scene', kind: 'initial' })

    const lifeBefore = snapshotTables(f, LIFE_TABLES)
    const universeBefore = snapshotTables(f, UNIVERSE_TABLES)
    const targetSceneBefore = {
      pointer: f.sqlite.prepare('SELECT * FROM world_scenes WHERE world_id = ?').all('home-world'),
      revisions: f.sqlite.prepare('SELECT * FROM world_scene_revisions WHERE world_id = ? ORDER BY version').all('home-world') as Array<Record<string, unknown>>,
    }
    expect(targetSceneBefore.pointer).toMatchObject([{ current_version: 2 }])
    const otherSceneBefore = {
      pointer: f.sqlite.prepare('SELECT * FROM world_scenes WHERE world_id = ?').all('other-world'),
      revisions: f.sqlite.prepare('SELECT * FROM world_scene_revisions WHERE world_id = ? ORDER BY version').all('other-world'),
    }
    preventLifeMutation(f)
    f.queryLog.length = 0

    const inspectCurrent = await call(f, `${compatibilityPath}/inspection`, { headers: ownerHeaders })
    expect(inspectCurrent.status).toBe(200)
    expect(await inspectCurrent.json()).toMatchObject({ status: 'ready', report: { status: 'invalid' }, canCreateRepairDraft: true })
    const inspectHistory = await call(f, `${compatibilityPath}/inspection?version=1`, { headers: ownerHeaders })
    expect(inspectHistory.status).toBe(200)
    expect(await inspectHistory.json()).toMatchObject({ status: 'ready', source: { version: 1 }, report: { status: 'valid' } })

    const repairDraftResponse = await post(f, `${compatibilityPath}/drafts`, {
      draftRequestId: 'scope-repair-draft', purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 2,
    })
    expect(repairDraftResponse.status).toBe(200)
    const repairDraft = await repairDraftResponse.json() as { id: string; status: string; canConfirm: boolean }
    expect(repairDraft).toMatchObject({ status: 'ready', canConfirm: true })
    const repairConfirm = await post(f, `${compatibilityPath}/confirm`, {
      draftId: repairDraft.id, requestId: 'scope-repair-request', expectedCurrentVersion: 2, expectedAttempt: 0,
    })
    expect(repairConfirm.status, await repairConfirm.clone().text()).toBe(200)
    expect(await repairConfirm.json()).toMatchObject({ status: 'completed', result: { version: 3, outcome: 'repaired-current' } })

    const restoreDraftResponse = await post(f, `${compatibilityPath}/drafts`, {
      draftRequestId: 'scope-restore-draft', purpose: 'restore-history', target: { kind: 'history', version: 1 }, expectedCurrentVersion: 3,
    })
    expect(restoreDraftResponse.status).toBe(200)
    const restoreDraft = await restoreDraftResponse.json() as { id: string; status: string; canConfirm: boolean; changes: { total: number } }
    expect(restoreDraft).toMatchObject({ status: 'ready', canConfirm: true, changes: { total: 0 } })
    const restoreConfirm = await post(f, `${compatibilityPath}/confirm`, {
      draftId: restoreDraft.id, requestId: 'scope-restore-request', expectedCurrentVersion: 3, expectedAttempt: 0,
    })
    expect(restoreConfirm.status).toBe(200)
    expect(await restoreConfirm.json()).toMatchObject({ status: 'completed', result: { version: 4, outcome: 'restored-history' } })

    const routeQueries = [...f.queryLog]
    expect(snapshotTables(f, LIFE_TABLES)).toEqual(lifeBefore)
    expect(snapshotTables(f, UNIVERSE_TABLES)).toEqual(universeBefore)

    const targetRows = f.sqlite.prepare('SELECT * FROM world_scene_revisions WHERE world_id = ? ORDER BY version').all('home-world') as Array<Record<string, unknown>>
    expect(targetRows).toHaveLength(4)
    expect(targetRows.slice(0, 2)).toEqual(targetSceneBefore.revisions)
    expect(f.sqlite.prepare('SELECT * FROM world_scenes WHERE world_id = ?').all('other-world')).toEqual(otherSceneBefore.pointer)
    expect(f.sqlite.prepare('SELECT * FROM world_scene_revisions WHERE world_id = ? ORDER BY version').all('other-world')).toEqual(otherSceneBefore.revisions)
    expect(JSON.parse(String(targetRows[3].document_json))).toEqual(JSON.parse(String(targetRows[0].document_json)))
    expect(targetRows.every(row => isSerializedVoxelDocument(JSON.parse(String(row.document_json))))).toBe(true)
    expect(f.sqlite.prepare('SELECT current_version FROM world_scenes WHERE world_id = ?').get('home-world')).toMatchObject({ current_version: 4 })

    const writeQueries = routeQueries.filter(({ query }) => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(query))
    expect(writeQueries.length).toBeGreaterThan(0)
    expect(writeQueries.every(({ query }) => /\b(?:scene_compatibility_drafts|scene_compatibility_requests|world_scene_revisions|world_scenes)\b/i.test(query))).toBe(true)
    expect(writeQueries.every(({ params }) => !params.includes('other-world'))).toBe(true)
    const scopedQueries = routeQueries.filter(({ query }) => /\b(?:worlds|world_persons|world_scenes|world_scene_revisions|scene_compatibility_drafts|scene_compatibility_requests|person_states|schedules|memories|events|world_commands|world_facts|conversations|messages)\b/i.test(query))
    expect(scopedQueries.every(({ params }) => !params.includes('other-world'))).toBe(true)
    expect(routeQueries.some(({ query }) => /\b(?:person_states|schedules|memories|events|world_commands|world_facts|conversations|messages|chat_requests|dialogues|dialogue_turns)\b/i.test(query))).toBe(false)
  })

  it('binds A1 drafts and reads to the exact timeline, even when another scope has the same version and hash', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    await f.db.insert(timelines).values([
      { id: 'scope-peer', worldId: 'home-world', simNow: WORLD_TIME, createdAt: WORLD_TIME, status: 'active', ancestorIdsJson: '[]' },
      { id: 'scope-empty', worldId: 'home-world', simNow: WORLD_TIME, createdAt: WORLD_TIME, status: 'active', ancestorIdsJson: '[]' },
    ])
    const mainScope = { worldId: 'home-world', timelineId: 'home-main', representation: 'voxel' }
    const peerScope = { worldId: 'home-world', timelineId: 'scope-peer', representation: 'voxel' }
    const invalid = repairableDocument()
    const mainScene = await commitScene(f.db, { worldId: 'home-world', scope: mainScope, expectedVersion: 0,
      requestId: 'scope-main-initial', document: invalid, summary: 'main invalid scene', kind: 'initial' })
    await commitScene(f.db, { worldId: 'home-world', scope: peerScope, expectedVersion: 0,
      requestId: 'scope-peer-initial', document: invalid, summary: 'peer invalid scene', kind: 'initial' })
    // A different legacy world head must never be used as a timeline fallback.
    await commitScene(f.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'scope-legacy-initial',
      document: validDocument(), summary: 'legacy scene', kind: 'initial' })

    const inspect = await call(f, `${compatibilityPath}/inspection?timelineId=home-main&representation=voxel`, { headers: ownerHeaders })
    expect(inspect.status).toBe(200)
    expect(await inspect.json()).toMatchObject({ status: 'ready', source: {
      timelineId: 'home-main', representation: 'voxel', version: 1, contentHash: mainScene.contentHash,
    }, report: { status: 'invalid' } })

    const unknownSpace = await call(f, `${compatibilityPath}/inspection?timelineId=home-main&spaceId=not-in-the-scene`, { headers: ownerHeaders })
    expect(unknownSpace.status).toBe(404)
    expect(await unknownSpace.json()).toMatchObject({ errorCode: 'scene-missing' })

    const missingHead = await call(f, `${compatibilityPath}/inspection?timelineId=scope-empty&representation=voxel`, { headers: ownerHeaders })
    expect(missingHead.status).toBe(404)
    expect(await missingHead.json()).toMatchObject({ errorCode: 'scene-missing' })

    const draftResponse = await post(f, `${compatibilityPath}/drafts`, {
      timelineId: 'home-main', representation: 'voxel', draftRequestId: 'scope-main-draft',
      purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 1,
    })
    expect(draftResponse.status).toBe(200)
    const draft = await draftResponse.json() as { id: string }
    const crossTimelineRead = await call(f, `${compatibilityPath}/drafts/${draft.id}?timelineId=scope-peer&representation=voxel`, { headers: ownerHeaders })
    expect(crossTimelineRead.status).toBe(404)
    expect(await crossTimelineRead.json()).toMatchObject({ errorCode: 'draft-unavailable' })

    await f.db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-main'))
    const archivedInspection = await call(f, `${compatibilityPath}/inspection?timelineId=home-main`, { headers: ownerHeaders })
    expect(archivedInspection.status).toBe(200)
    const archivedPreflight = await post(f, `${compatibilityPath}/preflight`, {
      timelineId: 'home-main', candidate: { kind: 'document', document: validDocument() },
    })
    expect(archivedPreflight.status).toBe(409)
    expect(await archivedPreflight.json()).toMatchObject({ errorCode: 'edit-forbidden' })
  })
})
