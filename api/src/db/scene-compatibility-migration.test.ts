import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { describe, expect, it } from 'vitest'
import { createDb } from './client'
import {
  demoBaselines,
  dialogues,
  memories,
  persons,
  personStates,
  sceneCompatibilityDrafts,
  sceneCompatibilityRequests,
  sceneValidationPolicy,
  sessions,
  timelines,
  users,
  worldPersons,
  worldSceneRevisions,
  worldScenes,
  worlds,
} from './schema'
import { createTestDb } from '../test/db'
import { commitScene, cloneSceneStatements, initialSceneStatements } from '../scenes/repository'
import { loadWorldSceneBindings } from '../scenes/compatibility/context'
import {
  buildCommitGuardStatement,
  buildCommitWriteProof,
  buildCloneCopyWriteProof,
  buildInitialWriteProof,
  buildValidWriteProof,
  computeFallbackSceneWritePolicy,
  loadSceneWriteProofFacts,
  resolveSceneWritePolicy,
  SCENE_WRITE_PROOF_SCHEMA,
  type SceneWriteAuthority,
  type SceneWriteProof,
  type SceneWriteProofRequest,
} from '../scenes/compatibility/write-proof'
import {
  activateScenePolicy,
  ScenePolicyActivationRefusal,
} from '../../../scripts/activate-scene-policy'
import {
  cancelCompatibilityDraft,
  confirmCompatibility,
  createCompatibilityDraft,
} from '../scenes/compatibility/service'
import { claimSceneCompatibilityRequest } from '../scenes/compatibility/repository'
import { compatibilityFixtureRepairedBasis } from '../scenes/e2e-fixture'
import { buildTestPolicyActivationSql } from '../../scripts/prepare-scene-compatibility-fixture'

/**
 * A1 场景兼容：存储闸门验证（B10–B19）。
 * 真实 SQLite + 真实迁移；触发器主动 ABORT、D1 batch 语义由 test/db 包装提供。
 * 发布策略仅由受控激活 SQL 安装——与隔离环境同一条路径，Worker 请求永不写入。
 */

type TestDb = ReturnType<typeof createTestDb>
type Db = TestDb['db']

const NOW = '2026-10-05T00:00:00.000Z'
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle')

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

function triggerNames(sqlite: DatabaseSync): string[] {
  return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'world_scene_revision%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
}

async function activatePolicy(sqlite: DatabaseSync): Promise<void> {
  sqlite.exec(await buildTestPolicyActivationSql())
}

async function seedUser(db: Db, id: string, role = 'user'): Promise<void> {
  await db.insert(users).values({ id, username: id, passwordHash: 'x', role, createdAt: NOW })
}

async function seedWorld(db: Db, worldId: string, userId: string, locationsJson = '[]'): Promise<void> {
  await db.insert(worlds).values({
    id: worldId, userId, name: worldId, description: 'd', locationsJson,
    status: 'running', isDemo: false, callsToday: 0, createdAt: NOW,
  })
}

async function seedWorldWithScene(db: Db, worldId: string, userId: string, locationsJson = '[]'): Promise<void> {
  await seedWorld(db, worldId, userId, locationsJson)
  await db.batch(await initialSceneStatements(db, worldId, compatibilityFixtureRepairedBasis(), `${worldId}-init`))
}

interface RawRevisionInsert {
  worldId: string
  version: number
  parentVersion?: number | null
  requestId: string
  contentHash?: string
  documentJson?: string
  proof?: unknown
}

/** 旧 writer 形态的真实 INSERT：默认 commit_guard=1，不携带证明（除非显式给出）。 */
function rawInsertRevision(sqlite: DatabaseSync, input: RawRevisionInsert) {
  return sqlite.prepare(
    `INSERT INTO world_scene_revisions (id, world_id, version, parent_version, request_id, content_hash, document_json, summary, kind, validation_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', 'raw', 'voxel-edit', ?, ?)`,
  ).run(
    crypto.randomUUID(), input.worldId, input.version, input.parentVersion ?? null, input.requestId,
    input.contentHash ?? `raw-hash-${input.version}`,
    input.proof === undefined || input.proof === null ? null : JSON.stringify(input.proof), NOW,
  )
}

function currentRevisionRow(sqlite: DatabaseSync, worldId: string): { version: number; content_hash: string } {
  return sqlite.prepare(
    `SELECT r.version, r.content_hash FROM world_scenes ws
     JOIN world_scene_revisions r ON r.world_id = ws.world_id AND r.version = ws.current_version
     WHERE ws.world_id = ?`,
  ).get(worldId) as { version: number; content_hash: string }
}

function revisionAt(sqlite: DatabaseSync, worldId: string, version: number): Record<string, unknown> | undefined {
  return sqlite.prepare('SELECT * FROM world_scene_revisions WHERE world_id = ? AND version = ?').get(worldId, version) as Record<string, unknown> | undefined
}

/** 与 repository.hashStoredDocument 同一口径：对（解析后的文档 + 修订版本）整体哈希。 */
async function hashStoredDocumentJson(documentJson: string, version: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ document: JSON.parse(documentJson), version })))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function revisionInsert(db: Db, input: { id: string; worldId: string; version: number; parentVersion: number | null; requestId: string; contentHash: string; proof: SceneWriteProof }) {
  return db.insert(worldSceneRevisions).values({
    id: input.id, worldId: input.worldId, version: input.version, parentVersion: input.parentVersion,
    requestId: input.requestId, contentHash: input.contentHash,
    documentJson: JSON.stringify(compatibilityFixtureRepairedBasis()), summary: 't',
    kind: 'voxel-edit', validationJson: JSON.stringify(input.proof), commitGuard: true, createdAt: NOW,
  })
}

function pointerUpdate(db: Db, worldId: string, fromVersion: number, toVersion: number) {
  return db.update(worldScenes).set({ currentVersion: toVersion, themeId: 'mist-manor', updatedAt: NOW })
    .where(and(eq(worldScenes.worldId, worldId), eq(worldScenes.currentVersion, fromVersion)))
}

/** 与 commitScene 相同的批内组装：真实插入 + 指针推进 + 后置 guard 断言。 */
async function commitViaGate(db: Db, sqlite: DatabaseSync, input: { worldId: string; requestId: string; authority?: SceneWriteAuthority; compatibility?: SceneWriteProofRequest }) {
  const current = currentRevisionRow(sqlite, input.worldId)
  const version = current.version + 1
  const id = crypto.randomUUID()
  const proof = await buildCommitWriteProof(db, {
    worldId: input.worldId, candidate: { version, contentHash: `h-${id}` },
    ...(input.compatibility ? { compatibility: input.compatibility } : {}),
  })
  await db.batch([
    revisionInsert(db, { id, worldId: input.worldId, version, parentVersion: current.version, requestId: input.requestId, contentHash: `h-${id}`, proof }),
    pointerUpdate(db, input.worldId, current.version, version),
    buildCommitGuardStatement(db, {
      revisionId: id, worldId: input.worldId, version, requestId: input.requestId,
      baseline: proof.baseline, ...(input.authority ? { authority: input.authority } : {}),
    }),
  ])
  return { version, id, proof }
}

