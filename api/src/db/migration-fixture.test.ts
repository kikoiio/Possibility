import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDb } from '../db/client'
import { readCurrentScene } from '../scenes/repository'
import { loadWorldSceneBindings } from '../scenes/compatibility/context'
import {
  confirmCompatibility,
  createCompatibilityDraft,
  inspectSceneCompatibility,
  validateStoredSceneCandidate,
} from '../scenes/compatibility/service'
import {
  buildLegacyFixtureSql,
  buildTestPolicyActivationSql,
} from '../../scripts/prepare-scene-compatibility-fixture'

/**
 * A1(B65)：真实旧数据库 e2e fixture——先应用 0000–0036 旧迁移，导入原始旧资料，
 * 再应用 0037 及之后的完整迁移并显式安装测试发布策略；旧数据来自迁移前导入，
 * 启用闸门后只有真实 A1 流程能保存。
 */

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle')
const LEGACY_MIGRATION_CEILING = 36

function migrationFiles(): string[] {
  return readdirSync(drizzleDir).filter(name => name.endsWith('.sql')).sort()
}

function applyMigrations(sqlite: DatabaseSync, include: (index: number) => boolean): string[] {
  const applied: string[] = []
  for (const file of migrationFiles()) {
    const index = Number.parseInt(file.slice(0, 4), 10)
    if (!include(index)) continue
    const sql = readFileSync(join(drizzleDir, file), 'utf8')
    for (const statement of sql.split(/--> statement-breakpoint/).map(s => s.trim()).filter(Boolean)) {
      sqlite.exec(statement)
    }
    applied.push(file)
  }
  return applied
}

/** 与 test/db.ts 相同的 D1 接口包装，但迁移节奏由本测试控制。 */
function wrapD1(sqlite: DatabaseSync): D1Database {
  class Statement {
    constructor(readonly query: string, readonly params: unknown[] = []) {}
    bind(...params: unknown[]) { return new Statement(this.query, params) }
    execute() {
      const stmt = sqlite.prepare(this.query)
      const results = stmt.all(...this.params as never[])
      return { success: true, results, meta: { changes: Number(sqlite.prepare('SELECT changes() AS n').get()!.n) } }
    }
    async all() { return this.execute() }
    async run() { return this.execute() }
    async raw() {
      const stmt = sqlite.prepare(this.query)
      stmt.setReturnArrays(true)
      return stmt.all(...this.params as never[])
    }
    async first(column?: string) {
      const row = this.execute().results[0] ?? null
      return column && row ? row[column] : row
    }
  }
  return {
    prepare: (query: string) => new Statement(query),
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map(statement => statement.execute())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
    async exec(query: string) { sqlite.exec(query); return { count: 0, duration: 0 } },
  } as unknown as D1Database
}

function rows(sqlite: DatabaseSync, table: string, orderBy: string): unknown[] {
  return sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all()
}

