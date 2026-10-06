import { and, desc, eq } from 'drizzle-orm'
import {
  isSerializedVoxelDocument, isSerializedVoxelSpaces,
  type SerializedVoxelDocument, type SerializedVoxelSpaces,
} from '@possibility/voxel-contract'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../db/client'
import { demoBaselines, sceneCompatibilityRequests, worldSceneRevisions, worldScenes } from '../db/schema'
import {
  buildCloneCopyWriteProof,
  buildCommitGuardStatement,
  buildCommitWriteProof,
  buildInitialWriteProof,
  buildPendingSceneBindings,
  loadSceneWriteProofFacts,
  resolveSceneWritePolicy,
  type PendingSceneBindings,
  type SceneWriteProofBaseline,
  type SceneWriteAuthority,
  type SceneWriteProofFacts,
  type SceneWriteProofRequest,
} from './compatibility/write-proof'

/** 存储层文档（S2 起）:体素信封或多空间体素包;2D 场景已退役 */
export type StoredSceneDocument = SerializedVoxelDocument | SerializedVoxelSpaces

/** 体素系负载（单文档信封 / 多空间包）：不透明存储，不做 2D 归一化、不改写文档内版本 */
export function isVoxelScenePayload(value: unknown): value is SerializedVoxelDocument | SerializedVoxelSpaces {
  return isSerializedVoxelDocument(value) || isSerializedVoxelSpaces(value)
}

/** 体素系负载的主题 id（多空间包取第一个空间的主题） */
function voxelThemeId(doc: SerializedVoxelDocument | SerializedVoxelSpaces): string {
  return isSerializedVoxelDocument(doc) ? doc.theme : (doc.spaces[0]?.document.theme ?? 'mist-manor')
}
export interface StoredScene { document: StoredSceneDocument; version: number; contentHash: string; createdAt: string }
export class SceneConflict extends Error { constructor(message = '场景已被其他操作更新，请重新加载') { super(message); this.name = 'SceneConflict' } }

/**
 * A1 B29：提交用途命名空间 = kind + 兼容审计 purpose + 草稿身份。
 * 执行租约字段（attempt/leaseToken）不参与：崩溃后以新 attempt 重试同一确认
 * 仍属同一用途，应命中重放；普通编辑与兼容请求同 requestId 则明确拒绝。
 */
function auditNamespace(compatibilityJson: string | null | undefined): { purpose: string | null; draftId: string | null } {
  if (!compatibilityJson) return { purpose: null, draftId: null }
  try {
    const audit = JSON.parse(compatibilityJson) as { purpose?: unknown; draftId?: unknown }
    return {
      purpose: typeof audit.purpose === 'string' ? audit.purpose : null,
      draftId: typeof audit.draftId === 'string' ? audit.draftId : null,
    }
  } catch { return { purpose: null, draftId: null } }
}

function proofRequestDraftId(validationJson: string | null | undefined): string | null {
  if (!validationJson) return null
  try {
    const proof = JSON.parse(validationJson) as { request?: { draftId?: unknown } | null }
    return typeof proof.request?.draftId === 'string' ? proof.request.draftId : null
  } catch { return null }
}

function commitNamespaceKey(parts: { kind: string; purpose: string | null; draftId: string | null }): string {
  return JSON.stringify([parts.kind, parts.purpose, parts.draftId])
}

function commitInputNamespace(input: { kind: string; compatibilityJson?: string | null; compatibility?: SceneWriteProofRequest }): string {
  const audit = auditNamespace(input.compatibilityJson)
  return commitNamespaceKey({ kind: input.kind, purpose: audit.purpose, draftId: input.compatibility?.draftId ?? audit.draftId })
}

function commitRowNamespace(row: { kind: string; compatibilityJson: string | null; validationJson: string | null }): string {
  const audit = auditNamespace(row.compatibilityJson)
  return commitNamespaceKey({ kind: row.kind, purpose: audit.purpose, draftId: proofRequestDraftId(row.validationJson) ?? audit.draftId })
}