describe('A1 draft schema', () => {
  it('草稿身份约束与状态字段与契约一致', async () => {
    const { db, close } = createTestDb()
    try {
      await seedUser(db, 'u1')
      await seedWorld(db, 'w1', 'u1')
      await db.insert(sceneCompatibilityDrafts).values({
        id: 'd1', draftRequestId: 'dr1', actorKey: 'user:u1', worldId: 'w1', purpose: 'repair-current',
        targetJson: '{"kind":"current"}', basisJson: '{}', inputFingerprint: 'fp1', createdAt: NOW, updatedAt: NOW,
      })
      const row = await db.select().from(sceneCompatibilityDrafts).where(eq(sceneCompatibilityDrafts.id, 'd1')).get()
      expect(row?.status).toBe('building')
      expect(row?.buildAttempt).toBe(0)
      expect(row?.changesJson).toBe('[]')
      expect(row?.buildLeaseToken).toBeNull()
      expect(row?.buildLeaseUntil).toBeNull()
      // 身份唯一约束：(worldId, actorKey, draftRequestId)
      await expect(db.insert(sceneCompatibilityDrafts).values({
        id: 'd2', draftRequestId: 'dr1', actorKey: 'user:u1', worldId: 'w1', purpose: 'repair-current',
        targetJson: '{"kind":"current"}', basisJson: '{}', inputFingerprint: 'fp2', createdAt: NOW, updatedAt: NOW,
      })).rejects.toThrow()
      // 不同 draftRequestId 可以共存
      await db.insert(sceneCompatibilityDrafts).values({
        id: 'd3', draftRequestId: 'dr2', actorKey: 'user:u1', worldId: 'w1', purpose: 'repair-current',
        targetJson: '{"kind":"current"}', basisJson: '{}', inputFingerprint: 'fp3', createdAt: NOW, updatedAt: NOW,
      })
    } finally { close() }
  })
})

describe('A1 request schema', () => {
  it('提交 journal 固定 world/request 唯一，attempt/token/lease 与结果字段齐备', async () => {
    const { db, close } = createTestDb()
    try {
      await seedUser(db, 'u1')
      await seedWorld(db, 'w1', 'u1')
      await seedWorld(db, 'w2', 'u1')
      await db.insert(sceneCompatibilityDrafts).values({
        id: 'd1', draftRequestId: 'dr1', actorKey: 'user:u1', worldId: 'w1', purpose: 'repair-current',
        targetJson: '{"kind":"current"}', basisJson: '{}', inputFingerprint: 'fp1', createdAt: NOW, updatedAt: NOW,
      })
      await db.insert(sceneCompatibilityRequests).values({
        worldId: 'w1', requestId: 'r1', actorKey: 'user:u1', draftId: 'd1', requestFingerprint: 'rfp-a', createdAt: NOW, updatedAt: NOW,
      })
      const row = await db.select().from(sceneCompatibilityRequests).where(eq(sceneCompatibilityRequests.worldId, 'w1')).get()
      expect(row?.state).toBe('submitting')
      expect(row?.attempt).toBe(0)
      expect(row?.leaseToken).toBeNull()
      expect(row?.leaseUntil).toBeNull()
      expect(row?.resultVersion).toBeNull()
      expect(row?.failureCode).toBeNull()
      // 同一 world/request 不能被另一用途（不同指纹）重复占用
      await expect(db.insert(sceneCompatibilityRequests).values({
        worldId: 'w1', requestId: 'r1', actorKey: 'user:u1', draftId: 'd1', requestFingerprint: 'rfp-b', createdAt: NOW, updatedAt: NOW,
      })).rejects.toThrow()
      // 不同世界允许同一 requestId 命名空间
      await db.insert(sceneCompatibilityRequests).values({
        worldId: 'w2', requestId: 'r1', actorKey: 'user:u1', draftId: 'd1', requestFingerprint: 'rfp-c', createdAt: NOW, updatedAt: NOW,
      })
    } finally { close() }
  })
})

describe('A1 policy schema', () => {
  it('旧历史允许空证明，commit_guard 限定为 1，policy 单行 active', async () => {
    const { db, sqlite, close } = createTestDb()
    try {
      await seedUser(db, 'u1')
      await seedWorld(db, 'w1', 'u1')
      await db.insert(worldScenes).values({ worldId: 'w1', currentVersion: 1, themeId: 'mist-manor', updatedAt: NOW })
      // 旧 writer 列清单（无新列）：未激活发布规则时仍允许空证明，新列默认空且不重写内容
      sqlite.prepare(
        `INSERT INTO world_scene_revisions (id, world_id, version, parent_version, request_id, content_hash, document_json, summary, kind, created_at)
         VALUES ('rev-1', 'w1', 1, NULL, 'req-1', 'hash-1', '{"format":"legacy"}', '旧修订', 'initial', ?)`,
      ).run(NOW)
      const legacy = revisionAt(sqlite, 'w1', 1)!
      expect(legacy.compatibility_json).toBeNull()
      expect(legacy.validation_json).toBeNull()
      expect(legacy.commit_guard).toBe(1)
      expect(legacy.document_json).toBe('{"format":"legacy"}')
      // commit_guard 只能为 1：插入或改写为 0 均主动 ABORT
      expect(() => sqlite.prepare(
        `INSERT INTO world_scene_revisions (id, world_id, version, request_id, content_hash, document_json, summary, kind, commit_guard, created_at)
         VALUES ('rev-bad', 'w1', 2, 'req-bad', 'hash-2', '{}', 'x', 'k', 0, ?)`,
      ).run(NOW)).toThrow(/scene_revision_commit_guard_failed/)
      expect(() => sqlite.prepare('UPDATE world_scene_revisions SET commit_guard = 0 WHERE id = ?').run('rev-1')).toThrow(/scene_revision_commit_guard_failed/)
      expect((revisionAt(sqlite, 'w1', 1)!).commit_guard).toBe(1)
      // 单行 active 发布策略
      await db.insert(sceneValidationPolicy).values({ id: 'active', rulesVersion: 'v1', assetManifestHash: 'a', templateCatalogHash: 't', publishedAt: NOW })
      await expect(db.insert(sceneValidationPolicy).values({ id: 'active', rulesVersion: 'v2', assetManifestHash: 'b', templateCatalogHash: 'u', publishedAt: NOW })).rejects.toThrow()
    } finally { close() }
  })
})

