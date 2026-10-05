import { and, desc, eq, gt, inArray, isNull, lte, lt, or } from 'drizzle-orm'
import type { Db } from '../../db/client'
import {
  sceneCompatibilityDrafts,
  sceneCompatibilityRequests,
  worldSceneRevisions,
} from '../../db/schema'
import type {
  CompatibilityPurpose,
  ConfirmCompatibilityInput,
  CreateCompatibilityDraftInput,
  SceneCompatibilityDraft as ContractDraft,
  SceneCompatibilityDraftView,
  SceneCompatibilityFailure,
  SceneCompatibilityRequest as ContractRequest,
  SceneCompatibilityRequestView,
  SceneCommitResult,
  SceneRepairChange,
  SceneRepairChangePage,
  SceneRepairAudit,
  SceneTarget,
  SceneValidationBasis,
  SceneValidationReport,
  SceneValidationReportView,
  StoredSceneDocument,
} from '@possibility/voxel-contract'
import { isSerializedVoxelDocument, isSerializedVoxelSpaces } from '@possibility/voxel-contract'

export const COMPATIBILITY_LEASE_MS = 30_000
export const COMPATIBILITY_DRAFT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const COMPATIBILITY_CLEANUP_LIMIT = 10
export const COMPATIBILITY_MAX_ROW_BYTES = 1_900_000

export interface SceneCompatibilityRepositoryContext {
  db: Db
  actorKey: string
  now?: Date
}

export interface CreateSceneCompatibilityDraftRecord extends CreateCompatibilityDraftInput {
  actorKey: string
  basis: SceneValidationBasis
  inputFingerprint?: string
  now?: Date
}

export interface DraftBuildClaim {
  draft: ContractDraft
  claimed: boolean
  buildLeaseToken: string | null
  buildAttempt: number
}

export interface PublishDraftInput {
  worldId: string
  draftId: string
  actorKey: string
  buildLeaseToken: string
  buildAttempt: number
  status: 'ready' | 'blocked' | 'superseded'
  candidate?: StoredSceneDocument | null
  changes?: SceneRepairChange[]
  report?: SceneValidationReport | null
  basis?: SceneValidationBasis
  now?: Date
}

export interface RequestClaim {
  request: ContractRequest
  claimed: boolean
  leaseToken: string | null
  attempt: number
}

export interface ClaimSceneCompatibilityRequestInput extends ConfirmCompatibilityInput {
  actorKey: string
  requestFingerprint?: string
  now?: Date
}

export interface CompleteSceneCompatibilityRequestInput {
  worldId: string
  requestId: string
  actorKey: string
  attempt: number
  leaseToken: string
  resultVersion: number
  now?: Date
}

export interface FailSceneCompatibilityRequestInput {
  worldId: string
  requestId: string
  actorKey: string
  attempt: number
  leaseToken: string
  failureCode: ContractRequest['failureCode']
  now?: Date
}

export class SceneCompatibilityRepositoryError extends Error {
  readonly status = 409
  readonly code: SceneCompatibilityFailure['code']
  constructor(message: string, code: SceneCompatibilityFailure['code'] = 'request-mismatch') {
    super(message)
    this.name = 'SceneCompatibilityRepositoryError'
    this.code = code
  }
}

export class SceneCompatibilityRequestMismatch extends SceneCompatibilityRepositoryError {
  constructor(message = '兼容请求身份或依据不匹配') { super(message, 'request-mismatch') }
}

export class SceneCompatibilityLeaseLost extends SceneCompatibilityRepositoryError {
  constructor(message = '兼容请求执行权已失效') { super(message, 'result-unknown') }
}

export class SceneCompatibilityRepositoryCorruption extends Error {
  readonly status = 503
  readonly code = 'storage-failure'
  constructor(message: string) {
    super(message)
    this.name = 'SceneCompatibilityRepositoryCorruption'
  }
}

type DraftRow = typeof sceneCompatibilityDrafts.$inferSelect
type RequestRow = typeof sceneCompatibilityRequests.$inferSelect