describe('A1 e2e legacy fixture', () => {
  it('旧迁移装载原始旧资料后，完整迁移保留生活/基线数据，闸门下只有真实 A1 流程能保存', async () => {
    const sqlite = new DatabaseSync(':memory:')
    try {
      sqlite.exec('PRAGMA foreign_keys = ON')
      // 1. 旧迁移 0000–0036：闸门表与证明列尚不存在
      const legacyApplied = applyMigrations(sqlite, index => index <= LEGACY_MIGRATION_CEILING)
      expect(legacyApplied.at(-1)?.startsWith('0036')).toBe(true)
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scene_validation_policy'").all()).toHaveLength(0)

      // 2. 迁移前导入原始旧资料（与隔离启动脚本同一份 SQL）
      sqlite.exec(await buildLegacyFixtureSql())

      // 迁移前快照：生活保留、基线对照与原始旧场景文档
      const snapshot = {
        users: rows(sqlite, 'users', 'id'),
        persons: rows(sqlite, 'persons', 'id'),
        worlds: rows(sqlite, 'worlds', 'id'),
        worldPersons: rows(sqlite, 'world_persons', 'world_id, person_id'),
        timelines: rows(sqlite, 'timelines', 'id'),
        personStates: rows(sqlite, 'person_states', 'person_id'),
        memories: rows(sqlite, 'memories', 'id'),
        revisions: rows(sqlite, 'world_scene_revisions', 'world_id, version'),
        scenes: rows(sqlite, 'world_scenes', 'world_id'),
        baselines: rows(sqlite, 'demo_baselines', 'id'),
      }
      expect(snapshot.worldPersons).toHaveLength(3) // 多归属：ada 属于两个世界
      expect(snapshot.revisions).toHaveLength(4) // 旧单空间 + 有效对照 + 演示基线 + 旧双空间
      expect(snapshot.baselines).toHaveLength(1)

      // 3. 完整新迁移 + 显式安装测试发布策略（不关触发器、不改旧行）
      const upgraded = applyMigrations(sqlite, index => index > LEGACY_MIGRATION_CEILING)
      expect(upgraded.some(name => name.startsWith('0037'))).toBe(true)
      sqlite.exec(await buildTestPolicyActivationSql())

      // 生活保留与基线对照：迁移前后逐行一致
      expect(rows(sqlite, 'users', 'id')).toEqual(snapshot.users)
      expect(rows(sqlite, 'persons', 'id')).toEqual(snapshot.persons)
      expect(rows(sqlite, 'worlds', 'id')).toEqual(snapshot.worlds)
      expect(rows(sqlite, 'world_persons', 'world_id, person_id')).toEqual(snapshot.worldPersons)
      expect(rows(sqlite, 'timelines', 'id')).toEqual(snapshot.timelines)
      expect(rows(sqlite, 'person_states', 'person_id')).toEqual(snapshot.personStates)
      expect(rows(sqlite, 'memories', 'id')).toEqual(snapshot.memories)
      expect(rows(sqlite, 'world_scenes', 'world_id')).toEqual(snapshot.scenes)
      expect(rows(sqlite, 'demo_baselines', 'id')).toEqual(snapshot.baselines)
      // 旧修订原文保留：文档逐字不变，新证明列为空（旧资料无证明），commit_guard 默认开启
      const migratedRevisions = rows(sqlite, 'world_scene_revisions', 'world_id, version') as Array<Record<string, unknown>>
      expect(migratedRevisions.map(({ compatibility_json, validation_json, commit_guard, ...rest }) => rest))
        .toEqual(snapshot.revisions)
      for (const row of migratedRevisions) {
        expect(row.compatibility_json).toBeNull()
        expect(row.validation_json).toBeNull()
        expect(row.commit_guard).toBe(1)
      }
      // 测试策略已激活且指纹来自真实资产清单
      const policy = sqlite.prepare("SELECT * FROM scene_validation_policy WHERE id='active'").get() as { rules_version: string; asset_manifest_hash: string }
      expect(policy.rules_version).toBe('voxel-scene-validation-v1')
      expect(policy.asset_manifest_hash).toMatch(/^[0-9a-f]{64}$/)

      const db = createDb(wrapD1(sqlite))

      // 4. 闸门：原始旧场景经完整检查为 invalid，普通保存路径（完整候选预检）阻断
      const legacyAccess = { bindings: await loadWorldSceneBindings(db, 'a1-legacy-world') }
      const inspection = await inspectSceneCompatibility(db, { worldId: 'a1-legacy-world', access: legacyAccess })
      expect(inspection.status).toBe('ready')
      if (inspection.status !== 'ready') return
      expect(inspection.report.status).toBe('invalid')
      const legacyStored = await readCurrentScene(db, 'a1-legacy-world')
      const ordinarySave = await validateStoredSceneCandidate(db, {
        worldId: 'a1-legacy-world', document: legacyStored!.document, access: legacyAccess,
      })
      expect(ordinarySave.status).toBe('invalid')

      // 对照：有效旧场景在闸门下仍然 valid
      const secondAccess = { bindings: await loadWorldSceneBindings(db, 'a1-second-world') }
      const secondStored = await readCurrentScene(db, 'a1-second-world')
      const control = await validateStoredSceneCandidate(db, {
        worldId: 'a1-second-world', document: secondStored!.document, access: secondAccess,
      })
      expect(control.status).toBe('valid')

      // 5. 只有真实 A1 流程能保存：修复草稿 → 确认提交，产生带证明的新修订
      const actor = { actorKey: 'user:a1-legacy-owner', userId: 'a1-legacy-owner' }
      const draft = await createCompatibilityDraft(db, {
        ...actor, worldId: 'a1-legacy-world', draftRequestId: 'a1-draft-1', purpose: 'repair-current',
        target: { kind: 'current' }, expectedCurrentVersion: 1, access: legacyAccess,
      })
      expect(draft.status).toBe('ready')
      expect(draft.candidate).not.toBeNull()
      const confirmed = await confirmCompatibility(db, {
        ...actor, worldId: 'a1-legacy-world', draftId: draft.id, requestId: 'a1-confirm-1',
        expectedCurrentVersion: 1, expectedAttempt: 0, access: legacyAccess,
      })
      expect(confirmed.status).toBe('completed')
      if (confirmed.status !== 'completed') return
      expect(confirmed.result.version).toBe(2)
      const repaired = sqlite.prepare(
        "SELECT validation_json, compatibility_json, kind FROM world_scene_revisions WHERE world_id='a1-legacy-world' AND version=2",
      ).get() as { validation_json: string | null; compatibility_json: string | null; kind: string }
      expect(repaired.validation_json).not.toBeNull()
      expect(repaired.compatibility_json).not.toBeNull()
      expect(repaired.kind).toBe('compatibility-repair')
      // 原始旧场景修订（version 1）原文仍然保留
      const original = sqlite.prepare(
        "SELECT document_json FROM world_scene_revisions WHERE world_id='a1-legacy-world' AND version=1",
      ).get() as { document_json: string }
      expect(original.document_json).toBe((snapshot.revisions as Array<Record<string, unknown>>)
        .find(row => row.world_id === 'a1-legacy-world')!.document_json)
    } finally {
      sqlite.close()
    }
  })
})