describe('A1 legacy migration', () => {
  it('旧迁移→导入旧数据→应用新迁移：旧字节保留、触发器不被关闭，默认测试走完整迁移', async () => {
    const sqlite = new DatabaseSync(':memory:')
    try {
      sqlite.exec('PRAGMA foreign_keys = ON')
      const legacyApplied = applyMigrations(sqlite, index => index <= 36)
      expect(legacyApplied.at(-1)?.startsWith('0036')).toBe(true)
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scene_validation_policy'").all()).toHaveLength(0)
      // 旧资料：旧列清单写入（0037 之前没有证明列）
      sqlite.exec(`
        INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'u1', 'x', 'user', '${NOW}');
        INSERT INTO worlds (id, user_id, name, description, locations_json, status, is_demo, calls_today, created_at)
          VALUES ('w1', 'u1', '旧世界', 'd', '[]', 'running', 0, 0, '${NOW}');
        INSERT INTO world_scenes (world_id, current_version, theme_id, updated_at) VALUES ('w1', 1, 'mist-manor', '${NOW}');
        INSERT INTO world_scene_revisions (id, world_id, version, parent_version, request_id, content_hash, document_json, summary, kind, created_at)
          VALUES ('rev-1', 'w1', 1, NULL, 'req-1', 'hash-1', '{"format":"legacy","cells":[1,2,3]}', '旧修订', 'initial', '${NOW}');
      `)
      const before = revisionAt(sqlite, 'w1', 1)!
      const upgraded = applyMigrations(sqlite, index => index > 36)
      expect(upgraded.some(name => name.startsWith('0037'))).toBe(true)
      // 旧文档/修订字节保留：除新增列外逐列一致，新证明列为空，guard 默认 1
      const after = revisionAt(sqlite, 'w1', 1)!
      const { compatibility_json, validation_json, commit_guard, ...rest } = after
      expect(rest).toEqual(before)
      expect(compatibility_json).toBeNull()
      expect(validation_json).toBeNull()
      expect(commit_guard).toBe(1)
      // 旧数据导入不关闭触发器：六个修订闸门全部就位且真实生效
      expect(triggerNames(sqlite)).toEqual([
        'world_scene_revision_authority_gate',
        'world_scene_revision_commit_guard_insert',
        'world_scene_revision_commit_guard_update',
        'world_scene_revision_compatibility_gate',
        'world_scene_revision_policy_gate',
        'world_scene_revision_source_gate',
      ])
      await activatePolicy(sqlite)
      expect(() => rawInsertRevision(sqlite, { worldId: 'w1', version: 2, parentVersion: 1, requestId: 'req-2' })).toThrow(/scene_revision_proof_required/)
      // 普通测试默认仍应用全部迁移
      const fresh = createTestDb()
      try {
        expect(fresh.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scene_validation_policy'").all()).toHaveLength(1)
        expect(triggerNames(fresh.sqlite)).toContain('world_scene_revision_policy_gate')
      } finally { fresh.close() }
    } finally { sqlite.close() }
  })
})

describe('A1 schema', () => {
  it('0037 为最大迁移编号，DDL 与 schema 一致，唯一约束生效', async () => {
    expect(migrationFiles().at(-1)).toBe('0037_scene_compatibility.sql')
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> }
    expect(journal.entries.at(-1)?.tag).toBe('0037_scene_compatibility')
    expect(existsSync(join(drizzleDir, 'meta/0037_snapshot.json'))).toBe(true)

    const { db, sqlite, close } = createTestDb()
    try {
      // 新表与新列就位
      const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
      for (const table of ['scene_compatibility_drafts', 'scene_compatibility_requests', 'scene_validation_policy']) expect(tables).toContain(table)
      const revisionColumns = (sqlite.prepare("PRAGMA table_info('world_scene_revisions')").all() as Array<{ name: string }>).map(row => row.name)
      for (const column of ['compatibility_json', 'validation_json', 'commit_guard']) expect(revisionColumns).toContain(column)
      // 约束索引就位
      const indexes = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
      for (const index of ['scene_compatibility_draft_scope', 'world_scene_revision_version', 'world_scene_revision_request']) expect(indexes).toContain(index)
      // 唯一约束生效：修订 (world, version) 与 (world, request)
      await seedUser(db, 'u1')
      await seedWorld(db, 'w1', 'u1')
      await db.insert(worldScenes).values({ worldId: 'w1', currentVersion: 1, themeId: 'mist-manor', updatedAt: NOW })
      sqlite.prepare(
        `INSERT INTO world_scene_revisions (id, world_id, version, request_id, content_hash, document_json, summary, kind, created_at)
         VALUES ('rev-1', 'w1', 1, 'req-1', 'h1', '{}', 's', 'k', ?)`,
      ).run(NOW)
      expect(() => sqlite.prepare(
        `INSERT INTO world_scene_revisions (id, world_id, version, request_id, content_hash, document_json, summary, kind, created_at)
         VALUES ('rev-2', 'w1', 1, 'req-2', 'h2', '{}', 's', 'k', ?)`,
      ).run(NOW)).toThrow()
      expect(() => sqlite.prepare(
        `INSERT INTO world_scene_revisions (id, world_id, version, request_id, content_hash, document_json, summary, kind, created_at)
         VALUES ('rev-3', 'w1', 2, 'req-1', 'h3', '{}', 's', 'k', ?)`,
      ).run(NOW)).toThrow()
    } finally { close() }
  })
})

describe('A1 insert policy gate', () => {
  it('发布后无证明、空规则、旧规则均主动拒绝；服务端依据可写入', async () => {
    const { db, sqlite, close } = createTestDb()
    try {
      await seedUser(db, 'u1')
      await seedWorldWithScene(db, 'w1', 'u1')
      // 激活前：旧 writer（无证明）仍可写入——闸门由发布激活
      rawInsertRevision(sqlite, { worldId: 'w1', version: 2, parentVersion: 1, requestId: 'pre-activation' })
      sqlite.prepare('UPDATE world_scenes SET current_version = 2 WHERE world_id = ?').run('w1')
      await activatePolicy(sqlite)
      const policy = sqlite.prepare("SELECT * FROM scene_validation_policy WHERE id = 'active'").get() as { rules_version: string; asset_manifest_hash: string; template_catalog_hash: string }
      expect(await resolveSceneWritePolicy(db)).toEqual({
        rulesVersion: policy.rules_version,
        assetManifestHash: policy.asset_manifest_hash,
        templateCatalogHash: policy.template_catalog_hash,
      })
      // 无证明：旧 writer 即便默认 guard=1 也不能插入新修订
      expect(() => rawInsertRevision(sqlite, { worldId: 'w1', version: 3, parentVersion: 2, requestId: 'no-proof' })).toThrow(/scene_revision_proof_required/)
      const realProof = await buildCommitWriteProof(db, { worldId: 'w1', candidate: { version: 3, contentHash: 'h3' } })
      // 空规则
      const emptyRules = { ...realProof, policy: { rulesVersion: '', assetManifestHash: '', templateCatalogHash: '' } }
      expect(() => rawInsertRevision(sqlite, { worldId: 'w1', version: 3, parentVersion: 2, requestId: 'empty-rules', proof: emptyRules })).toThrow(/scene_revision_policy_mismatch/)
      // 旧规则
      const staleRules = { ...realProof, policy: { ...realProof.policy, rulesVersion: 'legacy-v0' } }
      expect(() => rawInsertRevision(sqlite, { worldId: 'w1', version: 3, parentVersion: 2, requestId: 'stale-rules', proof: staleRules })).toThrow(/scene_revision_policy_mismatch/)
      // 未知写入模式
      const unknownMode = { ...realProof, mode: 'http-provided' }
      expect(() => rawInsertRevision(sqlite, { worldId: 'w1', version: 3, parentVersion: 2, requestId: 'unknown-mode', proof: unknownMode })).toThrow(/scene_revision_proof_mode_unknown/)
      // 正例：服务端构造依据的提交成功并随修订持久化
      const committed = await commitScene(db, {
        worldId: 'w1', expectedVersion: 2, requestId: 'edit-1',
        document: compatibilityFixtureRepairedBasis(), summary: '编辑', kind: 'voxel-edit',
      })
      expect(committed.version).toBe(3)
      const stored = revisionAt(sqlite, 'w1', 3)!
      expect(stored.validation_json).not.toBeNull()
      const proof = JSON.parse(stored.validation_json as string) as SceneWriteProof
      expect(proof.schema).toBe(SCENE_WRITE_PROOF_SCHEMA)
      expect(proof.mode).toBe('valid')
      expect(proof.policy.rulesVersion).toBe(policy.rules_version)
      expect(proof.policy.assetManifestHash).toBe(policy.asset_manifest_hash)
      expect(proof.policy.templateCatalogHash).toBe(policy.template_catalog_hash)
    } finally { close() }
  })
})

