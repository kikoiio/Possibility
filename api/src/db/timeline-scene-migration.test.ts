import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createEmptyWorld, serialize } from '@possibility/voxel-contract'
import { createTestDb } from '../test/db'
import {
  timelineSceneHeads,
  timelineSceneRevisions,
  timelines,
  users,
  worldSceneRevisions,
  worldScenes,
  worlds,
} from './schema'

const MIGRATION_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle/0038_timeline_scene_versions.sql')
const MIGRATION = readFileSync(MIGRATION_PATH, 'utf8')
const legacySnapshot = JSON.stringify({
  format: 'voxel-spaces', version: 1,
  spaces: ['exterior', 'interior'].map((id, index) => ({
    id, name: id === 'exterior' ? 'Exterior' : 'Interior',
    document: JSON.parse(serialize(createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', `migration-${index}`))),
  })),
})

function migrationStatements() {
  return MIGRATION.split(/--> statement-breakpoint/).map(statement => statement.trim()).filter(Boolean)
}

function runMigration(sqlite: ReturnType<typeof createTestDb>['sqlite']) {
  for (const statement of migrationStatements()) sqlite.exec(statement)
}

async function seedLegacyScenes(db: ReturnType<typeof createTestDb>['db']) {
  const now = '2026-10-01T00:00:00.000Z'
  await db.insert(users).values({ id: 'migration-owner', username: 'migration-owner', passwordHash: 'x', createdAt: now })
  await db.insert(worlds).values([
    { id: 'migration-world', userId: 'migration-owner', name: 'Migration fixture', description: 'Legacy scene history' },
    { id: 'empty-world', userId: 'migration-owner', name: 'Empty fixture', description: 'No scene' },
  ])
  await db.insert(timelines).values([
    { id: 'migration-main', worldId: 'migration-world', parentTimelineId: null, simNow: now, createdAt: now },
    { id: 'migration-child', worldId: 'migration-world', parentTimelineId: 'migration-main', simNow: now, createdAt: now },
    { id: 'migration-sibling', worldId: 'migration-world', parentTimelineId: 'migration-main', simNow: now, createdAt: now },
    { id: 'empty-main', worldId: 'empty-world', parentTimelineId: null, simNow: now, createdAt: now },
  ])
  await db.insert(worldSceneRevisions).values([
    { id: 'legacy-scene-v1', worldId: 'migration-world', version: 1, parentVersion: null,
      requestId: 'legacy-v1', contentHash: 'legacy-hash-v1', documentJson: '{"snapshot":"old"}',
      summary: 'Old version', kind: 'initial', createdAt: now },
    { id: 'legacy-scene-v2', worldId: 'migration-world', version: 2, parentVersion: 1,
      requestId: 'legacy-v2', contentHash: 'legacy-hash-v2', documentJson: legacySnapshot,
      summary: 'Current version', kind: 'voxel-edit', createdAt: '2026-10-02T00:00:00.000Z' },
  ])
  await db.insert(worldScenes).values({ worldId: 'migration-world', currentVersion: 2, themeId: 'mist-manor', updatedAt: now })
}

describe('0038 timeline scene migration', () => {
  it('creates independent roots from each timeline current snapshot and leaves legacy history intact on rerun', async () => {
    const fixture = createTestDb()
    try {
      await seedLegacyScenes(fixture.db)
      const legacyBefore = await fixture.db.select().from(worldSceneRevisions)
        .where(eq(worldSceneRevisions.worldId, 'migration-world')).orderBy(worldSceneRevisions.version)

      runMigration(fixture.sqlite)

      const roots = await fixture.db.select().from(timelineSceneRevisions)
        .where(eq(timelineSceneRevisions.worldId, 'migration-world')).orderBy(timelineSceneRevisions.timelineId)
      expect(roots).toHaveLength(3)
      expect(roots.map(row => [row.timelineId, row.version, row.historyParentRevisionId, row.snapshotJson, row.kind]))
        .toEqual([
          ['migration-child', 1, null, legacySnapshot, 'legacy-migration'],
          ['migration-main', 1, null, legacySnapshot, 'legacy-migration'],
          ['migration-sibling', 1, null, legacySnapshot, 'legacy-migration'],
        ])
      expect(roots.every(row => row.contentHash === 'legacy-hash-v2')).toBe(true)
      expect(await fixture.db.select().from(timelineSceneHeads)
        .where(eq(timelineSceneHeads.worldId, 'migration-world'))).toHaveLength(3)
      expect(await fixture.db.select().from(timelineSceneHeads)
        .where(eq(timelineSceneHeads.timelineId, 'empty-main'))).toHaveLength(0)
      expect(await fixture.db.select().from(worldSceneRevisions)
        .where(eq(worldSceneRevisions.worldId, 'migration-world')).orderBy(worldSceneRevisions.version)).toEqual(legacyBefore)

      runMigration(fixture.sqlite)
      expect(await fixture.db.select().from(timelineSceneRevisions)
        .where(eq(timelineSceneRevisions.worldId, 'migration-world')).orderBy(timelineSceneRevisions.timelineId)).toEqual(roots)
      expect(await fixture.db.select().from(timelineSceneHeads)
        .where(eq(timelineSceneHeads.worldId, 'migration-world'))).toHaveLength(3)
    } finally {
      fixture.close()
    }
  })

  it('resumes after revision roots were inserted but the head insert had not run', async () => {
    const fixture = createTestDb()
    try {
      await seedLegacyScenes(fixture.db)
      const statements = migrationStatements()
      for (const statement of statements) {
        if (/^INSERT INTO `timeline_scene_heads`/i.test(statement)) break
        fixture.sqlite.exec(statement)
      }

      const revisionRows = await fixture.db.select().from(timelineSceneRevisions)
        .where(eq(timelineSceneRevisions.worldId, 'migration-world'))
      expect(revisionRows).toHaveLength(3)
      expect(await fixture.db.select().from(timelineSceneHeads)
        .where(eq(timelineSceneHeads.worldId, 'migration-world'))).toHaveLength(0)

      runMigration(fixture.sqlite)

      expect(await fixture.db.select().from(timelineSceneRevisions)
        .where(eq(timelineSceneRevisions.worldId, 'migration-world'))).toEqual(revisionRows)
      const heads = await fixture.db.select().from(timelineSceneHeads)
        .where(eq(timelineSceneHeads.worldId, 'migration-world'))
      expect(heads).toHaveLength(3)
      for (const head of heads) {
        expect(await fixture.db.select().from(timelineSceneRevisions).where(and(
          eq(timelineSceneRevisions.id, head.currentRevisionId),
          eq(timelineSceneRevisions.timelineId, head.timelineId),
        )).get()).toMatchObject({ version: 1, snapshotJson: legacySnapshot })
      }
    } finally {
      fixture.close()
    }
  })
})