async function hashText(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/** 文档哈希：体素系负载对（文档 + 目标修订版本）整体哈希（version 是格式版本，恒 1） */
async function hashStoredDocument(document: StoredSceneDocument, version: number): Promise<string> {
  return hashText(JSON.stringify({ document, version }))
}
export async function readCurrentScene(db: Db, worldId: string): Promise<StoredScene | null> {
  const current = await db.select().from(worldScenes).where(eq(worldScenes.worldId, worldId)).get()
  if (!current) return null
  const row = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, worldId), eq(worldSceneRevisions.version, current.currentVersion))).get()
  if (!row) throw new Error('场景版本索引损坏：当前版本记录不存在')
  try { return { document: JSON.parse(row.documentJson) as StoredSceneDocument, version: row.version, contentHash: row.contentHash, createdAt: row.createdAt } }
  catch { throw new Error('场景文档损坏：无法解析已保存版本') }
}
export async function readSceneVersion(db: Db, worldId: string, version: number): Promise<StoredScene | null> {
  const row = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, worldId), eq(worldSceneRevisions.version, version))).get()
  if (!row) return null
  try { return { document: JSON.parse(row.documentJson) as StoredSceneDocument, version: row.version, contentHash: row.contentHash, createdAt: row.createdAt } }
  catch { throw new Error('场景历史文档损坏：无法解析指定版本') }
}
export async function readSceneRequest(db: Db, worldId: string, requestId: string): Promise<StoredScene | null> {
  const row = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, worldId), eq(worldSceneRevisions.requestId, requestId))).get()
  if (!row) return null
  try { return { document: JSON.parse(row.documentJson) as StoredSceneDocument, version: row.version, contentHash: row.contentHash, createdAt: row.createdAt } }
  catch { throw new Error('场景请求记录损坏：无法解析版本') }
}
export async function listSceneVersions(db: Db, worldId: string, limit = 30) {
  const rows = await db.select({ version: worldSceneRevisions.version, parentVersion: worldSceneRevisions.parentVersion, summary: worldSceneRevisions.summary, kind: worldSceneRevisions.kind, createdAt: worldSceneRevisions.createdAt, contentHash: worldSceneRevisions.contentHash })
    .from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, worldId)).orderBy(desc(worldSceneRevisions.version)).limit(Math.max(1, Math.min(100, limit))).all()
  return rows
}
export async function commitScene(db: Db, input: {
  worldId: string
  expectedVersion: number
  requestId: string
  document: StoredSceneDocument
  summary: string
  kind: string
  allowBaseline?: boolean
  compatibilityJson?: string | null
  /** Compatibility confirm execution identity, re-checked by the insert gate. */
  compatibility?: SceneWriteProofRequest
  /** Atomically complete a compatibility request with the scene revision. */
  compatibilityCompletion?: { actorKey: string }
  /** Final auth/ownership recheck, provided only by trusted server routes. */
  authority?: SceneWriteAuthority
  /** A1 B28：演示基线重指向与修订同批写入；批内 guard 断言新基线引用。 */
  baselineUpdate?: { baselineId: string }
}): Promise<StoredScene> {
  const baseline = await db.select({ id: demoBaselines.id }).from(demoBaselines)
    .where(and(eq(demoBaselines.worldId, input.worldId), eq(demoBaselines.status, 'active'))).get()
  if (baseline && !input.allowBaseline) throw new SceneConflict('公共演示基线只读，请先进入访客体验副本')
  const prior = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, input.worldId), eq(worldSceneRevisions.requestId, input.requestId))).get()
  const normalized = structuredClone(input.document)
  const contentHash = await hashStoredDocument(normalized, input.expectedVersion + 1)
  if (prior) {
    // B29：跨用途同 ID 明确拒绝，不返回对方结果；同用途同内容重发仍返回原结果
    if (commitRowNamespace(prior) !== commitInputNamespace(input)) throw new SceneConflict('同一 request ID 已用于其他场景用途')
    if (prior.contentHash !== contentHash) throw new SceneConflict('同一 request ID 不能提交不同场景内容')
    return { document: JSON.parse(prior.documentJson) as StoredSceneDocument, version: prior.version, contentHash: prior.contentHash, createdAt: prior.createdAt }
  }
  const current = await db.select().from(worldScenes).where(eq(worldScenes.worldId, input.worldId)).get()
  const actual = current?.currentVersion ?? 0
  if (actual !== input.expectedVersion) throw new SceneConflict()
  const version = actual + 1; const now = new Date().toISOString(); const id = crypto.randomUUID()
  // 体素系负载的 version 是格式版本（恒 1），修订版本只存在行上
  const document: StoredSceneDocument = normalized
  const themeId = voxelThemeId(document)
  const serialized = JSON.stringify(document)
  // A1 B16：写入依据只由服务端从权威资料构造，随修订一同持久化
  const proof = await buildCommitWriteProof(db, {
    worldId: input.worldId, candidate: { version, contentHash }, ...(input.compatibility ? { compatibility: input.compatibility } : {}),
  })
  // B28：基线重指向入批时 guard 断言新引用；依据内仍是提交前基线（插入闸门在基线更新前核对）
  const guardBaseline: SceneWriteProofBaseline | null = input.baselineUpdate
    ? { id: input.baselineUpdate.baselineId, status: 'active', sceneVersion: version, contentHash }
    : proof.baseline
  const guard = buildCommitGuardStatement(db, {
    revisionId: id, worldId: input.worldId, version, requestId: input.requestId, baseline: guardBaseline,
    ...(input.authority ? { authority: input.authority } : {}),
    ...(input.compatibility && input.compatibilityCompletion ? {
      requestCompletion: { requestId: input.requestId, attempt: input.compatibility.attempt, resultVersion: version },
    } : {}),
  })
  const baselineStatement = input.baselineUpdate
    ? db.update(demoBaselines).set({ sceneVersion: version, contentHash })
      .where(and(eq(demoBaselines.id, input.baselineUpdate.baselineId), eq(demoBaselines.worldId, input.worldId), eq(demoBaselines.status, 'active')))
    : null
  const requestCompletionStatement = input.compatibility && input.compatibilityCompletion
    ? db.update(sceneCompatibilityRequests).set({
      state: 'completed', resultVersion: version, leaseToken: null, leaseUntil: null, updatedAt: now,
    }).where(and(
      eq(sceneCompatibilityRequests.worldId, input.worldId),
      eq(sceneCompatibilityRequests.requestId, input.requestId),
      eq(sceneCompatibilityRequests.actorKey, input.compatibilityCompletion.actorKey),
      eq(sceneCompatibilityRequests.attempt, input.compatibility.attempt),
      eq(sceneCompatibilityRequests.leaseToken, input.compatibility.leaseToken),
      eq(sceneCompatibilityRequests.state, 'submitting'),
    ))
    : null
  try {
    if (current) await db.batch([
      db.insert(worldSceneRevisions).values({ id, worldId: input.worldId, version, parentVersion: actual, requestId: input.requestId, contentHash, documentJson: serialized, summary: input.summary, kind: input.kind, compatibilityJson: input.compatibilityJson ?? null, validationJson: JSON.stringify(proof), commitGuard: true, createdAt: now }),
      db.update(worldScenes).set({ currentVersion: version, themeId, updatedAt: now }).where(and(eq(worldScenes.worldId, input.worldId), eq(worldScenes.currentVersion, actual))),
      ...(baselineStatement ? [baselineStatement] : []),
      ...(requestCompletionStatement ? [requestCompletionStatement] : []),
      guard,
    ])
    else await db.batch([
      // 首版同样先插入有依据的新修订、后创建当前指针，避免误用普通旧版本闸门
      db.insert(worldSceneRevisions).values({ id, worldId: input.worldId, version, parentVersion: null, requestId: input.requestId, contentHash, documentJson: serialized, summary: input.summary, kind: input.kind, compatibilityJson: input.compatibilityJson ?? null, validationJson: JSON.stringify(proof), commitGuard: true, createdAt: now }),
      db.insert(worldScenes).values({ worldId: input.worldId, currentVersion: version, themeId, updatedAt: now }),
      ...(baselineStatement ? [baselineStatement] : []),
      ...(requestCompletionStatement ? [requestCompletionStatement] : []),
      guard,
    ])
  } catch (error) { throw new SceneConflict(error instanceof Error ? error.message : undefined) }
  return { document, version, contentHash, createdAt: now }
}
export async function initialSceneStatements(db: Db, worldId: string, document: StoredSceneDocument, requestId: string, pendingBindings?: PendingSceneBindings): Promise<[BatchItem<'sqlite'>, BatchItem<'sqlite'>, BatchItem<'sqlite'>]> {
  const now = new Date().toISOString()
  const doc = structuredClone(document)
  const themeId = voxelThemeId(doc)
  const contentHash = await hashText(JSON.stringify({ document: doc, version: 1 }))
  // A1 B16/B17：首版修订携带服务端构造的 initial 依据，且先于当前指针落库。
  // A1 B30：外层同批创建世界时由调用方显式传入待创建绑定快照——此时世界/成员尚未落库，读库只会得到空集合。
  const facts: SceneWriteProofFacts = pendingBindings
    ? { policy: await resolveSceneWritePolicy(db), bindings: await buildPendingSceneBindings(pendingBindings), baseline: null, current: null }
    : await loadSceneWriteProofFacts(db, worldId)
  const proof = buildInitialWriteProof(facts, { candidate: { version: 1, contentHash } })
  const revisionId = crypto.randomUUID()
  return [
    db.insert(worldSceneRevisions).values({ id: revisionId, worldId, version: 1, parentVersion: null, requestId, contentHash, documentJson: JSON.stringify(doc), summary: '开始生活时的场景', kind: 'initial', validationJson: JSON.stringify(proof), commitGuard: true, createdAt: now }),
    db.insert(worldScenes).values({ worldId, currentVersion: 1, themeId, updatedAt: now }),
    // B30 步骤2 最终断言：批内核对外层世界/成员/地点与依据快照一致，不符则 guard=0 整批回滚
    buildCommitGuardStatement(db, { revisionId, worldId, version: 1, requestId, baseline: proof.baseline, expectedBindings: facts.bindings }),
  ]
}