describe('A1 write proof', () => {
  it('依据由服务端构造：含发布指纹与基底资料，无私有鉴权字段；clone-copy 不冒充完整有效', async () => {
    const { db, sqlite, close } = createTestDb()
    try {
      await seedUser(db, 'u1')
      await seedUser(db, 'u2')
      await seedWorldWithScene(db, 'w-src', 'u1', '[{"name":"石灯庭院","description":"d"}]')
      await db.insert(persons).values({ id: 'p1', userId: 'u1', name: '阿澜', modelJson: '{}', createdAt: NOW })
      await db.insert(worldPersons).values({ worldId: 'w-src', personId: 'p1', joinedAt: NOW })
      await seedWorld(db, 'w-clone', 'u2')
      await activatePolicy(sqlite)

      const proof = await buildCommitWriteProof(db, { worldId: 'w-src', candidate: { version: 2, contentHash: 'h2' } })
      // 依据结构：写入模式、发布指纹、来源/当前/候选、绑定、基线；无 HTTP 或私有鉴权字段
      expect(Object.keys(proof).sort()).toEqual(['baseline', 'bindings', 'candidate', 'current', 'issuedAt', 'mode', 'policy', 'request', 'schema', 'source'])
      expect(proof.mode).toBe('valid')
      if (proof.mode !== 'valid') return
      expect(proof.source).toEqual({ worldId: 'w-src', version: 1, contentHash: currentRevisionRow(sqlite, 'w-src').content_hash })
      expect(proof.current).toEqual({ expectedVersion: 1, contentHash: currentRevisionRow(sqlite, 'w-src').content_hash })
      expect(proof.candidate).toEqual({ version: 2, contentHash: 'h2' })
      expect(proof.bindings.personIds).toEqual(['p1'])
      expect(proof.bindings.locations).toEqual(['石灯庭院'])
      expect(proof.bindings.bindingHash).toMatch(/^[0-9a-f]{64}$/)
      expect(proof.baseline).toBeNull()
      expect(proof.request).toBeNull()
      const serialized = JSON.stringify(proof)
      for (const forbidden of ['password', 'sessionToken', 'apiKey', 'secret', 'authorization']) {
        expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase())
      }
      // 模式由服务端事实决定：无当前场景不能构造 valid，已有当前场景不能构造 initial
      const cloneFacts = await loadSceneWriteProofFacts(db, 'w-clone')
      expect(cloneFacts.current).toBeNull()
      expect(() => buildValidWriteProof(cloneFacts, { worldId: 'w-clone', candidate: { version: 1, contentHash: 'h' } })).toThrow(/valid/)
      const srcFacts = await loadSceneWriteProofFacts(db, 'w-src')
      expect(() => buildInitialWriteProof(srcFacts, { candidate: { version: 1, contentHash: 'h' } })).toThrow(/initial/)

      // clone-copy：保存来源引用与目标归属，经由可信克隆路径写入无当前指针的新世界
      const source = currentRevisionRow(sqlite, 'w-src')
      const cloneProof = buildCloneCopyWriteProof(cloneFacts, {
        source: { worldId: 'w-src', version: source.version, contentHash: source.content_hash },
        targetOwnerId: 'u2',
        candidate: { version: 1, contentHash: 'clone-hash' },
      })
      expect(cloneProof.mode).toBe('clone-copy')
      rawInsertRevision(sqlite, { worldId: 'w-clone', version: 1, requestId: 'clone-1', contentHash: 'clone-hash', proof: cloneProof })
      expect(revisionAt(sqlite, 'w-clone', 1)).toBeDefined()
      // 同一资料改用 valid 模式即被拒绝：clone-copy 不能冒充完整有效校验
      const impersonation = { ...cloneProof, mode: 'valid' }
      await seedWorld(db, 'w-fake', 'u2')
      expect(() => rawInsertRevision(sqlite, { worldId: 'w-fake', version: 1, requestId: 'fake-1', contentHash: 'clone-hash', proof: impersonation })).toThrow(/scene_revision_current_mismatch/)
      // 伪造来源修订或目标归属同样主动拒绝
      await seedWorld(db, 'w-clone-2', 'u2')
      const badSource = buildCloneCopyWriteProof(await loadSceneWriteProofFacts(db, 'w-clone-2'), {
        source: { worldId: 'w-src', version: 1, contentHash: 'forged' }, targetOwnerId: 'u2', candidate: { version: 1, contentHash: 'x' },
      })
      expect(() => rawInsertRevision(sqlite, { worldId: 'w-clone-2', version: 1, requestId: 'clone-2', proof: badSource })).toThrow(/scene_revision_clone_source_missing/)
      await seedWorld(db, 'w-clone-3', 'u1')
      const badOwner = buildCloneCopyWriteProof(await loadSceneWriteProofFacts(db, 'w-clone-3'), {
        source: { worldId: 'w-src', version: 1, contentHash: source.content_hash }, targetOwnerId: 'u2', candidate: { version: 1, contentHash: 'x' },
      })
      expect(() => rawInsertRevision(sqlite, { worldId: 'w-clone-3', version: 1, requestId: 'clone-3', proof: badOwner })).toThrow(/scene_revision_clone_target_mismatch/)
    } finally { close() }
  })
})