type DraftStatus = DraftRow['status']
type RequestState = RequestRow['state']

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString()
}

function leaseUntil(now: string): string {
  return new Date(new Date(now).getTime() + COMPATIBILITY_LEASE_MS).toISOString()
}

function json<T>(value: T, label: string): string {
  try { return JSON.stringify(value) } catch { throw new SceneCompatibilityRepositoryError(`${label}无法序列化`) }
}

function parse<T>(value: string | null, label: string, fallback?: T): T {
  if (value === null) {
    if (fallback !== undefined) return fallback
    throw new SceneCompatibilityRepositoryCorruption(`${label}缺失`)
  }
  try { return JSON.parse(value) as T }
  catch { throw new SceneCompatibilityRepositoryCorruption(`${label}损坏`) }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableValue(value)))
  return `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function assertRowSize(values: Record<string, unknown>): void {
  const bytes = new TextEncoder().encode(json(values, '兼容记录')).byteLength
  if (bytes > COMPATIBILITY_MAX_ROW_BYTES) throw new SceneCompatibilityRepositoryError('兼容记录超过存储大小限制')
}

function sceneDocument(value: unknown, label: string): StoredSceneDocument {
  if (!isSerializedVoxelDocument(value) && !isSerializedVoxelSpaces(value)) {
    throw new SceneCompatibilityRepositoryCorruption(`${label}不是有效体素场景`)
  }
  return value as StoredSceneDocument
}

function draftFromRow(row: DraftRow): ContractDraft {
  return {
    id: row.id,
    draftRequestId: row.draftRequestId,
    actorKey: row.actorKey,
    worldId: row.worldId,
    purpose: row.purpose as CompatibilityPurpose,
    target: parse<SceneTarget>(row.targetJson, '草稿目标'),
    basis: parse<SceneValidationBasis>(row.basisJson, '草稿依据'),
    status: row.status as ContractDraft['status'],
    candidate: row.candidateJson === null ? null : sceneDocument(parse<unknown>(row.candidateJson, '草稿候选'), '草稿候选'),
    changes: parse<SceneRepairChange[]>(row.changesJson, '草稿变化', []),
    report: row.reportJson === null ? null : parse<SceneValidationReport>(row.reportJson, '草稿报告'),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function requestFromRow(row: RequestRow): ContractRequest {
  return {
    worldId: row.worldId,
    requestId: row.requestId,
    actorKey: row.actorKey,
    draftId: row.draftId,
    requestFingerprint: row.requestFingerprint,
    attempt: row.attempt,
    state: row.state as ContractRequest['state'],
    leaseToken: row.leaseToken,
    leaseUntil: row.leaseUntil,
    resultVersion: row.resultVersion,
    failureCode: row.failureCode as ContractRequest['failureCode'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function page<T>(items: T[], total: number, limit = 20): { items: T[]; offset: number; limit: number; total: number; countIsExact?: boolean; hasMore: boolean } {
  const bounded = Math.max(1, Math.min(50, limit))
  return { items: items.slice(0, bounded), offset: 0, limit: bounded, total, hasMore: total > bounded }
}

function issuePage(items: SceneValidationReport['issues'], total: number) {
  return { ...page(items, total), countIsExact: true }
}

function reportView(report: SceneValidationReport | null): SceneValidationReportView | null {
  if (!report) return null
  return { ...report, issues: issuePage(report.issues, report.issueCount) }
}

function changesView(changes: SceneRepairChange[]): SceneRepairChangePage {
  return page(changes, changes.length)
}

function previewSpaces(candidate: StoredSceneDocument | null): { spaceId: string; name: string }[] {
  if (!candidate) return []
  if (isSerializedVoxelDocument(candidate)) return [{ spaceId: 'single', name: candidate.id || '场景' }]
  return candidate.spaces.map(space => ({ spaceId: space.id, name: space.name }))
}

/** Deliberately omits candidate, actor identity and all execution lease fields. */
export function toSceneCompatibilityDraftView(draft: ContractDraft, canConfirm = draft.status === 'ready'): SceneCompatibilityDraftView {
  return {
    id: draft.id,
    worldId: draft.worldId,
    purpose: draft.purpose,
    target: clone(draft.target),
    basis: clone(draft.basis),
    status: draft.status,
    previewSpaces: previewSpaces(draft.candidate),
    canConfirm: canConfirm && draft.status === 'ready' && draft.candidate !== null && draft.report?.status === 'valid',
    changes: changesView(draft.changes),
    report: reportView(draft.report),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  }
}

export function toSceneCompatibilityRequestView(request: ContractRequest): SceneCompatibilityRequestView {
  if (request.state === 'completed') {
    throw new SceneCompatibilityRepositoryCorruption('完成请求必须从场景修订重建结果')
  }
  if (request.state === 'submitting') return { status: 'submitting', attempt: request.attempt, retryAllowed: false }
  if (!request.failureCode) return { status: 'not-committed', attempt: request.attempt, nextAttempt: request.attempt + 1, retryAllowed: true }
  return {
    status: 'not-committed', attempt: request.attempt, retryAllowed: false,
    error: failureForCode(request.failureCode),
  }
}

function failureForCode(code: NonNullable<ContractRequest['failureCode']>): SceneCompatibilityFailure {
  const retryable = code === 'service-busy' || code === 'storage-failure'
  const message = code === 'scene-changed'
    ? '场景已更新，请重新检查并预览'
    : code === 'basis-changed'
      ? '校验依据已变化，请重新检查并预览'
      : '兼容请求未能保存场景'
  return {
    code,
    message,
    action: retryable ? 'query-result' : 'recheck',
  }
}

async function readDraftRow(db: Db, worldId: string, draftId: string, actorKey?: string): Promise<DraftRow | null> {
  const predicates = [eq(sceneCompatibilityDrafts.worldId, worldId), eq(sceneCompatibilityDrafts.id, draftId)]
  if (actorKey !== undefined) predicates.push(eq(sceneCompatibilityDrafts.actorKey, actorKey))
  return await db.select().from(sceneCompatibilityDrafts).where(and(...predicates)).get() ?? null
}

async function readScopedDraft(db: Db, worldId: string, actorKey: string, draftRequestId: string): Promise<DraftRow | null> {
  return await db.select().from(sceneCompatibilityDrafts).where(and(
    eq(sceneCompatibilityDrafts.worldId, worldId),
    eq(sceneCompatibilityDrafts.actorKey, actorKey),
    eq(sceneCompatibilityDrafts.draftRequestId, draftRequestId),
  )).get() ?? null
}

export function fingerprintSceneCompatibilityDraft(input: CreateSceneCompatibilityDraftRecord): Promise<string> {
  return fingerprint({
    actorKey: input.actorKey,
    worldId: input.worldId,
    draftRequestId: input.draftRequestId,
    purpose: input.purpose,
    target: input.target,
    expectedCurrentVersion: input.expectedCurrentVersion,
    basis: input.basis,
  })
}

/** Creates the durable draft row. Building execution is claimed separately and atomically. */
export async function createSceneCompatibilityDraft(
  dbOrContext: Db | SceneCompatibilityRepositoryContext,
  input: CreateSceneCompatibilityDraftRecord,
): Promise<ContractDraft> {
  const db = 'db' in dbOrContext ? dbOrContext.db : dbOrContext
  const actorKey = input.actorKey
  if (!actorKey || !input.draftRequestId || !input.worldId) throw new SceneCompatibilityRepositoryError('草稿身份不完整')
  if (input.purpose === 'repair-current' && input.target.kind !== 'current') throw new SceneCompatibilityRepositoryError('当前场景修复目标无效')
  if (input.purpose === 'restore-history' && input.target.kind !== 'history') throw new SceneCompatibilityRepositoryError('历史恢复目标无效')
  const existing = await readScopedDraft(db, input.worldId, actorKey, input.draftRequestId)
  const inputFingerprint = input.inputFingerprint ?? await fingerprintSceneCompatibilityDraft(input)
  if (existing) {
    if (existing.inputFingerprint !== inputFingerprint) throw new SceneCompatibilityRequestMismatch('同一草稿 ID 携带了不同依据')
    return draftFromRow(existing)
  }
  const now = nowIso(input.now)
  const values: typeof sceneCompatibilityDrafts.$inferInsert = {
    id: crypto.randomUUID(), draftRequestId: input.draftRequestId, actorKey, worldId: input.worldId,
    purpose: input.purpose, targetJson: json(input.target, '草稿目标'), basisJson: json(input.basis, '草稿依据'),
    status: 'building', candidateJson: null, changesJson: '[]', reportJson: null,
    inputFingerprint, buildLeaseToken: null, buildLeaseUntil: null, buildAttempt: 0,
    createdAt: now, updatedAt: now,
  }
  assertRowSize(values)
  try {
    await db.insert(sceneCompatibilityDrafts).values(values)
  } catch (error) {
    const raced = await readScopedDraft(db, input.worldId, actorKey, input.draftRequestId)
    if (!raced) throw error
    if (raced.inputFingerprint !== inputFingerprint) throw new SceneCompatibilityRequestMismatch('同一草稿 ID 携带了不同依据')
    return draftFromRow(raced)
  }
  return draftFromRow(values as DraftRow)
}

export async function readSceneCompatibilityDraft(db: Db, worldId: string, draftId: string, actorKey?: string): Promise<ContractDraft | null> {
  const row = await readDraftRow(db, worldId, draftId, actorKey)
  return row ? draftFromRow(row) : null
}

/** Claims construction with a fixed database-time lease and monotonically fenced attempt. */
export async function claimSceneCompatibilityDraftBuild(
  db: Db,
  input: { worldId: string; draftId: string; actorKey: string; inputFingerprint: string; now?: Date },
): Promise<DraftBuildClaim> {
  const row = await readDraftRow(db, input.worldId, input.draftId, input.actorKey)
  if (!row) throw new SceneCompatibilityRepositoryError('草稿不存在', 'draft-unavailable')
  if (row.inputFingerprint !== input.inputFingerprint) throw new SceneCompatibilityRequestMismatch('草稿依据已变化')
  const now = nowIso(input.now)
  if (row.status !== 'building') return { draft: draftFromRow(row), claimed: false, buildLeaseToken: null, buildAttempt: row.buildAttempt }
  if (row.buildLeaseUntil && row.buildLeaseUntil > now) return { draft: draftFromRow(row), claimed: false, buildLeaseToken: null, buildAttempt: row.buildAttempt }
  const token = crypto.randomUUID()
  const claimedRows = await db.update(sceneCompatibilityDrafts).set({
    buildLeaseToken: token, buildLeaseUntil: leaseUntil(now), buildAttempt: row.buildAttempt + 1, updatedAt: now,
  }).where(and(
    eq(sceneCompatibilityDrafts.id, row.id), eq(sceneCompatibilityDrafts.worldId, row.worldId),
    eq(sceneCompatibilityDrafts.actorKey, row.actorKey), eq(sceneCompatibilityDrafts.inputFingerprint, input.inputFingerprint),
    eq(sceneCompatibilityDrafts.status, 'building'), or(isNull(sceneCompatibilityDrafts.buildLeaseUntil), lte(sceneCompatibilityDrafts.buildLeaseUntil, now)),
  )).returning().all()
  if (claimedRows.length !== 1) {
    const current = await readDraftRow(db, input.worldId, input.draftId, input.actorKey)
    if (!current) throw new SceneCompatibilityRepositoryError('草稿在取得执行权时消失', 'draft-unavailable')
    return { draft: draftFromRow(current), claimed: false, buildLeaseToken: null, buildAttempt: current.buildAttempt }
  }
  const claimed = claimedRows[0]
  return { draft: draftFromRow(claimed), claimed: true, buildLeaseToken: token, buildAttempt: claimed.buildAttempt }
}

export async function publishSceneCompatibilityDraft(db: Db, input: PublishDraftInput): Promise<ContractDraft> {
  if (input.status === 'ready' && (!input.candidate || input.report?.status !== 'valid')) {
    throw new SceneCompatibilityRepositoryError('只有完整有效候选才能发布为 ready', 'draft-blocked')
  }
  const now = nowIso(input.now)
  const candidateJson = input.candidate === undefined || input.candidate === null ? null : json(input.candidate, '草稿候选')
  const changesJson = json(input.changes ?? [], '草稿变化')
  const reportJson = input.report === undefined || input.report === null ? null : json(input.report, '草稿报告')
  const basisJson = input.basis === undefined ? undefined : json(input.basis, '草稿依据')
  assertRowSize({ candidateJson, changesJson, reportJson, basisJson })
  const setValues = {
    status: input.status, candidateJson, changesJson, reportJson,
    ...(basisJson === undefined ? {} : { basisJson }),
    buildLeaseToken: null, buildLeaseUntil: null, updatedAt: now,
  }
  const rows = await db.update(sceneCompatibilityDrafts).set(setValues).where(and(
    eq(sceneCompatibilityDrafts.worldId, input.worldId), eq(sceneCompatibilityDrafts.id, input.draftId),
    eq(sceneCompatibilityDrafts.actorKey, input.actorKey), eq(sceneCompatibilityDrafts.status, 'building'),
    eq(sceneCompatibilityDrafts.buildAttempt, input.buildAttempt), eq(sceneCompatibilityDrafts.buildLeaseToken, input.buildLeaseToken),
    // A builder may publish only while its fixed lease is still valid.
    gt(sceneCompatibilityDrafts.buildLeaseUntil, now),
  )).returning().all()
  if (rows.length !== 1) throw new SceneCompatibilityLeaseLost('草稿构建执行权已失效，不能发布结果')
  return draftFromRow(rows[0])
}

/** Atomically cancels only a draft which has not entered submission. */
export async function cancelSceneCompatibilityDraft(db: Db, worldId: string, draftId: string, actorKey: string, now = new Date()): Promise<ContractDraft | null> {
  const nowText = nowIso(now)
  await db.update(sceneCompatibilityDrafts).set({ status: 'cancelled', buildLeaseToken: null, buildLeaseUntil: null, updatedAt: nowText }).where(and(
    eq(sceneCompatibilityDrafts.worldId, worldId), eq(sceneCompatibilityDrafts.id, draftId), eq(sceneCompatibilityDrafts.actorKey, actorKey),
    or(eq(sceneCompatibilityDrafts.status, 'building'), eq(sceneCompatibilityDrafts.status, 'ready'), eq(sceneCompatibilityDrafts.status, 'blocked')),
  ))
  return readSceneCompatibilityDraft(db, worldId, draftId, actorKey)
}

async function readRequestRow(db: Db, worldId: string, requestId: string, actorKey?: string): Promise<RequestRow | null> {
  const predicates = [eq(sceneCompatibilityRequests.worldId, worldId), eq(sceneCompatibilityRequests.requestId, requestId)]
  if (actorKey !== undefined) predicates.push(eq(sceneCompatibilityRequests.actorKey, actorKey))
  return await db.select().from(sceneCompatibilityRequests).where(and(...predicates)).get() ?? null
}

async function requestFingerprintFor(db: Db, input: ClaimSceneCompatibilityRequestInput, draft: DraftRow): Promise<string> {
  return input.requestFingerprint ?? fingerprint({
    actorKey: input.actorKey, worldId: input.worldId, requestId: input.requestId, draftId: draft.id,
    expectedCurrentVersion: input.expectedCurrentVersion, target: parse<SceneTarget>(draft.targetJson, '草稿目标'),
    basis: parse<SceneValidationBasis>(draft.basisJson, '草稿依据'), candidate: draft.candidateJson ? parse<unknown>(draft.candidateJson, '草稿候选') : null,
  })
}

/** Claims the initial attempt (0) or an explicitly server-issued next attempt. */
export async function claimSceneCompatibilityRequest(db: Db, input: ClaimSceneCompatibilityRequestInput): Promise<RequestClaim> {
  const draft = await readDraftRow(db, input.worldId, input.draftId, input.actorKey)
  if (!draft) throw new SceneCompatibilityRepositoryError('草稿不存在', 'draft-unavailable')
  if (draft.status !== 'ready' || !draft.candidateJson) throw new SceneCompatibilityRepositoryError('草稿尚未准备好确认', 'draft-blocked')
  const requestFingerprint = await requestFingerprintFor(db, input, draft)
  const now = nowIso(input.now)
  const existing = await readRequestRow(db, input.worldId, input.requestId)
  if (existing) {
    if (existing.actorKey !== input.actorKey || existing.draftId !== input.draftId || existing.requestFingerprint !== requestFingerprint) throw new SceneCompatibilityRequestMismatch()
    if (existing.state === 'completed') return { request: requestFromRow(existing), claimed: false, leaseToken: null, attempt: existing.attempt }
    if (existing.state === 'submitting' && existing.leaseUntil && existing.leaseUntil > now) return { request: requestFromRow(existing), claimed: false, leaseToken: null, attempt: existing.attempt }
    if (existing.state === 'submitting') throw new SceneCompatibilityLeaseLost('请求租约已过期，请先恢复请求')
    if (input.expectedAttempt !== existing.attempt + 1) throw new SceneCompatibilityRequestMismatch('重试 attempt 不是服务端授予的下一次 attempt')
  } else if (input.expectedAttempt !== 0) {
    throw new SceneCompatibilityRequestMismatch('首次请求 attempt 必须为 0')
  }
  const token = crypto.randomUUID()
  if (!existing) {
    const values: typeof sceneCompatibilityRequests.$inferInsert = {
      worldId: input.worldId, requestId: input.requestId, actorKey: input.actorKey, draftId: input.draftId,
      requestFingerprint, attempt: 0, state: 'submitting', leaseToken: token, leaseUntil: leaseUntil(now),
      resultVersion: null, failureCode: null, createdAt: now, updatedAt: now,
    }
    try {
      assertRowSize(values)
      await db.insert(sceneCompatibilityRequests).values(values)
      return { request: requestFromRow(values as RequestRow), claimed: true, leaseToken: token, attempt: 0 }
    } catch (error) {
      const raced = await readRequestRow(db, input.worldId, input.requestId)
      if (!raced) throw error
      if (raced.actorKey !== input.actorKey || raced.requestFingerprint !== requestFingerprint) throw new SceneCompatibilityRequestMismatch()
      return { request: requestFromRow(raced), claimed: false, leaseToken: null, attempt: raced.attempt }
    }
  }
  const rows = await db.update(sceneCompatibilityRequests).set({
    attempt: input.expectedAttempt, state: 'submitting', leaseToken: token, leaseUntil: leaseUntil(now), failureCode: null, updatedAt: now,
  }).where(and(
    eq(sceneCompatibilityRequests.worldId, input.worldId), eq(sceneCompatibilityRequests.requestId, input.requestId),
    eq(sceneCompatibilityRequests.actorKey, input.actorKey), eq(sceneCompatibilityRequests.requestFingerprint, requestFingerprint),
    eq(sceneCompatibilityRequests.attempt, existing.attempt), eq(sceneCompatibilityRequests.state, 'not-committed'),
  )).returning().all()
  if (rows.length !== 1) throw new SceneCompatibilityLeaseLost('请求重试执行权已被其他执行者取得')
  return { request: requestFromRow(rows[0]), claimed: true, leaseToken: token, attempt: input.expectedAttempt }
}

export async function completeSceneCompatibilityRequest(db: Db, input: CompleteSceneCompatibilityRequestInput): Promise<ContractRequest> {
  const rows = await db.update(sceneCompatibilityRequests).set({ state: 'completed', resultVersion: input.resultVersion, leaseToken: null, leaseUntil: null, updatedAt: nowIso(input.now) }).where(and(
    eq(sceneCompatibilityRequests.worldId, input.worldId), eq(sceneCompatibilityRequests.requestId, input.requestId), eq(sceneCompatibilityRequests.actorKey, input.actorKey),
    eq(sceneCompatibilityRequests.attempt, input.attempt), eq(sceneCompatibilityRequests.leaseToken, input.leaseToken), eq(sceneCompatibilityRequests.state, 'submitting'),
  )).returning().all()
  if (rows.length !== 1) throw new SceneCompatibilityLeaseLost()
  return requestFromRow(rows[0])
}

export async function failSceneCompatibilityRequest(db: Db, input: FailSceneCompatibilityRequestInput): Promise<ContractRequest> {
  const rows = await db.update(sceneCompatibilityRequests).set({ state: 'not-committed', resultVersion: null, leaseToken: null, leaseUntil: null, failureCode: input.failureCode, updatedAt: nowIso(input.now) }).where(and(
    eq(sceneCompatibilityRequests.worldId, input.worldId), eq(sceneCompatibilityRequests.requestId, input.requestId), eq(sceneCompatibilityRequests.actorKey, input.actorKey),
    eq(sceneCompatibilityRequests.attempt, input.attempt), eq(sceneCompatibilityRequests.leaseToken, input.leaseToken), eq(sceneCompatibilityRequests.state, 'submitting'),
  )).returning().all()
  if (rows.length !== 1) throw new SceneCompatibilityLeaseLost()
  return requestFromRow(rows[0])
}

async function readRevisionResult(db: Db, worldId: string, requestId: string): Promise<SceneCommitResult | null> {
  const row = await db.select().from(worldSceneRevisions).where(and(eq(worldSceneRevisions.worldId, worldId), eq(worldSceneRevisions.requestId, requestId))).get()
  if (!row) return null
  const audit = parse<SceneRepairAudit | null>(row.compatibilityJson, '兼容审计', null)
  if (!audit || audit.requestId !== requestId || audit.source.worldId !== worldId) return null
  return {
    worldId, version: row.version, contentHash: row.contentHash, requestId,
    document: sceneDocument(parse<unknown>(row.documentJson, '场景修订'), '场景修订'),
    outcome: audit.purpose === 'repair-current' ? 'repaired-current' : 'restored-history',
    audit,
  }
}

/** Rebuilds a successful result from immutable scene history; it does not trust draft retention. */
export async function readSceneCompatibilityRequest(db: Db, worldId: string, requestId: string, actorKey?: string): Promise<SceneCompatibilityRequestView> {
  const row = await readRequestRow(db, worldId, requestId, actorKey)
  const revisionResult = await readRevisionResult(db, worldId, requestId)
  if (!row) return revisionResult ? { status: 'completed', attempt: 0, result: revisionResult } : { status: 'missing', retryAllowed: false }
  if (row.state === 'completed') {
    if (!revisionResult) return { status: 'unknown', retryAllowed: false }
    return { status: 'completed', attempt: row.attempt, result: revisionResult }
  }
  return toSceneCompatibilityRequestView(requestFromRow(row))
}

/** Fences an expired lease, then checks for a durable revision. It never submits a new revision. */
export async function recoverSceneCompatibilityRequest(db: Db, input: ClaimSceneCompatibilityRequestInput): Promise<SceneCompatibilityRequestView> {
  const now = nowIso(input.now)
  const before = await readRequestRow(db, input.worldId, input.requestId, input.actorKey)
  const revisionBefore = await readRevisionResult(db, input.worldId, input.requestId)
  if (!before) {
    if (revisionBefore) return { status: 'completed', attempt: 0, result: revisionBefore }
    const draft = await readDraftRow(db, input.worldId, input.draftId, input.actorKey)
    if (!draft) return { status: 'unknown', retryAllowed: false }
    const requestFingerprint = await requestFingerprintFor(db, input, draft)
    if (input.expectedAttempt !== 0) return { status: 'unknown', retryAllowed: false }
    try {
      await db.insert(sceneCompatibilityRequests).values({
        worldId: input.worldId, requestId: input.requestId, actorKey: input.actorKey, draftId: input.draftId,
        requestFingerprint, attempt: 0, state: 'not-committed', leaseToken: null, leaseUntil: null,
        resultVersion: null, failureCode: null, createdAt: now, updatedAt: now,
      })
    } catch {
      return recoverSceneCompatibilityRequest(db, { ...input, expectedAttempt: 0 })
    }
    return { status: 'not-committed', attempt: 0, nextAttempt: 1, retryAllowed: true }
  }
  if (before.actorKey !== input.actorKey || before.draftId !== input.draftId) throw new SceneCompatibilityRequestMismatch()
  if (revisionBefore) return { status: 'completed', attempt: before.attempt, result: revisionBefore }
  if (before.state !== 'submitting') return toSceneCompatibilityRequestView(requestFromRow(before))
  if (!before.leaseUntil || before.leaseUntil > now) return { status: 'submitting', attempt: before.attempt, retryAllowed: false }
  const fenced = await db.update(sceneCompatibilityRequests).set({ state: 'not-committed', leaseToken: null, leaseUntil: null, updatedAt: now }).where(and(
    eq(sceneCompatibilityRequests.worldId, input.worldId), eq(sceneCompatibilityRequests.requestId, input.requestId),
    eq(sceneCompatibilityRequests.actorKey, input.actorKey), eq(sceneCompatibilityRequests.attempt, before.attempt),
    eq(sceneCompatibilityRequests.state, 'submitting'),
    before.leaseToken === null ? isNull(sceneCompatibilityRequests.leaseToken) : eq(sceneCompatibilityRequests.leaseToken, before.leaseToken),
    lte(sceneCompatibilityRequests.leaseUntil, now),
  )).returning().all()
  if (fenced.length !== 1) return { status: 'unknown', retryAllowed: false }
  const afterRevision = await readRevisionResult(db, input.worldId, input.requestId)
  if (afterRevision) return { status: 'completed', attempt: before.attempt, result: afterRevision }
  return { status: 'not-committed', attempt: before.attempt, nextAttempt: before.attempt + 1, retryAllowed: true }
}

/** Clears only expired, unsubmitted drafts in one world, bounded to ten rows. */
export async function cleanupExpiredSceneCompatibilityDrafts(db: Db, worldId: string, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - COMPATIBILITY_DRAFT_RETENTION_MS).toISOString()
  const rows = await db.select({ id: sceneCompatibilityDrafts.id }).from(sceneCompatibilityDrafts).where(and(
    eq(sceneCompatibilityDrafts.worldId, worldId), lt(sceneCompatibilityDrafts.updatedAt, cutoff),
    inArray(sceneCompatibilityDrafts.status, ['building', 'ready', 'blocked', 'cancelled', 'superseded']),
  )).orderBy(desc(sceneCompatibilityDrafts.updatedAt)).limit(COMPATIBILITY_CLEANUP_LIMIT).all()
  if (!rows.length) return 0
  const requests = await db.select({ draftId: sceneCompatibilityRequests.draftId }).from(sceneCompatibilityRequests).where(and(
    eq(sceneCompatibilityRequests.worldId, worldId), inArray(sceneCompatibilityRequests.draftId, rows.map(row => row.id)),
  )).all()
  const submitted = new Set(requests.map(row => row.draftId))
  const deletable = rows.map(row => row.id).filter(id => !submitted.has(id))
  if (!deletable.length) return 0
  const deleted = await db.delete(sceneCompatibilityDrafts).where(and(eq(sceneCompatibilityDrafts.worldId, worldId), inArray(sceneCompatibilityDrafts.id, deletable))).returning({ id: sceneCompatibilityDrafts.id }).all()
  return deleted.length
}

// Compatibility aliases used by service/storage callers that name the operation rather than the table.
export const claimDraftBuild = claimSceneCompatibilityDraftBuild
export const publishDraft = publishSceneCompatibilityDraft
export const claimCompatibilityRequest = claimSceneCompatibilityRequest
export const completeCompatibilityRequest = completeSceneCompatibilityRequest
export const failCompatibilityRequest = failSceneCompatibilityRequest
export const recoverCompatibilityRequest = recoverSceneCompatibilityRequest
export const cleanupExpiredDrafts = cleanupExpiredSceneCompatibilityDrafts