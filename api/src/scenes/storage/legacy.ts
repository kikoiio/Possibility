import { and, desc, eq } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../../db/client'
import { demoBaselines, sceneCompatibilityRequests, worldSceneRevisions, worldScenes } from '../../db/schema'
import { buildCloneCopyWriteProof, buildCommitGuardStatement, buildCommitWriteProof, buildInitialWriteProof, buildPendingSceneBindings, loadSceneWriteProofFacts, resolveSceneWritePolicy, type PendingSceneBindings, type SceneWriteAuthority, type SceneWriteProofBaseline, type SceneWriteProofFacts, type SceneWriteProofRequest } from '../compatibility/write-proof'
import { hashStoredDocument, hashText, storedSceneThemeId } from './document'
import { legacyMainSceneStatements } from './main-line-bridge'
import { commitTimelineScene, readCurrentTimelineScene, readTimelineSceneVersion, sameCommitNamespace } from './timeline'
import { SceneConflict, type CloneSceneStatementsInput, type StoredScene, type StoredSceneDocument, type TimelineSceneScope } from './types'

export async function readCurrentScene(db: Db, worldId: string, scope?: TimelineSceneScope): Promise<StoredScene | null> {
  if (scope) {
    if (scope.worldId !== worldId) throw new SceneConflict('场景作用域不一致')
    return readCurrentTimelineScene(db, scope)
  }
  const current = await db.select().from(worldScenes).where(eq(worldScenes.worldId, worldId)).get()
  if (!current) return null
  const row = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, worldId), eq(worldSceneRevisions.version, current.currentVersion))).get()
  if (!row) throw new Error('场景版本索引损坏：当前版本记录不存在')
  try { return { document: JSON.parse(row.documentJson) as StoredSceneDocument, version: row.version, contentHash: row.contentHash, createdAt: row.createdAt } }
  catch { throw new Error('场景文档损坏：无法解析已保存版本') }
}

