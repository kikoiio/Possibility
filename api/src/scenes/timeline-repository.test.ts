import { afterEach, expect, it } from 'vitest'
import { applyEdits, createEmptyWorld, serialize, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import { eq, inArray } from 'drizzle-orm'
import { createWorldFixture } from '../test/world-fixture'
import { events, personStates, persons, timelines, timelineSceneHeads, timelineSceneRevisions, universeRevisions, worldCommands, worldFacts, worldPersons } from '../db/schema'
import { forkTimeline } from '../life/fork'
import {
  commitTimelineScene, listTimelineSceneHistory, readCurrentTimelineScene,
  restoreTimelineSceneFromAncestor, SceneConflict, TimelineSceneConflict, TimelineSceneIntegrityError,
} from './repository'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

function scene(block: 'grass' | 'stone' = 'grass'): SerializedVoxelDocument {
  const empty = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'timeline-scene')
  const document = applyEdits(empty, [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block },
  ]).document
  return JSON.parse(serialize(document)) as SerializedVoxelDocument
}

const scope = (timelineId: string, worldId = 'home-world') => ({ worldId, timelineId, representation: 'voxel' })

it('forks complete scene snapshots, bounds history to the selected lineage, and restores ancestors as new child revisions', async () => {
  fixture = await createWorldFixture()
  const db = fixture.db
  const rootV1 = await commitTimelineScene(db, { scope: scope('home-main'), expectedVersion: 0,
    requestId: 'scene-root-v1', document: scene('grass'), summary: 'root v1', kind: 'initial' })
  // Keep the fork cutoff unambiguous even when consecutive operations share a
  // millisecond clock tick in the test runtime.
  await db.update(timelineSceneRevisions).set({ createdAt: '2026-09-21T08:00:01.000Z' })
    .where(eq(timelineSceneRevisions.id, rootV1.id))

  const child = await forkTimeline(db, 'home-world', 'home-main', null, 'scene-child-fork')
  const sibling = await forkTimeline(db, 'home-world', 'home-main', null, 'scene-sibling-fork')
  await db.update(timelines).set({ createdAt: '2026-09-21T08:00:02.000Z' })
    .where(inArray(timelines.id, [child.id, sibling.id]))
  expect(await readCurrentTimelineScene(db, scope(child.id))).toMatchObject({
    timelineId: child.id, version: 1, document: rootV1.document,
  })
  expect(await readCurrentTimelineScene(db, scope(sibling.id))).toMatchObject({
    timelineId: sibling.id, version: 1, document: rootV1.document,
  })

  const rootV2 = await commitTimelineScene(db, { scope: scope('home-main'), expectedVersion: 1,
    requestId: 'scene-root-v2', document: scene('stone'), summary: 'root v2', kind: 'voxel-edit' })
  const childV2 = await commitTimelineScene(db, { scope: scope(child.id), expectedVersion: 1,
    requestId: 'scene-child-v2', document: scene('stone'), summary: 'child v2', kind: 'voxel-edit' })
  expect(rootV2.version).toBe(2)
  expect(childV2.version).toBe(2)
  expect(await readCurrentTimelineScene(db, scope(sibling.id))).toMatchObject({ version: 1, document: rootV1.document })

  const history = await listTimelineSceneHistory(db, scope(child.id), { limit: 10 })
  expect(history?.revisions.map(revision => [revision.timelineId, revision.version, revision.source]))
    .toEqual([[child.id, 2, 'current'], [child.id, 1, 'current'], ['home-main', 1, 'ancestor']])
  expect(history?.boundaries).toEqual([{ fromTimelineId: child.id, toTimelineId: 'home-main', revisionId: rootV1.id }])
  expect(history?.revisions.some(revision => revision.id === rootV2.id)).toBe(false)

  const beforeConflict = await db.select().from(timelineSceneRevisions).where(eq(timelineSceneRevisions.timelineId, child.id))
  await expect(commitTimelineScene(db, { scope: scope(child.id), expectedVersion: 1,
    requestId: 'scene-stale-write', document: scene('grass'), summary: 'stale', kind: 'voxel-edit' }))
    .rejects.toBeInstanceOf(TimelineSceneConflict)
  expect(await db.select().from(timelineSceneRevisions).where(eq(timelineSceneRevisions.timelineId, child.id)))
    .toEqual(beforeConflict)

  const replay = await commitTimelineScene(db, { scope: scope(child.id), expectedVersion: 0,
    requestId: 'scene-child-v2', document: scene('stone'), summary: 'replay', kind: 'voxel-edit' })
  expect(replay).toMatchObject({ id: childV2.id, version: 2 })
  expect(await db.select().from(timelineSceneRevisions).where(eq(timelineSceneRevisions.timelineId, child.id)))
    .toHaveLength(2)
  await expect(commitTimelineScene(db, { scope: scope(child.id), expectedVersion: 2,
    requestId: 'scene-child-v2', document: scene('grass'), summary: 'changed replay', kind: 'voxel-edit' }))
    .rejects.toBeInstanceOf(SceneConflict)

  const restored = await restoreTimelineSceneFromAncestor(db, { scope: scope(child.id), expectedVersion: 2,
    requestId: 'scene-child-restore-root', ancestorScope: scope('home-main') })
  expect(restored).toMatchObject({ version: 3, kind: 'ancestor-restore', document: rootV1.document,
    parentRevisionId: rootV1.id })
  const restoreReplay = await restoreTimelineSceneFromAncestor(db, { scope: scope(child.id), expectedVersion: 999,
    requestId: 'scene-child-restore-root', ancestorScope: scope('home-main') })
  expect(restoreReplay).toMatchObject({ id: restored.id, version: 3 })
  expect(await readCurrentTimelineScene(db, scope('home-main'))).toMatchObject({ version: 2, document: rootV2.document })
  expect(await readCurrentTimelineScene(db, scope(sibling.id))).toMatchObject({ version: 1, document: rootV1.document })
})

