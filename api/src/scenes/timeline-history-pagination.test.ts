import { afterEach, expect, it } from 'vitest'
import { applyEdits, createEmptyWorld, serialize, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import { eq } from 'drizzle-orm'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { timelineSceneRevisions, timelines } from '../db/schema'
import { commitTimelineScene, listTimelineSceneHistory, TimelineSceneIntegrityError } from './repository'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

function scene(block: 'grass' | 'stone' = 'grass'): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'bounded-history')
  const doc = applyEdits(base, [{ kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block }]).document
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

const scope = (timelineId: string) => ({ worldId: 'home-world', timelineId, representation: 'voxel' })

async function seedForkedHistory() {
  fixture = await createWorldFixture()
  const { db } = fixture
  const rootV1 = await commitTimelineScene(db, { scope: scope('home-main'), expectedVersion: 0,
    requestId: 'bounded-root-v1', document: scene('grass'), summary: 'root 1', kind: 'initial' })
  await db.update(timelineSceneRevisions).set({ createdAt: '2026-09-01T00:00:00.000Z' }).where(eq(timelineSceneRevisions.id, rootV1.id))
  const rootV2 = await commitTimelineScene(db, { scope: scope('home-main'), expectedVersion: 1,
    requestId: 'bounded-root-v2', document: scene('stone'), summary: 'root 2', kind: 'voxel-edit' })
  await db.update(timelineSceneRevisions).set({ createdAt: '2026-09-02T00:00:00.000Z' }).where(eq(timelineSceneRevisions.id, rootV2.id))
  await db.insert(timelines).values({ id: 'bounded-child', worldId: 'home-world', parentTimelineId: 'home-main',
    simNow: WORLD_TIME, createdAt: '2026-09-03T00:00:00.000Z', status: 'active' })
  const childV1 = await commitTimelineScene(db, { scope: scope('bounded-child'), expectedVersion: 0,
    requestId: 'bounded-child-v1', document: rootV2.document, summary: 'fork point', kind: 'fork-restore' })
  const rootV3 = await commitTimelineScene(db, { scope: scope('home-main'), expectedVersion: 2,
    requestId: 'bounded-root-v3', document: scene('grass'), summary: 'root after fork', kind: 'voxel-edit' })
  await db.update(timelineSceneRevisions).set({ createdAt: '2026-09-04T00:00:00.000Z' }).where(eq(timelineSceneRevisions.id, rootV3.id))
  const childV2 = await commitTimelineScene(db, { scope: scope('bounded-child'), expectedVersion: 1,
    requestId: 'bounded-child-v2', document: scene('grass'), summary: 'child edit', kind: 'voxel-edit' })
  return { db, rootV1, rootV2, rootV3, childV1, childV2 }
}

it('decodes at most limit+1 snapshots, pages along the parent chain, and preserves page boundary provenance', async () => {
  const { db, rootV1, rootV2, rootV3, childV1, childV2 } = await seedForkedHistory()
  const logStart = fixture!.queryLog.length

  const first = await listTimelineSceneHistory(db, scope('bounded-child'), { limit: 2 })
  expect(first?.revisions.map(revision => revision.id)).toEqual([childV2.id, childV1.id])
  expect(first).toMatchObject({ hasMore: true, nextCursor: childV1.id, boundaries: [] })
  const snapshotReads = fixture!.queryLog.slice(logStart).filter(entry =>
    entry.query.toLowerCase().includes('timeline_scene_revisions')
      && entry.query.toLowerCase().includes('snapshot_json'))
  expect(snapshotReads).toHaveLength(3)

  const second = await listTimelineSceneHistory(db, scope('bounded-child'), { limit: 2, cursor: first!.nextCursor })
  expect(second?.revisions.map(revision => revision.id)).toEqual([rootV2.id, rootV1.id])
  expect(second?.boundaries).toEqual([{ fromTimelineId: 'bounded-child', toTimelineId: 'home-main', revisionId: rootV2.id }])
  expect(second?.revisions.some(revision => revision.id === rootV3.id)).toBe(false)
})

it('rejects unknown or pre-cutoff cursors and accepts only selected-line cutoffs', async () => {
  const { db, rootV1, rootV2, childV1, childV2 } = await seedForkedHistory()

  await expect(listTimelineSceneHistory(db, scope('bounded-child'), { cursor: 'not-visible' }))
    .rejects.toMatchObject({ name: 'TimelineSceneIntegrityError', code: 'invalid-cursor' })
  await expect(listTimelineSceneHistory(db, scope('bounded-child'), { cursor: childV2.id, cutoffVersion: 1 }))
    .rejects.toMatchObject({ name: 'TimelineSceneIntegrityError', code: 'invalid-cursor' })
  await expect(listTimelineSceneHistory(db, scope('bounded-child'), { cutoffRevisionId: rootV1.id }))
    .rejects.toMatchObject({ name: 'TimelineSceneIntegrityError', code: 'invalid-cursor' })
  await expect(listTimelineSceneHistory(db, scope('bounded-child'), { cutoffVersion: 0 }))
    .rejects.toMatchObject({ name: 'TimelineSceneIntegrityError', code: 'invalid-cursor' })

  const cutoff = await listTimelineSceneHistory(db, scope('bounded-child'), { cutoffRevisionId: childV1.id, limit: 1 })
  expect(cutoff?.revisions.map(revision => revision.id)).toEqual([childV1.id])
  expect(cutoff?.hasMore).toBe(true)
  // A selected-line version cutoff cannot silently bind to a same-numbered ancestor.
  expect(cutoff?.revisions[0]?.id).not.toBe(rootV2.id)
})

it('rejects corruption as soon as the requested page reaches it without scanning it on earlier pages', async () => {
  const { db, rootV1, childV1, childV2 } = await seedForkedHistory()
  await db.update(timelineSceneRevisions).set({ snapshotJson: '{bad-json' }).where(eq(timelineSceneRevisions.id, rootV1.id))
  const first = await listTimelineSceneHistory(db, scope('bounded-child'), { limit: 2 })
  expect(first?.revisions.map(revision => revision.id)).toEqual([childV2.id, childV1.id])
  await expect(listTimelineSceneHistory(db, scope('bounded-child'), { limit: 2, cursor: childV1.id }))
    .rejects.toBeInstanceOf(TimelineSceneIntegrityError)
})