export async function readSceneVersion(db: Db, worldId: string, version: number, scope?: TimelineSceneScope): Promise<StoredScene | null> {
  if (scope) {
    if (scope.worldId !== worldId) throw new SceneConflict('场景作用域不一致')
    return readTimelineSceneVersion(db, scope, version)
  }
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
  scope?: TimelineSceneScope
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
  if (input.scope) {
    if (input.worldId !== input.scope.worldId) throw new SceneConflict('场景作用域不一致')
    return commitTimelineScene(db, { ...input, scope: input.scope })
  }
  const baseline = await db.select({ id: demoBaselines.id }).from(demoBaselines)
    .where(and(eq(demoBaselines.worldId, input.worldId), eq(demoBaselines.status, 'active'))).get()
  if (baseline && !input.allowBaseline) throw new SceneConflict('公共演示基线只读，请先进入访客体验副本')
  const prior = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, input.worldId), eq(worldSceneRevisions.requestId, input.requestId))).get()
  const normalized = structuredClone(input.document)
  const contentHash = await hashStoredDocument(normalized, input.expectedVersion + 1)
  if (prior) {
    if (!sameCommitNamespace(input, prior)) throw new SceneConflict('同一 request ID 已用于其他场景用途')
    if (prior.contentHash !== contentHash) throw new SceneConflict('同一 request ID 不能提交不同场景内容')
    return { document: JSON.parse(prior.documentJson) as StoredSceneDocument, version: prior.version, contentHash: prior.contentHash, createdAt: prior.createdAt }
  }
  const current = await db.select().from(worldScenes).where(eq(worldScenes.worldId, input.worldId)).get()
  const actual = current?.currentVersion ?? 0
  if (actual !== input.expectedVersion) throw new SceneConflict()
  const version = actual + 1; const now = new Date().toISOString(); const id = crypto.randomUUID()
  const document: StoredSceneDocument = normalized
  const themeId = storedSceneThemeId(document)
  const serialized = JSON.stringify(document)
  const preCommitProof = await buildCommitWriteProof(db, {
    worldId: input.worldId, candidate: { version, contentHash }, ...(input.compatibility ? { compatibility: input.compatibility } : {}),
  })
  const baselineAtGuard: SceneWriteProofBaseline | null = input.baselineUpdate
    ? { id: input.baselineUpdate.baselineId, status: 'active', sceneVersion: version, contentHash }
    : preCommitProof.baseline
  const guard = buildCommitGuardStatement(db, {
    revisionId: id, worldId: input.worldId, version, requestId: input.requestId, baseline: baselineAtGuard,
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
  const proofJson = JSON.stringify(preCommitProof)
  const timelineWrites = await legacyMainSceneStatements(db, {
    worldId: input.worldId, version, expectedVersion: actual, document,
    requestId: input.requestId, summary: input.summary, kind: input.kind,
    validationJson: proofJson, createdAt: now,
  })
  try {
    if (current) await db.batch([
      db.insert(worldSceneRevisions).values({ id, worldId: input.worldId, version, parentVersion: actual, requestId: input.requestId, contentHash, documentJson: serialized, summary: input.summary, kind: input.kind, compatibilityJson: input.compatibilityJson ?? null, validationJson: proofJson, commitGuard: true, createdAt: now }),
      db.update(worldScenes).set({ currentVersion: version, themeId, updatedAt: now }).where(and(eq(worldScenes.worldId, input.worldId), eq(worldScenes.currentVersion, actual))),
      ...(baselineStatement ? [baselineStatement] : []),
      ...(requestCompletionStatement ? [requestCompletionStatement] : []),
      guard,
      ...timelineWrites,
    ])
    else await db.batch([
      db.insert(worldSceneRevisions).values({ id, worldId: input.worldId, version, parentVersion: null, requestId: input.requestId, contentHash, documentJson: serialized, summary: input.summary, kind: input.kind, compatibilityJson: input.compatibilityJson ?? null, validationJson: proofJson, commitGuard: true, createdAt: now }),
      db.insert(worldScenes).values({ worldId: input.worldId, currentVersion: version, themeId, updatedAt: now }),
      ...(baselineStatement ? [baselineStatement] : []),
      ...(requestCompletionStatement ? [requestCompletionStatement] : []),
      guard,
      ...timelineWrites,
    ])
  } catch (error) { throw new SceneConflict(error instanceof Error ? error.message : undefined) }
  return { document, version, contentHash, createdAt: now }
}

export async function initialSceneStatements(db: Db, worldId: string, document: StoredSceneDocument, requestId: string, pendingBindings?: PendingSceneBindings, timelineId?: string, metadata?: { source?: 'generated' | 'fallback'; fallback?: boolean }): Promise<[BatchItem<'sqlite'>, BatchItem<'sqlite'>, BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]> {
  const now = new Date().toISOString()
  const doc = structuredClone(document)
  const themeId = storedSceneThemeId(doc)
  const contentHash = await hashText(JSON.stringify({ document: doc, version: 1 }))
  const facts: SceneWriteProofFacts = pendingBindings
    ? { policy: await resolveSceneWritePolicy(db), bindings: await buildPendingSceneBindings(pendingBindings), baseline: null, current: null }
    : await loadSceneWriteProofFacts(db, worldId)
  const proof = buildInitialWriteProof(facts, { candidate: { version: 1, contentHash } })
  const revisionId = crypto.randomUUID()
  const summary = metadata?.fallback ? '开始生活时的确定性保底场景' : '开始生活时的场景'
  const kind = metadata?.fallback ? 'initial-fallback' : 'initial'
  return [
    db.insert(worldSceneRevisions).values({ id: revisionId, worldId, version: 1, parentVersion: null, requestId, contentHash, documentJson: JSON.stringify(doc), summary, kind, compatibilityJson: metadata ? JSON.stringify({ source: metadata.source ?? 'generated', fallback: metadata.fallback ?? false }) : null, validationJson: JSON.stringify(proof), commitGuard: true, createdAt: now }),
    db.insert(worldScenes).values({ worldId, currentVersion: 1, themeId, updatedAt: now }),
    buildCommitGuardStatement(db, { revisionId, worldId, version: 1, requestId, baseline: proof.baseline, expectedBindings: facts.bindings }),
    ...await legacyMainSceneStatements(db, { worldId, timelineId, document: doc, version: 1, expectedVersion: 0,
      requestId, summary, kind, validationJson: JSON.stringify(proof), createdAt: now }),
  ]
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
  statements.push(buildCommitGuardStatement(db, {
    revisionId: currentRevisionId!, worldId: input.targetWorldId, version: current.version,
    requestId: currentRequestId!, baseline: null, expectedBindings: facts.bindings,
  }))
  return statements
}