export interface CloneSceneStatementsInput {
  sourceWorldId: string
  targetWorldId: string
  targetOwnerId: string
  /**
   * 目标世界（与场景同批创建、尚未落库）的待创建绑定快照（B30 同款口径）：
   * 克隆批内读库只能得到空集合，必须由调用方显式给出重映射后的成员与地点。
   */
  pendingBindings: PendingSceneBindings
  /** 源世界的当前场景指针；源世界无场景时传 null（此时 revisions 也必须为空）。 */
  pointer: typeof worldScenes.$inferSelect | null
  /** 源世界的全部场景修订。 */
  revisions: Array<typeof worldSceneRevisions.$inferSelect>
  /** 目标修订 id/请求 id 分配器（调用方掌握确定性重放口径）。 */
  revisionIdFor: (source: typeof worldSceneRevisions.$inferSelect) => Promise<string>
  requestIdFor: (source: typeof worldSceneRevisions.$inferSelect) => Promise<string>
  /** 身份重映射后的文档 JSON（人物/时间线引用已由调用方改写）。 */
  remapDocument: (documentJson: string) => string
  issuedAt?: string
}

/**
 * A1 B31：克隆批内证明与语句工厂。
 *
 * 只返回语句，不独立落库——调用方把返回的修订/指针/断言语句拼进外层克隆批，
 * 与身份重映射后的世界/成员同批提交，任何一处失败整批回滚。
 *
 * 与裸复制的差别：
 *  - 每条修订生成新的 clone-copy 依据（来源指向源世界修订、归属校验目标 owner），
 *    绝不逐字携带源行的旧依据（旧依据的 source.worldId 指向源世界，策略激活后必然
 *    source_mismatch ABORT，且等于把"源场景有效"的声明伪造到目标世界）；
 *  - contentHash 按重映射后的新文档 + 原版本号重算，与目标世界的存储文档一致；
 *  - 末尾附批内后置断言（指针/修订/基线/绑定复核），断言落空则整批回滚。
 */