describe('A1 insert source gate', () => {
  it('过期当前/来源被拒绝，首版不误用覆盖路径，零行不被视为成功', async () => {
    const { db, sqlite, close } = createTestDb()
    try {
      await seedUser(db, 'u1')
      await seedWorldWithScene(db, 'w1', 'u1')
      await activatePolicy(sqlite)

      // 过期当前：依据构造后场景被推进，旧依据在真实插入时拒绝
      const staleProof = await buildCommitWriteProof(db, { worldId: 'w1', candidate: { version: 2, contentHash: 'h2' } })
      await commitScene(db, { worldId: 'w1', expectedVersion: 1, requestId: 'edit-1', document: compatibilityFixtureRepairedBasis(), summary: 's', kind: 'voxel-edit' })
      expect(() => rawInsertRevision(sqlite, { worldId: 'w1', version: 3, parentVersion: 2, requestId: 'stale-current', proof: staleProof })).toThrow(/scene_revision_current_mismatch/)
      // 过期来源：来源修订哈希不符
      const realProof = await buildCommitWriteProof(db, { worldId: 'w1', candidate: { version: 3, contentHash: 'h3' } })
      const staleSource = { ...realProof, source: { worldId: 'w1', version: 2, contentHash: 'bogus' } }
      expect(() => rawInsertRevision(sqlite, { worldId: 'w1', version: 3, parentVersion: 2, requestId: 'stale-source', proof: staleSource })).toThrow(/scene_revision_source_mismatch/)
      // 跨世界来源：valid 模式不接受其他世界的来源修订
      const crossSource = { ...realProof, source: { worldId: 'w-other', version: 2, contentHash: 'x' } }
      expect(() => rawInsertRevision(sqlite, { worldId: 'w1', version: 3, parentVersion: 2, requestId: 'cross-source', proof: crossSource })).toThrow(/scene_revision_source_mismatch/)

      // 首版：initial 模式要求不存在当前场景；重复首版主动拒绝
      await seedWorld(db, 'w2', 'u1')
      await db.batch(await initialSceneStatements(db, 'w2', compatibilityFixtureRepairedBasis(), 'w2-init'))
      expect(currentRevisionRow(sqlite, 'w2').version).toBe(1)
      const initialStored = JSON.parse(revisionAt(sqlite, 'w2', 1)!.validation_json as string) as SceneWriteProof
      expect(initialStored.mode).toBe('initial')
      await expect(initialSceneStatements(db, 'w2', compatibilityFixtureRepairedBasis(), 'w2-init-2')).rejects.toThrow(/initial/)
      const craftedInitial = { ...initialStored, candidate: { version: 1, contentHash: 'again' } }
      expect(() => rawInsertRevision(sqlite, { worldId: 'w2', version: 1, requestId: 'initial-again', proof: craftedInitial })).toThrow(/scene_revision_initial_conflict|world_scene_revision_version/)
      // 首版不误用覆盖路径：无当前场景的世界使用 valid 模式被拒绝
      await seedWorld(db, 'w3', 'u1')
      const noCurrentFacts = await loadSceneWriteProofFacts(db, 'w3')
      const overrideProof = {
        schema: SCENE_WRITE_PROOF_SCHEMA, mode: 'valid', policy: noCurrentFacts.policy, issuedAt: NOW,
        current: { expectedVersion: 0, contentHash: '' }, candidate: { version: 1, contentHash: 'h1' },
        bindings: noCurrentFacts.bindings, baseline: null, request: null,
        source: { worldId: 'w3', version: 0, contentHash: '' },
      }
      expect(() => rawInsertRevision(sqlite, { worldId: 'w3', version: 1, requestId: 'override-first', proof: overrideProof })).toThrow(/scene_revision_current_mismatch/)

      // INSERT SELECT 反例：条件不满足时静默写入零行且不显式失败——闸门绝不采用该模式
      const zeroRows = sqlite.prepare(
        `INSERT INTO world_scene_revisions (id, world_id, version, request_id, content_hash, document_json, summary, kind, created_at)
         SELECT 'rev-zero', 'w1', 9, 'req-zero', 'h9', '{}', 's', 'k', '${NOW}'
         WHERE EXISTS (SELECT 1 FROM world_scenes WHERE world_id = 'w1' AND current_version = 999)`,
      ).run()
      expect(Number(zeroRows.changes)).toBe(0)
      expect(revisionAt(sqlite, 'w1', 9)).toBeUndefined()
      // 指针条件 UPDATE 影响零行同样不显式失败
      const zeroUpdate = await db.update(worldScenes).set({ currentVersion: 9, updatedAt: NOW })
        .where(and(eq(worldScenes.worldId, 'w1'), eq(worldScenes.currentVersion, 999)))
      expect(zeroUpdate.meta.changes).toBe(0)

      // 后置 guard：批内指针推进落空时 guard 置 0 触发回滚，修订不残留
      const guardedProof = await buildCommitWriteProof(db, { worldId: 'w1', candidate: { version: 3, contentHash: 'h3' } })
      const guardId = crypto.randomUUID()
      await expect(db.batch([
        revisionInsert(db, { id: guardId, worldId: 'w1', version: 3, parentVersion: 2, requestId: 'guard-rollback', contentHash: 'h3', proof: guardedProof }),
        // 预期版本错误 → 零行推进，不抛错；guard 必须捕获
        pointerUpdate(db, 'w1', 999, 3),
        buildCommitGuardStatement(db, { revisionId: guardId, worldId: 'w1', version: 3, requestId: 'guard-rollback', baseline: guardedProof.baseline }),
      ])).rejects.toThrow(/scene_revision_commit_guard_failed/)
      expect(revisionAt(sqlite, 'w1', 3)).toBeUndefined()
      expect(currentRevisionRow(sqlite, 'w1').version).toBe(2)
      // 正常组装：guard 保持 1，整批生效
      const ok = await commitViaGate(db, sqlite, { worldId: 'w1', requestId: 'guard-ok' })
      expect(ok.version).toBe(3)
      expect(revisionAt(sqlite, 'w1', 3)!.commit_guard).toBe(1)
    } finally { close() }
  })
})