it('refuses a timeline scene history whose immutable parent revision is missing', async () => {
  fixture = await createWorldFixture()
  const db = fixture.db
  await commitTimelineScene(db, { scope: scope('home-main'), expectedVersion: 0,
    requestId: 'scene-integrity-root', document: scene(), summary: 'root', kind: 'initial' })
  const foreignRoot = await commitTimelineScene(db, { scope: scope('other-main', 'other-world'), expectedVersion: 0,
    requestId: 'scene-integrity-foreign-root', document: scene('stone'), summary: 'foreign root', kind: 'initial' })
  const child = await forkTimeline(db, 'home-world', 'home-main', null, 'scene-integrity-fork')
  const head = await db.select().from(timelineSceneHeads).where(eq(timelineSceneHeads.timelineId, child.id)).get()
  expect(head).toBeDefined()
  // A valid FK to a different world's revision must still be rejected as an
  // out-of-scope lineage edge; tests the same refusal without disabling FK guards.
  await db.update(timelineSceneRevisions).set({ historyParentRevisionId: foreignRoot.id })
    .where(eq(timelineSceneRevisions.timelineId, child.id))
  await expect(listTimelineSceneHistory(db, scope(child.id))).rejects.toMatchObject({
    name: 'TimelineSceneIntegrityError', code: 'unreconstructable-history',
  })
  expect(await db.select().from(timelines).where(eq(timelines.id, child.id)).get()).toBeDefined()
})

it('refuses a current scene whose immutable snapshot is corrupt', async () => {
  fixture = await createWorldFixture()
  const { db } = fixture
  const revision = await commitTimelineScene(db, { scope: scope('home-main'), expectedVersion: 0,
    requestId: 'scene-integrity-json', document: scene(), summary: 'root', kind: 'initial' })
  await db.update(timelineSceneRevisions).set({ snapshotJson: '{broken-json' }).where(eq(timelineSceneRevisions.id, revision.id))
  await expect(readCurrentTimelineScene(db, scope('home-main'))).rejects.toBeInstanceOf(TimelineSceneIntegrityError)
  await expect(readCurrentTimelineScene(db, scope('home-main'))).rejects.toMatchObject({ code: 'invalid-json' })
})

