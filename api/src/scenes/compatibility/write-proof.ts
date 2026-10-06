import { and, eq, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { SceneBindingContext, SceneSourceRef } from '@possibility/voxel-contract'
import type { Db } from '../../db/client'
import { demoBaselines, sceneValidationPolicy, worldSceneRevisions, worldScenes } from '../../db/schema'
import { libraryManifest } from '../../voxel/library-manifest'
import { loadWorldSceneBindings } from './context'
import { stableJson } from './stable-json'

/**
 * A1 B16–B19：场景修订写入依据（write-proof）。
 *
 * 依据只由服务端从权威数据库资料构造：发布指纹、来源/当前/候选、绑定集合、
 * 基线引用与兼容草稿/请求核对资料。模块不接受 HTTP 请求体传入的写入模式，
 * 依据中也不出现会话口令、密码、API key 等私有鉴权字段——鉴权复核通过
 * buildCommitGuardStatement 的 SQL 条件以绑定参数接入，不落入持久化依据。
 */

export const SCENE_WRITE_PROOF_SCHEMA = 'scene-write-proof-v1' as const

export type SceneWriteProofMode = 'valid' | 'initial' | 'clone-copy'

export interface SceneWriteProofPolicy {
  rulesVersion: string
  assetManifestHash: string
  templateCatalogHash: string
}

/** Binding set snapshot compared against world_persons / worlds.locations_json at insert time. */
export interface SceneWriteProofBindings {
  personIds: string[]
  locations: string[]
  bindingHash: string
}

/** Pending member/location snapshot for a world created in the same outer batch (B30). */
export interface PendingSceneBindings {
  personIds: string[]
  locations: { name: string; stableId?: string }[]
}

/**
 * Binding snapshot for a not-yet-committed world: same shape loadWorldSceneBindings
 * returns right after the outer batch lands (no scene yet, so no derived carrier
 * or protection entries). The authority gate compares personIds/locations only;
 * bindingHash stays consistent with the post-commit facts loader.
 */
export async function buildPendingSceneBindings(input: PendingSceneBindings): Promise<SceneWriteProofBindings> {
  const context: SceneBindingContext = {
    personIds: [...input.personIds],
    locations: input.locations.map(location => ({
      name: location.name,
      ...(typeof location.stableId === 'string' ? { stableId: location.stableId } : {}),
    })),
    protectedObjects: [],
    protectedPlacements: [],
    locationBindings: [],
    personBindings: [],
    entries: [],
  }
  return {
    personIds: [...input.personIds].sort(),
    locations: input.locations.map(location => location.name).sort(),
    bindingHash: await hashBindingContext(context),
  }
}

async function hashBindingContext(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export interface SceneWriteProofBaseline {
  id: string
  status: string
  sceneVersion: number
  contentHash: string
}

/** Compatibility commit execution identity; attempt/token/lease re-checked by the insert gate. */
export interface SceneWriteProofRequest {
  draftId: string
  requestId: string
  attempt: number
  leaseToken: string
  leaseUntil: string
}

interface SceneWriteProofBase {
  schema: typeof SCENE_WRITE_PROOF_SCHEMA
  policy: SceneWriteProofPolicy
  /** Server clock at proof construction; the request lease must outlive it. */
  issuedAt: string
  current: { expectedVersion: number; contentHash: string } | null
  candidate: { version: number; contentHash: string }
  bindings: SceneWriteProofBindings
  baseline: SceneWriteProofBaseline | null
  request: SceneWriteProofRequest | null
}

export type SceneWriteProof =
  | (SceneWriteProofBase & { mode: 'valid'; source: SceneSourceRef })
  | (SceneWriteProofBase & { mode: 'initial' })
  | (SceneWriteProofBase & { mode: 'clone-copy'; source: SceneSourceRef; targetOwnerId: string })

export interface SceneWriteProofFacts {
  policy: SceneWriteProofPolicy
  bindings: SceneWriteProofBindings
  baseline: SceneWriteProofBaseline | null
  current: { version: number; contentHash: string } | null
}

async function hashJson(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Fallback fingerprints identical to context.ts / the controlled activation
 * script; the active policy row always wins when present.
 */
export async function computeFallbackSceneWritePolicy(): Promise<SceneWriteProofPolicy> {
  const manifest = libraryManifest()
  if (!manifest) throw new Error('资产清单不可用，无法构造写入依据')
  return {
    rulesVersion: 'voxel-scene-validation-v1',
    assetManifestHash: await hashJson(manifest),
    templateCatalogHash: await hashJson('mist-manor-template-catalog-v1'),
  }
}

/** Active published fingerprints, or the compiled fallback before activation. */
export async function resolveSceneWritePolicy(db: Db): Promise<SceneWriteProofPolicy> {
  const active = await db.select().from(sceneValidationPolicy).where(eq(sceneValidationPolicy.id, 'active')).get()
  if (active) {
    return {
      rulesVersion: active.rulesVersion,
      assetManifestHash: active.assetManifestHash,
      templateCatalogHash: active.templateCatalogHash,
    }
  }
  return computeFallbackSceneWritePolicy()
}

export async function readSceneWriteBaseline(db: Db, worldId: string): Promise<SceneWriteProofBaseline | null> {
  const row = await db.select().from(demoBaselines).where(eq(demoBaselines.worldId, worldId)).get()
  if (!row) return null
  return { id: row.id, status: row.status, sceneVersion: row.sceneVersion, contentHash: row.contentHash }
}

/** Loads the authoritative facts a write proof is built from. Never reads request payloads. */
export async function loadSceneWriteProofFacts(db: Db, worldId: string): Promise<SceneWriteProofFacts> {
  const bindings = await loadWorldSceneBindings(db, worldId)
  const pointer = await db.select().from(worldScenes).where(eq(worldScenes.worldId, worldId)).get()
  let current: SceneWriteProofFacts['current'] = null
  if (pointer) {
    const revision = await db.select().from(worldSceneRevisions).where(and(
      eq(worldSceneRevisions.worldId, worldId), eq(worldSceneRevisions.version, pointer.currentVersion),
    )).get()
    if (!revision) throw new Error('场景版本索引损坏：当前版本记录不存在')
    current = { version: revision.version, contentHash: revision.contentHash }
  }
  return {
    policy: await resolveSceneWritePolicy(db),
    bindings: {
      personIds: [...bindings.personIds].sort(),
      locations: bindings.locations.map(location => location.name).sort(),
      bindingHash: await hashJson(bindings),
    },
    baseline: await readSceneWriteBaseline(db, worldId),
    current,
  }
}

function proofBase(facts: SceneWriteProofFacts, candidate: { version: number; contentHash: string }, request: SceneWriteProofRequest | null, issuedAt: string): SceneWriteProofBase {
  return {
    schema: SCENE_WRITE_PROOF_SCHEMA,
    policy: facts.policy,
    issuedAt,
    current: facts.current ? { expectedVersion: facts.current.version, contentHash: facts.current.contentHash } : null,
    candidate,
    bindings: facts.bindings,
    baseline: facts.baseline,
    request,
  }
}

/** Ordinary edit / restore / compatibility confirm: source must be a revision of the same world. */
export function buildValidWriteProof(
  facts: SceneWriteProofFacts,
  input: { worldId: string; candidate: { version: number; contentHash: string }; request?: SceneWriteProofRequest | null; issuedAt?: string },
): SceneWriteProof {
  if (!facts.current) throw new Error('valid 写入模式需要已存在的当前场景')
  return {
    ...proofBase(facts, input.candidate, input.request ?? null, input.issuedAt ?? new Date().toISOString()),
    mode: 'valid',
    source: { worldId: input.worldId, version: facts.current.version, contentHash: facts.current.contentHash },
  }
}

/** First revision only; the insert gate separately proves no current pointer exists. */
export function buildInitialWriteProof(
  facts: SceneWriteProofFacts,
  input: { candidate: { version: number; contentHash: string }; request?: SceneWriteProofRequest | null; issuedAt?: string },
): SceneWriteProof {
  if (facts.current) throw new Error('initial 写入模式要求目标世界尚无当前场景')
  if (input.candidate.version !== 1) throw new Error('initial 写入模式只接受首版候选')
  return {
    ...proofBase(facts, input.candidate, input.request ?? null, input.issuedAt ?? new Date().toISOString()),
    mode: 'initial',
  }
}

/**
 * Trusted clone path: keeps the source-world revision reference and the target
 * owner re-check. It never claims the copied document passed the new rules, so
 * it is a distinct mode rather than a 'valid' proof.
 */
export function buildCloneCopyWriteProof(
  facts: SceneWriteProofFacts,
  input: {
    source: SceneSourceRef
    targetOwnerId: string
    candidate: { version: number; contentHash: string }
    request?: SceneWriteProofRequest | null
    issuedAt?: string
  },
): SceneWriteProof {
  return {
    ...proofBase(facts, input.candidate, input.request ?? null, input.issuedAt ?? new Date().toISOString()),
    mode: 'clone-copy',
    source: input.source,
    targetOwnerId: input.targetOwnerId,
  }
}

export interface BuildCommitWriteProofInput {
  worldId: string
  candidate: { version: number; contentHash: string }
  compatibility?: SceneWriteProofRequest
  issuedAt?: string
}

/** Proof assembled for one real commit: 'initial' when the world has no scene yet, else 'valid'. */
export async function buildCommitWriteProof(db: Db, input: BuildCommitWriteProofInput): Promise<SceneWriteProof> {
  const facts = await loadSceneWriteProofFacts(db, input.worldId)
  if (facts.current) {
    return buildValidWriteProof(facts, { worldId: input.worldId, candidate: input.candidate, request: input.compatibility ?? null, ...(input.issuedAt ? { issuedAt: input.issuedAt } : {}) })
  }
  return buildInitialWriteProof(facts, { candidate: input.candidate, request: input.compatibility ?? null, ...(input.issuedAt ? { issuedAt: input.issuedAt } : {}) })
}

/**
 * Private authorization re-check parameters. Supplied as bound SQL parameters
 * only — they are never persisted inside the write proof.
 */
export interface SceneWriteAuthority {
  sessionToken?: string
  ownerUserId?: string
  adminUserId?: string
}

export interface CommitGuardInput {
  revisionId: string
  worldId: string
  version: number
  requestId: string
  baseline: SceneWriteProofBaseline | null
  /** Require the completion journal update to be part of this same commit batch. */
  requestCompletion?: { requestId: string; attempt: number; resultVersion: number }
  authority?: SceneWriteAuthority
  /**
   * B30 最终断言：首版与外层世界/成员同批写入时，核对批内真实落库的
   * 世界/成员/地点与依据快照一致（与 0037 authority_gate 同一口径）。
   */
  expectedBindings?: SceneWriteProofBindings
}

/**
 * Post-condition for one commit batch: re-computes commit_guard over the just
 * inserted revision. Any inconsistency (pointer not advanced, revision missing,
 * baseline drifted, session/ownership/admin revoked) writes 0, the commit_guard
 * trigger ABORTs and the whole batch rolls back. The revision is addressed by
 * primary key, so a zero-row update cannot mask a failure.
 */
export function buildCommitGuardStatement(db: Db, input: CommitGuardInput) {
  const conditions: SQL[] = [
    sql`EXISTS (SELECT 1 FROM world_scenes WHERE world_id = ${input.worldId} AND current_version = ${input.version})`,
    sql`EXISTS (SELECT 1 FROM world_scene_revisions WHERE world_id = ${input.worldId} AND version = ${input.version} AND request_id = ${input.requestId})`,
  ]
  if (input.baseline) {
    const baseline = input.baseline
    conditions.push(sql`EXISTS (SELECT 1 FROM demo_baselines WHERE world_id = ${input.worldId} AND id = ${baseline.id} AND status = ${baseline.status} AND scene_version = ${baseline.sceneVersion} AND content_hash = ${baseline.contentHash})`)
  } else {
    conditions.push(sql`NOT EXISTS (SELECT 1 FROM demo_baselines WHERE world_id = ${input.worldId})`)
  }
  if (input.expectedBindings) {
    const expected = input.expectedBindings
    conditions.push(sql`EXISTS (SELECT 1 FROM worlds WHERE id = ${input.worldId})`)
    conditions.push(sql`(SELECT COUNT(*) FROM world_persons WHERE world_id = ${input.worldId}) = ${expected.personIds.length}`)
    conditions.push(sql`NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(expected.personIds)}) AS je WHERE NOT EXISTS (SELECT 1 FROM world_persons AS wp WHERE wp.world_id = ${input.worldId} AND wp.person_id = je.value))`)
    conditions.push(sql`(SELECT COUNT(*) FROM json_each((SELECT locations_json FROM worlds WHERE id = ${input.worldId}))) = ${expected.locations.length}`)
    conditions.push(sql`NOT EXISTS (SELECT 1 FROM json_each((SELECT locations_json FROM worlds WHERE id = ${input.worldId})) AS wl WHERE NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(expected.locations)}) AS pl WHERE pl.value = json_extract(wl.value, '$.name')))`)
  }
  if (input.requestCompletion) {
    const expected = input.requestCompletion
    conditions.push(sql`EXISTS (SELECT 1 FROM scene_compatibility_requests WHERE world_id = ${input.worldId} AND request_id = ${expected.requestId} AND attempt = ${expected.attempt} AND state = 'completed' AND result_version = ${expected.resultVersion} AND lease_token IS NULL AND lease_until IS NULL)`)
  }
  const authority = input.authority
  if (authority?.sessionToken) {
    conditions.push(sql`EXISTS (SELECT 1 FROM sessions WHERE token = ${authority.sessionToken} AND julianday(expires_at) > julianday('now'))`)
  }
  if (authority?.ownerUserId) {
    conditions.push(sql`EXISTS (SELECT 1 FROM worlds WHERE id = ${input.worldId} AND user_id = ${authority.ownerUserId})`)
  }
  if (authority?.adminUserId) {
    conditions.push(sql`EXISTS (SELECT 1 FROM users WHERE id = ${authority.adminUserId} AND role = 'admin')`)
  }
  const condition = sql.join(conditions.map(item => sql`(${item})`), sql` AND `)
  return db.update(worldSceneRevisions).set({
    commitGuard: sql`CASE WHEN ${condition} THEN 1 ELSE 0 END`,
  }).where(and(eq(worldSceneRevisions.id, input.revisionId), eq(worldSceneRevisions.version, input.version)))
}