describe('A1 insert authority gate', () => {
  it('绑定/登录/归属变化在写入时拒绝，无关对话生活更新不导致拒绝', async () => {
    const { db, sqlite, close } = createTestDb()
    try {
      await seedUser(db, 'u1')
      await seedUser(db, 'u2')
      await seedWorldWithScene(db, 'w1', 'u1', '[{"name":"石灯庭院","description":"d"}]')
      await db.insert(persons).values({ id: 'p1', userId: 'u1', name: '阿澜', modelJson: '{}', createdAt: NOW })
      await db.insert(worldPersons).values({ worldId: 'w1', personId: 'p1', joinedAt: NOW })
      await activatePolicy(sqlite)

      // 绑定集合变化：写入时按成员/数量复核，过期依据主动拒绝
      const staleBinding = await buildCommitWriteProof(db, { worldId: 'w1', candidate: { version: 2, contentHash: 'h2' } })
      await db.insert(persons).values({ id: 'p2', userId: 'u2', name: '阿柏', modelJson: '{}', createdAt: NOW })
      await db.insert(worldPersons).values({ worldId: 'w1', personId: 'p2', joinedAt: NOW })
      expect(() => rawInsertRevision(sqlite, { worldId: 'w1', version: 2, parentVersion: 1, requestId: 'stale-binding', proof: staleBinding })).toThrow(/scene_revision_binding_mismatch/)
      await db.delete(worldPersons).where(and(eq(worldPersons.worldId, 'w1'), eq(worldPersons.personId, 'p2')))
      // 地点名称变化同样使旧依据失效
      const staleLocations = await buildCommitWriteProof(db, { worldId: 'w1', candidate: { version: 2, contentHash: 'h2' } })
      await db.update(worlds).set({ locationsJson: '[{"name":"石灯庭院","description":"d"},{"name":"河埠头","description":"d2"}]' }).where(eq(worlds.id, 'w1'))
      expect(() => rawInsertRevision(sqlite, { worldId: 'w1', version: 2, parentVersion: 1, requestId: 'stale-locations', proof: staleLocations })).toThrow(/scene_revision_binding_mismatch/)
      await db.update(worlds).set({ locationsJson: '[{"name":"石灯庭院","description":"d"}]' }).where(eq(worlds.id, 'w1'))

      // 鉴权 SQL 条件：有效会话 + 归属一致时写入成功
      await db.insert(sessions).values({ token: 's1', userId: 'u1', expiresAt: '2027-01-01T00:00:00.000Z' })
      const ok = await commitViaGate(db, sqlite, { worldId: 'w1', requestId: 'auth-ok', authority: { sessionToken: 's1', sessionNow: NOW, ownerUserId: 'u1' } })
      expect(ok.version).toBe(2)
      // 会话失效：删除会话后同一请求身份在写入时拒绝并回滚
      await db.delete(sessions).where(eq(sessions.token, 's1'))
      await expect(commitViaGate(db, sqlite, { worldId: 'w1', requestId: 'auth-session-lost', authority: { sessionToken: 's1', sessionNow: NOW, ownerUserId: 'u1' } }))
        .rejects.toThrow(/scene_revision_commit_guard_failed/)
      expect(currentRevisionRow(sqlite, 'w1').version).toBe(2)
      // 过期会话同样拒绝
      await db.insert(sessions).values({ token: 's2', userId: 'u1', expiresAt: '2026-01-01T00:00:00.000Z' })
      await expect(commitViaGate(db, sqlite, { worldId: 'w1', requestId: 'auth-session-expired', authority: { sessionToken: 's2', sessionNow: NOW, ownerUserId: 'u1' } }))
        .rejects.toThrow(/scene_revision_commit_guard_failed/)
      // 世界归属变化：owner 复核不符时拒绝
      await expect(commitViaGate(db, sqlite, { worldId: 'w1', requestId: 'auth-owner-changed', authority: { ownerUserId: 'u2' } }))
        .rejects.toThrow(/scene_revision_commit_guard_failed/)
      expect(currentRevisionRow(sqlite, 'w1').version).toBe(2)
      // 管理员权限复核：角色被撤销后拒绝
      await seedUser(db, 'admin-1', 'admin')
      const adminOk = await commitViaGate(db, sqlite, { worldId: 'w1', requestId: 'auth-admin-ok', authority: { adminUserId: 'admin-1' } })
      expect(adminOk.version).toBe(3)
      await db.update(users).set({ role: 'user' }).where(eq(users.id, 'admin-1'))
      await expect(commitViaGate(db, sqlite, { worldId: 'w1', requestId: 'auth-admin-revoked', authority: { adminUserId: 'admin-1' } }))
        .rejects.toThrow(/scene_revision_commit_guard_failed/)
      expect(currentRevisionRow(sqlite, 'w1').version).toBe(3)

      // 无关生活更新（对话/行程/记忆）不参与写入条件，不导致拒绝
      await db.insert(timelines).values({ id: 'tl1', worldId: 'w1', simNow: NOW, createdAt: NOW })
      await db.insert(dialogues).values({ id: 'dlg1', timelineId: 'tl1', location: '石灯庭院', participantIdsJson: '["p1"]', simStart: NOW })
      await db.insert(personStates).values({ personId: 'p1', timelineId: 'tl1', simTime: NOW, location: '石灯庭院', activity: '散步', mood: '平静', goal: '照看庭院', updatedRealAt: NOW })
      await db.insert(memories).values({ id: 'm1', personId: 'p1', timelineId: 'tl1', type: 'event', content: '无关记忆', createdAt: NOW })
      const unaffected = await commitViaGate(db, sqlite, { worldId: 'w1', requestId: 'auth-unaffected', authority: { ownerUserId: 'u1' } })
      expect(unaffected.version).toBe(4)
    } finally { close() }
  })
})