export async function cloneSceneStatements(db: Db, input: CloneSceneStatementsInput): Promise<BatchItem<'sqlite'>[]> {
  if (!input.pointer && input.revisions.length === 0) return []
  if (!input.pointer || input.revisions.length === 0) {
    throw new Error('克隆源场景资料不一致：指针与修订必须同时存在')
  }
  const revisions = [...input.revisions].sort((a, b) => a.version - b.version)
  const current = revisions.find(row => row.version === input.pointer!.currentVersion)
  if (!current) throw new Error('克隆源场景资料不一致：当前版本修订不存在')

  const facts: SceneWriteProofFacts = {
    policy: await resolveSceneWritePolicy(db),
    bindings: await buildPendingSceneBindings(input.pendingBindings),
    baseline: null,
    current: null,
  }
  const now = input.issuedAt ?? new Date().toISOString()
  const statements: BatchItem<'sqlite'>[] = []
  let currentRevisionId: string | null = null
  let currentRequestId: string | null = null
  for (const row of revisions) {
    const documentJson = input.remapDocument(row.documentJson)
    // 按复制后的 document+version 重算哈希，与 hashStoredDocument 口径一致
    const contentHash = await hashText(JSON.stringify({ document: JSON.parse(documentJson), version: row.version }))
    const proof = buildCloneCopyWriteProof(facts, {
      source: { worldId: input.sourceWorldId, version: row.version, contentHash: row.contentHash },
      targetOwnerId: input.targetOwnerId,
      candidate: { version: row.version, contentHash },
      issuedAt: now,
    })
    const revisionId = await input.revisionIdFor(row)
    const requestId = await input.requestIdFor(row)
    if (row.version === current.version) {
      currentRevisionId = revisionId
      currentRequestId = requestId
    }
    statements.push(db.insert(worldSceneRevisions).values({
      id: revisionId, worldId: input.targetWorldId, version: row.version, parentVersion: row.parentVersion,
      requestId, contentHash, documentJson, summary: row.summary, kind: row.kind,
      compatibilityJson: row.compatibilityJson, validationJson: JSON.stringify(proof), commitGuard: true,
      createdAt: row.createdAt,
    }))
  }
  statements.push(db.insert(worldScenes).values({
    worldId: input.targetWorldId, currentVersion: input.pointer.currentVersion,
    themeId: input.pointer.themeId, updatedAt: now,
  }))
  // 后置断言：目标指针/当前修订/无基线/批内世界与成员绑定复核，落空则整批回滚
  statements.push(buildCommitGuardStatement(db, {
    revisionId: currentRevisionId!, worldId: input.targetWorldId, version: current.version,
    requestId: currentRequestId!, baseline: null, expectedBindings: facts.bindings,
  }))
  return statements
}