it('rolls back the child timeline and forked scene rows when an atomic fork batch fails', async () => {
  fixture = await createWorldFixture()
  const { db, sqlite } = fixture
  await commitTimelineScene(db, { scope: scope('home-main'), expectedVersion: 0,
    requestId: 'scene-fork-rollback-root', document: scene(), summary: 'root', kind: 'initial' })
  sqlite.exec(`CREATE TRIGGER fail_timeline_scene_fork BEFORE INSERT ON timeline_scene_revisions
    WHEN NEW.timeline_id = 'scene-fork-rollback' BEGIN SELECT RAISE(ABORT, 'forced scene fork failure'); END`)
  await expect(forkTimeline(db, 'home-world', 'home-main', null, 'scene-fork-rollback')).rejects.toThrow('forced scene fork failure')
  expect(await db.select().from(timelines).where(eq(timelines.id, 'scene-fork-rollback'))).toHaveLength(0)
  expect(await db.select().from(timelineSceneHeads).where(eq(timelineSceneHeads.timelineId, 'scene-fork-rollback'))).toHaveLength(0)
  expect(await db.select().from(timelineSceneRevisions).where(eq(timelineSceneRevisions.timelineId, 'scene-fork-rollback'))).toHaveLength(0)
  expect(await readCurrentTimelineScene(db, scope('home-main'))).toMatchObject({ version: 1 })
})

it('keeps voxel geometry revisions separate from simulation time and life ledgers', async () => {
  fixture = await createWorldFixture()
  const db = fixture.db
  await db.insert(persons).values({ id: 'scene-resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: '2026-09-21T08:00:00.000Z' })
  await db.insert(worldPersons).values({ worldId: 'home-world', personId: 'scene-resident', joinedAt: '2026-09-21T08:00:00.000Z' })
  await db.insert(personStates).values({ personId: 'scene-resident', timelineId: 'home-main', simTime: '2026-09-21T08:00:00.000Z',
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Finish a book', currentDialogueId: null,
    lastBeatSimTime: '2026-09-21T08:00:00.000Z', updatedRealAt: '2026-09-21T08:00:00.000Z' })
  await commitTimelineScene(db, { scope: scope('home-main'), expectedVersion: 0,
    requestId: 'scene-ledger-v1', document: scene('grass'), summary: 'initial', kind: 'initial' })
  const before = {
    timeline: await db.select().from(timelines).where(eq(timelines.id, 'home-main')).get(),
    states: await db.select().from(personStates).where(eq(personStates.timelineId, 'home-main')),
    universe: await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')),
    commands: await db.select().from(worldCommands).where(eq(worldCommands.timelineId, 'home-main')),
    facts: await db.select().from(worldFacts).where(eq(worldFacts.timelineId, 'home-main')),
    events: await db.select().from(events).where(eq(events.timelineId, 'home-main')),
  }

  const edit = await commitTimelineScene(db, { scope: scope('home-main'), expectedVersion: 1,
    requestId: 'scene-ledger-v2', document: scene('stone'), summary: 'geometry edit', kind: 'voxel-edit' })

  expect(edit.version).toBe(2)
  expect(await db.select().from(timelines).where(eq(timelines.id, 'home-main')).get()).toEqual(before.timeline)
  expect(await db.select().from(personStates).where(eq(personStates.timelineId, 'home-main'))).toEqual(before.states)
  expect(await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main'))).toEqual(before.universe)
  expect(await db.select().from(worldCommands).where(eq(worldCommands.timelineId, 'home-main'))).toEqual(before.commands)
  expect(await db.select().from(worldFacts).where(eq(worldFacts.timelineId, 'home-main'))).toEqual(before.facts)
  expect(await db.select().from(events).where(eq(events.timelineId, 'home-main'))).toEqual(before.events)
})