describe('A1 insert compatibility gate', () => {
  it('替换/新增/退休基线、取消草稿、旧 token/attempt、过期租约均主动拒绝', async () => {
    const { db, sqlite, close } = createTestDb()
    try {
      await seedUser(db, 'u1')
      await activatePolicy(sqlite)

      // ── 基线引用：新增/替换/退休均使旧依据失效
      await seedWorldWithScene(db, 'w-base', 'u1')
      const noBaseline = await buildCommitWriteProof(db, { worldId: 'w-base', candidate: { version: 2, contentHash: 'h2' } })
      await db.insert(demoBaselines).values({ id: 'base-1', worldId: 'w-base', sceneVersion: 1, contentHash: 'bh-1', status: 'active', createdAt: NOW })
      expect(() => rawInsertRevision(sqlite, { worldId: 'w-base', version: 2, parentVersion: 1, requestId: 'baseline-added', proof: noBaseline })).toThrow(/scene_revision_baseline_mismatch/)
      // 基线未变时写入成功（管理员路径携带同一基线引用）
      const withBaseline = await commitViaGate(db, sqlite, { worldId: 'w-base', requestId: 'baseline-ok' })
      expect(withBaseline.proof.baseline).toEqual({ id: 'base-1', status: 'active', sceneVersion: 1, contentHash: 'bh-1' })
      // 退休基线使旧依据失效
      const beforeRetire = await buildCommitWriteProof(db, { worldId: 'w-base', candidate: { version: 3, contentHash: 'h3' } })
      await db.update(demoBaselines).set({ status: 'retired', retiredAt: NOW }).where(eq(demoBaselines.id, 'base-1'))
      expect(() => rawInsertRevision(sqlite, { worldId: 'w-base', version: 3, parentVersion: 2, requestId: 'baseline-retired', proof: beforeRetire })).toThrow(/scene_revision_baseline_mismatch/)
      // 替换基线（id 变化）同样拒绝
      await db.delete(demoBaselines).where(eq(demoBaselines.id, 'base-1'))
      await db.insert(demoBaselines).values({ id: 'base-2', worldId: 'w-base', sceneVersion: 2, contentHash: 'bh-2', status: 'active', createdAt: NOW })
      expect(() => rawInsertRevision(sqlite, { worldId: 'w-base', version: 3, parentVersion: 2, requestId: 'baseline-replaced', proof: beforeRetire })).toThrow(/scene_revision_baseline_mismatch/)

      // ── 兼容草稿与请求：ready 草稿 + attempt/token/未过期租约
      await seedWorldWithScene(db, 'w1', 'u1')
      const access = { bindings: await loadWorldSceneBindings(db, 'w1') }
      const actor = { actorKey: 'user:u1', userId: 'u1' }
      // 正例：真实草稿→确认提交，依据携带请求执行身份
      const draft = await createCompatibilityDraft(db, {
        ...actor, worldId: 'w1', draftRequestId: 'dr-1', purpose: 'restore-history',
        target: { kind: 'history', version: 1 }, expectedCurrentVersion: 1, access,
      })
      expect(draft.status).toBe('ready')
      const confirmed = await confirmCompatibility(db, {
        ...actor, worldId: 'w1', draftId: draft.id, requestId: 'cf-1', expectedCurrentVersion: 1, expectedAttempt: 0, access,
      })
      expect(confirmed.status).toBe('completed')
      const committedProof = JSON.parse(revisionAt(sqlite, 'w1', 2)!.validation_json as string) as SceneWriteProof
      expect(committedProof.mode).toBe('valid')
      expect(committedProof.request?.draftId).toBe(draft.id)
      expect(committedProof.request?.requestId).toBe('cf-1')
      expect(committedProof.request?.attempt).toBe(0)
      // 取消草稿：不再 ready 的草稿不能支撑新修订
      const cancelled = await createCompatibilityDraft(db, {
        ...actor, worldId: 'w1', draftRequestId: 'dr-2', purpose: 'restore-history',
        target: { kind: 'history', version: 2 }, expectedCurrentVersion: 2, access,
      })
      expect(cancelled.status).toBe('ready')
      await cancelCompatibilityDraft(db, { ...actor, worldId: 'w1', draftId: cancelled.id })
      const cancelledProof = await buildCommitWriteProof(db, {
        worldId: 'w1', candidate: { version: 3, contentHash: 'h3' },
        compatibility: { draftId: cancelled.id, requestId: 'cf-cancelled', attempt: 0, leaseToken: 'x', leaseUntil: '2027-01-01T00:00:00.000Z' },
      })
      expect(() => rawInsertRevision(sqlite, { worldId: 'w1', version: 3, parentVersion: 2, requestId: 'cf-cancelled', proof: cancelledProof })).toThrow(/scene_revision_draft_not_ready/)
      // 旧 attempt / 旧 token：与请求行不符即拒绝
      const draft2 = await createCompatibilityDraft(db, {
        ...actor, worldId: 'w1', draftRequestId: 'dr-3', purpose: 'restore-history',
        target: { kind: 'history', version: 2 }, expectedCurrentVersion: 2, access,
      })
      const claim = await claimSceneCompatibilityRequest(db, {
        worldId: 'w1', draftId: draft2.id, requestId: 'cf-2', expectedCurrentVersion: 2, expectedAttempt: 0, actorKey: actor.actorKey,
      })
      expect(claim.claimed).toBe(true)
      const wrongAttempt = await buildCommitWriteProof(db, {
        worldId: 'w1', candidate: { version: 3, contentHash: 'h3' },
        compatibility: { draftId: draft2.id, requestId: 'cf-2', attempt: 1, leaseToken: claim.leaseToken!, leaseUntil: claim.request.leaseUntil! },
      })
      expect(() => rawInsertRevision(sqlite, { worldId: 'w1', version: 3, parentVersion: 2, requestId: 'cf-2', proof: wrongAttempt })).toThrow(/scene_revision_request_mismatch/)
      const wrongToken = await buildCommitWriteProof(db, {
        worldId: 'w1', candidate: { version: 3, contentHash: 'h3' },
        compatibility: { draftId: draft2.id, requestId: 'cf-2', attempt: 0, leaseToken: 'stale-token', leaseUntil: claim.request.leaseUntil! },
      })
      expect(() => rawInsertRevision(sqlite, { worldId: 'w1', version: 3, parentVersion: 2, requestId: 'cf-2', proof: wrongToken })).toThrow(/scene_revision_request_mismatch/)
      // 正确 attempt/token/租约的真实组装可以写入
      const requestOk = await commitViaGate(db, sqlite, {
        worldId: 'w1', requestId: 'cf-2',
        compatibility: { draftId: draft2.id, requestId: 'cf-2', attempt: 0, leaseToken: claim.leaseToken!, leaseUntil: claim.request.leaseUntil! },
      })
      expect(requestOk.version).toBe(3)
      // 过期租约：lease_until 不晚于依据构造时间的执行权被拒绝
      const draft3 = await createCompatibilityDraft(db, {
        ...actor, worldId: 'w1', draftRequestId: 'dr-4', purpose: 'restore-history',
        target: { kind: 'history', version: 3 }, expectedCurrentVersion: 3, access,
      })
      const expiredClaim = await claimSceneCompatibilityRequest(db, {
        worldId: 'w1', draftId: draft3.id, requestId: 'cf-3', expectedCurrentVersion: 3, expectedAttempt: 0,
        actorKey: actor.actorKey, now: new Date(Date.now() - 60_000),
      })
      expect(expiredClaim.claimed).toBe(true)
      const expiredProof = await buildCommitWriteProof(db, {
        worldId: 'w1', candidate: { version: 4, contentHash: 'h4' },
        compatibility: { draftId: draft3.id, requestId: 'cf-3', attempt: 0, leaseToken: expiredClaim.leaseToken!, leaseUntil: expiredClaim.request.leaseUntil! },
      })
      expect(() => rawInsertRevision(sqlite, { worldId: 'w1', version: 4, parentVersion: 3, requestId: 'cf-3', proof: expiredProof })).toThrow(/scene_revision_request_mismatch/)
    } finally { close() }
  })
})

describe('A1 baseline commit batch', () => {
  it('基线重指向与新修订同批：零行基线更新回滚整批', async () => {
    const { db, sqlite, close } = createTestDb()
    try {
      await seedUser(db, 'u1')
      await seedWorldWithScene(db, 'w1', 'u1')
      await db.insert(demoBaselines).values({ id: 'base-1', worldId: 'w1', sceneVersion: 1, contentHash: 'bh-1', status: 'active', createdAt: NOW })
      // 正例：修订、当前指针、基线引用同批推进，guard 断言新基线引用保持 1
      const committed = await commitScene(db, {
        worldId: 'w1', expectedVersion: 1, requestId: 'regen-1',
        document: compatibilityFixtureRepairedBasis(), summary: '再生成', kind: 'voxel-regenerate',
        allowBaseline: true, baselineUpdate: { baselineId: 'base-1' },
      })
      expect(committed.version).toBe(2)
      expect(revisionAt(sqlite, 'w1', 2)!.commit_guard).toBe(1)
      const baseline = await db.select().from(demoBaselines).where(eq(demoBaselines.id, 'base-1')).get()
      expect(baseline).toMatchObject({ sceneVersion: 2, contentHash: committed.contentHash })
      // 假故障：基线 id 不存在 → 批内更新零行不显式失败 → guard 置 0 触发回滚，修订/指针/基线均不变
      await expect(commitScene(db, {
        worldId: 'w1', expectedVersion: 2, requestId: 'regen-2',
        document: compatibilityFixtureRepairedBasis(), summary: '再生成', kind: 'voxel-regenerate',
        allowBaseline: true, baselineUpdate: { baselineId: 'missing-baseline' },
      })).rejects.toThrow(/scene_revision_commit_guard_failed/)
      expect(revisionAt(sqlite, 'w1', 3)).toBeUndefined()
      expect(currentRevisionRow(sqlite, 'w1').version).toBe(2)
      const after = await db.select().from(demoBaselines).where(eq(demoBaselines.id, 'base-1')).get()
      expect(after).toMatchObject({ sceneVersion: 2, contentHash: committed.contentHash })
    } finally { close() }
  })
})

describe('A1 clone gate', () => {
  it('克隆工厂：批内 clone-copy 证明指向源/目标、哈希按新文档重算、绑定不符整批回滚', async () => {
    const { db, sqlite, close } = createTestDb()
    try {
      await seedUser(db, 'u-src')
      await seedUser(db, 'u-dst')
      await seedWorld(db, 'w-src', 'u-src', '[{"name":"书房"}]')
      await db.insert(persons).values({ id: 'p-src', userId: 'u-src', name: '阿澜', modelJson: '{}', createdAt: NOW })
      await db.insert(worldPersons).values({ worldId: 'w-src', personId: 'p-src', joinedAt: NOW })
      // 源场景携带人物绑定引用：克隆重映射会改变文档字节，哈希必须按新文档重算
      const sourceDocument = compatibilityFixtureRepairedBasis()
      sourceDocument.objects[0]!.binding = { kind: 'person', personId: 'p-src' }
      await db.batch(await initialSceneStatements(db, 'w-src', sourceDocument, 'w-src-init'))
      await commitScene(db, {
        worldId: 'w-src', expectedVersion: 1, requestId: 'w-src-edit',
        document: sourceDocument, summary: '编辑', kind: 'voxel-edit',
      })
      await activatePolicy(sqlite)

      const sourcePointer = (await db.select().from(worldScenes).where(eq(worldScenes.worldId, 'w-src')).get())!
      const sourceRevisions = await db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, 'w-src')).all()
      expect(sourceRevisions).toHaveLength(2)

      const cloneBatch = async (targetWorldId: string, personId: string, pendingPersonIds: string[]) => [
        db.insert(worlds).values({
          id: targetWorldId, userId: 'u-dst', name: targetWorldId, description: 'd',
          locationsJson: '[{"name":"书房"}]', status: 'running' as const, isDemo: false, callsToday: 0, createdAt: NOW,
        }),
        db.insert(persons).values({ id: personId, userId: 'u-dst', name: '阿澜副本', modelJson: '{}', createdAt: NOW }),
        db.insert(worldPersons).values({ worldId: targetWorldId, personId, joinedAt: NOW }),
        ...await cloneSceneStatements(db, {
          sourceWorldId: 'w-src', targetWorldId, targetOwnerId: 'u-dst',
          pendingBindings: { personIds: pendingPersonIds, locations: [{ name: '书房' }] },
          pointer: sourcePointer, revisions: sourceRevisions,
          revisionIdFor: async row => `clone-rev-${targetWorldId}-${row.version}`,
          requestIdFor: async row => `clone-req-${targetWorldId}-${row.version}`,
          remapDocument: json => json.replaceAll('p-src', personId),
        }),
      ]

      // 正例：策略激活下克隆批成功，目标指针与全部历史修订同批落库
      await db.batch(await cloneBatch('w-dst', 'p-dst', ['p-dst']) as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
      expect(currentRevisionRow(sqlite, 'w-dst').version).toBe(2)
      const cloned = await db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, 'w-dst')).all()
      expect(cloned).toHaveLength(2)
      const sourceByVersion = new Map(sourceRevisions.map(row => [row.version, row]))
      for (const row of cloned) {
        const proof = JSON.parse(row.validationJson!) as SceneWriteProof
        // 生成明确 provenance：clone-copy 指向源世界修订，归属目标 owner，不复用源行的 initial/valid 依据
        expect(proof.mode).toBe('clone-copy')
        if (proof.mode !== 'clone-copy') continue
        expect(proof.source).toEqual({ worldId: 'w-src', version: row.version, contentHash: sourceByVersion.get(row.version)!.contentHash })
        expect(proof.targetOwnerId).toBe('u-dst')
        expect(proof.candidate).toEqual({ version: row.version, contentHash: row.contentHash })
        // 身份重映射生效且哈希对应新文档（与源行哈希不同）
        expect(row.documentJson).toContain('p-dst')
        expect(row.documentJson).not.toContain('p-src')
        expect(row.contentHash).toBe(await hashStoredDocumentJson(row.documentJson, row.version))
        expect(row.contentHash).not.toBe(sourceByVersion.get(row.version)!.contentHash)
        expect(row.commitGuard).toBe(true)
      }

      // 反例：待创建绑定快照少于真实成员 → 插入闸门 ABORT，世界/成员/场景整批回滚
      await expect(db.batch(await cloneBatch('w-dst-bad', 'p-dst-2', []) as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])).rejects.toThrow(/scene_revision_binding_mismatch/)
      expect(await db.select().from(worlds).where(eq(worlds.id, 'w-dst-bad')).get()).toBeUndefined()
      expect(await db.select().from(persons).where(eq(persons.id, 'p-dst-2')).get()).toBeUndefined()
      expect(await db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, 'w-dst-bad')).all()).toEqual([])
      expect(await db.select().from(worldScenes).where(eq(worldScenes.worldId, 'w-dst-bad')).get()).toBeUndefined()
    } finally { close() }
  })
})

describe('A1 explicit policy activation', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

  it('指纹不符拒绝激活且不留行；激活脚本为纯 INSERT（无 OR REPLACE 覆盖语义）', async () => {
    const { sqlite, close } = createTestDb()
    try {
      await expect(activateScenePolicy(sqlite, { expected: { assetManifestHash: 'bogus-hash' } }))
        .rejects.toThrow(ScenePolicyActivationRefusal)
      await expect(activateScenePolicy(sqlite, { expected: { assetManifestHash: 'bogus-hash' } }))
        .rejects.toThrow(/指纹与发布票据不符/)
      expect((sqlite.prepare('SELECT COUNT(*) AS n FROM scene_validation_policy').get() as { n: number }).n).toBe(0)
      // 静态保证：激活语句是纯 INSERT，拒绝 INSERT OR REPLACE 的降级/覆盖语义（B33）
      const scriptSource = readFileSync(join(repoRoot, 'scripts/activate-scene-policy.ts'), 'utf8')
      expect(scriptSource).not.toMatch(/INSERT\s+OR\s+REPLACE\s+INTO/i)
      expect(scriptSource).toMatch(/INSERT INTO scene_validation_policy/)
    } finally { close() }
  })

  it('指纹相符激活成功并留核实凭据；已有 active 行拒绝重复激活与降级', async () => {
    const { db, sqlite, close } = createTestDb()
    try {
      const computed = await computeFallbackSceneWritePolicy()
      const receipt = await activateScenePolicy(sqlite, {
        expected: { ...computed },
        publishedAt: NOW,
      })
      // 核实凭据：指纹 + publishedAt + 凭据哈希
      expect(receipt).toMatchObject({ id: 'active', ...computed, publishedAt: NOW })
      expect(receipt.receiptHash).toMatch(/^[0-9a-f]{64}$/)
      const stored = sqlite.prepare("SELECT * FROM scene_validation_policy WHERE id = 'active'").get() as
        { rules_version: string; asset_manifest_hash: string; template_catalog_hash: string; published_at: string }
      expect(stored).toMatchObject({
        rules_version: computed.rulesVersion,
        asset_manifest_hash: computed.assetManifestHash,
        template_catalog_hash: computed.templateCatalogHash,
        published_at: NOW,
      })
      // 激活后服务端解析口径切换到 active 行
      expect(await resolveSceneWritePolicy(db)).toEqual(computed)

      // 已有 active：即使指纹相符、仅时间不同的重复激活也拒绝（不覆盖）
      await expect(activateScenePolicy(sqlite, { expected: { ...computed }, publishedAt: '2030-01-01T00:00:00.000Z' }))
        .rejects.toThrow(/拒绝降级或覆盖/)
      // 降级形态：携带旧版本指纹预期的激活同样被拒，且原有行不变
      await expect(activateScenePolicy(sqlite, { expected: { rulesVersion: 'legacy-v0' } }))
        .rejects.toThrow(ScenePolicyActivationRefusal)
      const after = sqlite.prepare("SELECT * FROM scene_validation_policy WHERE id = 'active'").get() as { published_at: string }
      expect(after.published_at).toBe(NOW)
      expect((sqlite.prepare('SELECT COUNT(*) AS n FROM scene_validation_policy').get() as { n: number }).n).toBe(1)
    } finally { close() }
  })
})
