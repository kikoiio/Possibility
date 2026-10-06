import {
  decodeSceneCompatibility,
  materializeSceneCandidate,
  repairSceneCompatibility,
  sceneBudget,
  validateSceneEnvelope,
  type SceneCandidate,
  type SceneCompatibilityDraft,
  type SceneCompatibilityFailure,
  type SceneCompatibilityRequestView,
  type SceneCompatibilityReport,
  type SceneCommitResult,
  type SceneEditPreflightResult,
  type SceneInspectionResult,
  type SceneIssue,
  type SceneRepairAudit,
  type SceneSourceRef,
  type SceneTarget,
  type SceneValidationBasis,
  type SceneValidationContext,
  type SceneWorkBudget,
  type SceneWorkControl,
} from '@possibility/voxel-contract'
import type { Db } from '../../db/client'
import { and, eq } from 'drizzle-orm'
import { demoBaselines, sceneCompatibilityRequests } from '../../db/schema'
import {
  cancelSceneCompatibilityDraft,
  claimSceneCompatibilityDraftBuild,
  claimSceneCompatibilityRequest,
  cleanupExpiredSceneCompatibilityDrafts,
  completeSceneCompatibilityRequest,
  createSceneCompatibilityDraft,
  failSceneCompatibilityRequest,
  fingerprintSceneCompatibilityDraft,
  publishSceneCompatibilityDraft,
  readSceneCompatibilityDraft,
  readSceneCompatibilityDraftByRequestId,
  readSceneCompatibilityRequest,
  blockExpiredSceneCompatibilityDraft,
  recoverSceneCompatibilityRequest,
  SceneCompatibilityLeaseLost,
  type CreateSceneCompatibilityDraftRecord,
} from './repository'
import { commitScene, readCurrentScene, readSceneVersion } from '../repository'
import { loadSceneValidationContext, type SceneValidationAccess } from './context'
import { stableJson } from './stable-json'
import type { SceneWriteAuthority } from './write-proof'

export interface SceneInspectionInput {
  worldId: string
  target?: SceneTarget
  access: SceneValidationAccess
  budget?: Partial<SceneWorkBudget>
  control?: Partial<SceneWorkControl>
}

export interface ScenePreflightInput extends SceneInspectionInput { candidate: SceneCandidate }
export interface CompatibilityActor { actorKey: string; userId?: string }

export interface CreateDraftInput extends CompatibilityActor {
  worldId: string
  draftRequestId: string
  purpose: 'repair-current' | 'restore-history'
  target: SceneTarget
  expectedCurrentVersion: number
  access: SceneValidationAccess
  budget?: Partial<SceneWorkBudget>
  control?: Partial<SceneWorkControl>
}

export interface ConfirmInput extends CompatibilityActor {
  worldId: string
  draftId: string
  requestId: string
  expectedCurrentVersion: number
  expectedAttempt: number
  access: SceneValidationAccess
  /** Server-derived identity checked again by the atomic final commit guard. */
  authority?: SceneWriteAuthority
  allowBaseline?: boolean
  /** Server-derived active demo baseline to advance in the same scene commit batch. */
  baselineUpdate?: { baselineId: string }
  targetSummary?: string
  budget?: Partial<SceneWorkBudget>
  control?: Partial<SceneWorkControl>
}

export interface RequestInput extends CompatibilityActor { worldId: string; requestId: string }
export interface RecoverInput extends ConfirmInput {}

function controlWithDefaults(control: Partial<SceneWorkControl> | undefined): SceneWorkControl {
  return {
    signal: control?.signal ?? new AbortController().signal,
    nowMs: control?.nowMs ?? (() => Date.now()),
    yieldControl: control?.yieldControl ?? (async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) }),
    ...control,
  }
}

function sourceFor(worldId: string, stored: { version: number; contentHash: string }): SceneSourceRef {
  return { worldId, version: stored.version, contentHash: stored.contentHash }
}

function failure(status: 'missing' | 'corrupt' | 'unsupported', message: string): SceneInspectionResult {
  const code = status === 'missing' ? 'scene-missing' : status === 'unsupported' ? 'format-unsupported' : 'scene-corrupt'
  return { status, error: { code, message, action: 'recheck' } }
}

function storedSceneCorruption(error: unknown): boolean {
  return error instanceof Error && /场景版本索引损坏|场景文档损坏|场景历史文档损坏/.test(error.message)
}

async function readBaselineBasis(db: Db, worldId: string): Promise<SceneValidationBasis['baseline']> {
  const row = await db.select().from(demoBaselines).where(eq(demoBaselines.worldId, worldId)).get()
  if (!row) return null
  return { id: row.id, status: row.status, sceneVersion: row.sceneVersion, contentHash: row.contentHash }
}

async function validateRetryBasis(
  db: Db,
  input: RequestInput & { access: SceneValidationAccess; expectedCurrentVersion?: number },
  view: SceneCompatibilityRequestView,
): Promise<SceneCompatibilityRequestView> {
  if (view.status !== 'not-committed' || !view.retryAllowed) return view
  const deny = (code: SceneCompatibilityFailure['code'], message: string): SceneCompatibilityRequestView => ({
    status: 'not-committed', attempt: view.attempt, retryAllowed: false,
    error: requestFailure(code, message),
  })
  try {
    const request = await db.select().from(sceneCompatibilityRequests).where(and(
      eq(sceneCompatibilityRequests.worldId, input.worldId),
      eq(sceneCompatibilityRequests.requestId, input.requestId),
      eq(sceneCompatibilityRequests.actorKey, input.actorKey),
    )).get()
    if (!request) return { status: 'unknown', retryAllowed: false }
    const draft = await readSceneCompatibilityDraft(db, input.worldId, request.draftId, input.actorKey)
    if (!draft || draft.status !== 'ready' || !draft.candidate) {
      return deny('draft-unavailable', '原修复草稿已失效，请重新检查并预览。')
    }
    const current = await readCurrentScene(db, input.worldId)
    if (!current || current.version !== draft.basis.expectedCurrentVersion
      || (input.expectedCurrentVersion !== undefined && current.version !== input.expectedCurrentVersion)
      || current.contentHash !== draft.basis.currentContentHash) {
      return deny('scene-changed', '场景已更新，请重新检查并预览。')
    }
    const context = await loadSceneValidationContext(db, input.worldId, draft.basis.source, input.access)
    if (context.contextFingerprint !== draft.basis.contextFingerprint
      || context.bindingHash !== draft.basis.bindingHash
      || context.rulesVersion !== draft.basis.rulesVersion
      || context.assetManifestHash !== draft.basis.assetManifestHash
      || context.templateCatalogHash !== draft.basis.templateCatalogHash
      || !sameBaseline(await readBaselineBasis(db, input.worldId), draft.basis.baseline)) {
      return deny('basis-changed', '场景规则、绑定或基线依据已变化，请重新检查并预览。')
    }
    return view
  } catch {
    return { status: 'unknown', retryAllowed: false }
  }
}

function sameBaseline(a: SceneValidationBasis['baseline'], b: SceneValidationBasis['baseline']): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function basisFor(source: SceneSourceRef, currentVersion: number, context: SceneValidationContext, candidateHash: string | null, currentContentHash = source.contentHash, baseline: SceneValidationBasis['baseline'] = null): SceneValidationBasis {
  return {
    expectedCurrentVersion: currentVersion,
    currentContentHash,
    source,
    candidateHash,
    rulesVersion: context.rulesVersion,
    assetManifestHash: context.assetManifestHash,
    templateCatalogHash: context.templateCatalogHash,
    bindingHash: context.bindingHash,
    contextFingerprint: context.contextFingerprint,
    baseline,
  }
}

async function readTarget(db: Db, worldId: string, target: SceneTarget) {
  return target.kind === 'history' ? readSceneVersion(db, worldId, target.version) : readCurrentScene(db, worldId)
}

async function candidateHash(candidate: SceneCandidate): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(candidate)))
  return `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function emptyReport(reason: 'context-unavailable' | 'deadline'): SceneCompatibilityReport {
  return {
    status: 'incomplete', issues: [], issueCount: 0, countIsExact: false, stopReason: reason,
    checkedSpaceIds: [], pendingSpaceIds: [], workUnitsUsed: 0, elapsedMs: 0,
    ruleNotes: { items: [], total: 0, hasMore: false },
  }
}

async function inspectSceneCompatibilityInner(
  db: Db,
  input: SceneInspectionInput,
  checkDeadline?: () => void,
  operationDeadline?: ReturnType<typeof draftDeadline>,
): Promise<SceneInspectionResult> {
  const target = input.target ?? { kind: 'current' as const }
  let stored
  try {
    checkDeadline?.()
    stored = await readTarget(db, input.worldId, target)
    checkDeadline?.()
  } catch (error) {
    if (storedSceneCorruption(error)) return failure('corrupt', error instanceof Error ? error.message : '场景损坏')
    throw error
  }
  if (!stored) return failure('missing', '请求的场景版本不存在')
  const decoded = decodeSceneCompatibility(stored.document)
  if (decoded.status !== 'ready') {
    return failure(decoded.status, decoded.issues[0]?.summary ?? '场景无法解码')
  }
  const source = sourceFor(input.worldId, stored)
  let current
  try {
    checkDeadline?.()
    current = await readCurrentScene(db, input.worldId)
    checkDeadline?.()
  } catch (error) {
    if (storedSceneCorruption(error)) return failure('corrupt', error instanceof Error ? error.message : '场景损坏')
    throw error
  }
  if (!current) return failure('corrupt', '当前场景版本索引不存在')
  checkDeadline?.()
  const context = await loadSceneValidationContext(db, input.worldId, source, input.access)
  checkDeadline?.()
  const budget = sceneBudget(input.budget)
  const validationControl = operationDeadline
    ? operationWorkControl(operationDeadline, input.budget)
    : controlWithDefaults(input.control)
  const report = await validateSceneEnvelope(decoded.envelope, context, budget, validationControl, 'existing')
  checkDeadline?.()
  const baseline = await readBaselineBasis(db, input.worldId)
  checkDeadline?.()
  return { status: 'ready', source, basis: basisFor(source, current.version, context, null, current.contentHash, baseline), report, canCreateRepairDraft: report.status === 'invalid' }
}

export async function preflightSceneEdit(db: Db, input: ScenePreflightInput): Promise<SceneEditPreflightResult> {
  const current = await readCurrentScene(db, input.worldId)
  if (!current) return { status: 'incomplete', report: emptyReport('context-unavailable') }
  const materialized = materializeSceneCandidate(current.document, input.candidate)
  if (materialized.status !== 'ready') return { status: 'incomplete', report: emptyReport('context-unavailable') }
  try {
    const source = sourceFor(input.worldId, current)
    const context = await loadSceneValidationContext(db, input.worldId, source, input.access)
    const budget = sceneBudget(input.budget)
    let report = await validateSceneEnvelope(materialized.envelope, context, budget, controlWithDefaults(input.control), 'edit')
    if (report.status === 'invalid') {
      // 既存/编辑来源区分(spec 23):候选中与当前场景相同的既存问题标 'existing',
      // 仅本次编辑引入的保留 'edit',前端据此决定直接打开修复旅程还是只反馈编辑被拒。
      const storedDecoded = decodeSceneCompatibility(current.document)
      if (storedDecoded.status === 'ready') {
        const existingReport = await validateSceneEnvelope(storedDecoded.envelope, context, budget, controlWithDefaults(input.control), 'existing')
        report = attributeExistingIssues(report, new Set(existingReport.issues.map(issueIdentity)))
      }
    }
    const hash = await candidateHash(input.candidate)
    const basis = basisFor(source, current.version, context, hash, current.contentHash, await readBaselineBasis(db, input.worldId))
    if (report.status === 'valid') return { status: 'valid', basis: { ...basis, candidateHash: hash }, report }
    return report.status === 'incomplete' ? { status: 'incomplete', report } : { status: 'invalid', report }
  } catch {
    return { status: 'incomplete', report: emptyReport('context-unavailable') }
  }
}

export type StoredCandidateValidation =
  | { status: 'valid'; basis: SceneValidationBasis; report: SceneCompatibilityReport }
  | { status: 'invalid' | 'incomplete'; report: SceneCompatibilityReport }

/**
 * Full-envelope validation of an already assembled stored candidate (ordinary
 * save / restore / regeneration writers). The whole envelope — including
 * spaces the edit did not touch — must pass before any commit is attempted.
 */
export async function validateStoredSceneCandidate(
  db: Db,
  input: { worldId: string; document: Parameters<typeof decodeSceneCompatibility>[0]; access: SceneValidationAccess; budget?: Partial<SceneWorkBudget>; control?: Partial<SceneWorkControl> },
): Promise<StoredCandidateValidation> {
  const decoded = decodeSceneCompatibility(input.document)
  if (decoded.status !== 'ready') return { status: 'invalid', report: emptyReport('context-unavailable') }
  const current = await readCurrentScene(db, input.worldId)
  const source: SceneSourceRef = current
    ? sourceFor(input.worldId, current)
    : { worldId: input.worldId, version: 0, contentHash: '' }
  const context = await loadSceneValidationContext(db, input.worldId, source, input.access)
  const report = await validateSceneEnvelope(decoded.envelope, context, sceneBudget(input.budget), controlWithDefaults(input.control), 'edit')
  if (report.status !== 'valid') return { status: report.status, report }
  const basis = basisFor(source, current?.version ?? 0, context, null, current?.contentHash ?? '', await readBaselineBasis(db, input.worldId))
  return { status: 'valid', basis, report }
}

function requestFailure(code: SceneCompatibilityFailure['code'], message: string, report?: SceneCompatibilityReport): SceneCompatibilityFailure {
  return { code, message, action: 'recheck', ...(report ? { report } : {}) }
}

/** 与 origin/ordinal 无关的问题身份:同一缺陷在候选与原场景两次校验中应得同一键。 */
function issueIdentity(issue: SceneIssue): string {
  return [
    issue.code,
    issue.spaceId ?? 'scene',
    issue.objectId ?? '',
    issue.placementId ?? '',
    issue.at ? `${issue.at.x},${issue.at.y},${issue.at.z}` : '',
  ].join('|')
}

/** 候选报告里与原场景既存问题一致的条目标 'existing'(id 同步改写),其余保留 'edit'。 */
function attributeExistingIssues(report: SceneCompatibilityReport, existing: Set<string>): SceneCompatibilityReport {
  return {
    ...report,
    issues: report.issues.map((issue) => {
      if (!existing.has(issueIdentity(issue))) return issue
      const parts = issue.id.split('|')
      parts[1] = 'existing'
      return { ...issue, origin: 'existing' as const, id: parts.join('|') }
    }),
  }
}

function fallbackBasis(input: CreateDraftInput): SceneValidationBasis {
  return {
    expectedCurrentVersion: input.expectedCurrentVersion,
    currentContentHash: '',
    source: { worldId: input.worldId, version: input.expectedCurrentVersion, contentHash: '' },
    candidateHash: null, rulesVersion: '', assetManifestHash: '', templateCatalogHash: '', bindingHash: '', contextFingerprint: '', baseline: null,
  }
}

export class SceneCompatibilityServiceError extends Error {
  readonly status: number
  readonly code: SceneCompatibilityFailure['code']
  readonly report?: SceneCompatibilityReport
  constructor(message: string, code: SceneCompatibilityFailure['code'], status = 409, report?: SceneCompatibilityReport) {
    super(message)
    this.name = 'SceneCompatibilityServiceError'
    this.code = code
    this.status = status
    if (report) this.report = report
  }
}

export class SceneCompatibilityServiceBusy extends SceneCompatibilityServiceError {
  constructor() {
    super('兼容检查服务正忙，请稍后重试', 'service-busy', 503)
    this.name = 'SceneCompatibilityServiceBusy'
  }
}

class SceneDraftDeadlineExceeded extends Error {
  constructor() { super('场景兼容草稿处理超过10秒期限') }
}

type SceneWorkControlWithDeadline = SceneWorkControl & { deadlineAt?: number }

function draftDeadline(budgetInput: Partial<SceneWorkBudget> | undefined, suppliedControl: Partial<SceneWorkControl> | undefined) {
  const base = controlWithDefaults(suppliedControl) as SceneWorkControlWithDeadline
  const maxDurationMs = sceneBudget(budgetInput).maxDraftWallMs ?? 10_000
  const startedAt = base.nowMs()
  const deadlineAt = Math.min(startedAt + maxDurationMs, base.deadlineAt ?? Number.POSITIVE_INFINITY)
  const remainingMs = Math.max(0, deadlineAt - startedAt)
  const deadlineAtUtc = new Date(Date.now() + remainingMs)
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  if (base.signal.aborted) controller.abort()
  else base.signal.addEventListener('abort', abortFromCaller, { once: true })
  let timerExpired = false
  const timer = setTimeout(() => { timerExpired = true; controller.abort() }, remainingMs)
  return {
    deadlineAt,
    deadlineAtUtc,
    control: { ...base, signal: controller.signal, deadlineAt },
    expired: () => timerExpired || base.nowMs() >= deadlineAt,
    check: () => { if (timerExpired || base.nowMs() >= deadlineAt) throw new SceneDraftDeadlineExceeded() },
    close: () => {
      clearTimeout(timer)
      base.signal.removeEventListener('abort', abortFromCaller)
    },
  }
}

/**
 * Gives CPU-bound validation/planning its own maxWallMs deadline, fenced by
 * the encompassing draft deadline. Repair candidate validators read the
 * getter independently; the repair planner snapshots it once at startup.
 */
function operationWorkControl(
  deadline: ReturnType<typeof draftDeadline>,
  budgetInput: Partial<SceneWorkBudget> | undefined,
): SceneWorkControlWithDeadline {
  const control = { ...deadline.control } as SceneWorkControlWithDeadline
  const maxWallMs = sceneBudget(budgetInput).maxWallMs
  Object.defineProperty(control, 'deadlineAt', {
    enumerable: true,
    configurable: false,
    get: () => Math.min(deadline.deadlineAt, deadline.control.nowMs() + maxWallMs),
  })
  return control
}

function deadlineReport(report: SceneCompatibilityReport | null): SceneCompatibilityReport {
  return {
    ...(report ?? emptyReport('deadline')),
    status: 'incomplete', countIsExact: false, stopReason: 'deadline',
  }
}

/**
 * R05/B35: 单 isolate 同时最多一项重型计算。模块级占用标记在 Workers 单 isolate
 * 单线程语义下足够:取得是同步的(调用即占位),并发的第二个请求立即得到
 * service-busy 而不是排队;结束/失败/取消都经 finally 释放。
 * 外层操作只取得一次,内层复验/内部检查复用同一槽(内部函数不再取得,避免自阻塞)。
 */
let workSlotHeld = false

async function withCompatibilityWorkSlot<T>(work: () => Promise<T>): Promise<T> {
  if (workSlotHeld) throw new SceneCompatibilityServiceBusy()
  workSlotHeld = true
  try {
    return await work()
  } finally {
    workSlotHeld = false
  }
}

export async function inspectSceneCompatibility(db: Db, input: SceneInspectionInput): Promise<SceneInspectionResult> {
  return withCompatibilityWorkSlot(() => inspectSceneCompatibilityInner(db, input))
}

export async function createCompatibilityDraft(db: Db, input: CreateDraftInput): Promise<SceneCompatibilityDraft> {
  // B35: 槽在创建任何草稿行之前取得,忙时不产生草稿
  return withCompatibilityWorkSlot(() => createCompatibilityDraftInner(db, input))
}

async function createCompatibilityDraftInner(db: Db, input: CreateDraftInput): Promise<SceneCompatibilityDraft> {
  const deadline = draftDeadline(input.budget, input.control)
  const baseBudget = sceneBudget(input.budget)
  const budgetRemaining = (): SceneWorkBudget => {
    const remaining = Math.max(0, deadline.deadlineAt - deadline.control.nowMs())
    return { ...baseBudget, maxWallMs: Math.min(baseBudget.maxWallMs, remaining), maxDraftWallMs: remaining }
  }
  let draft: SceneCompatibilityDraft | null = null
  let buildAttempt = 0
  let ownsBuildClaim = false
  let finalReport: SceneCompatibilityReport | null = null
  const timeoutDraft = async (): Promise<SceneCompatibilityDraft> => {
    const report = deadlineReport(finalReport)
    if (!draft) {
      try {
        draft = await readSceneCompatibilityDraftByRequestId(db, input.worldId, input.actorKey, input.draftRequestId)
      } catch {
        throw new SceneCompatibilityServiceError('草稿处理超时，持久状态无法核实', 'result-unknown', 503, report)
      }
    }
    if (!draft) {
      throw new SceneCompatibilityServiceError('草稿处理超过10秒期限，请重新检查', 'validation-incomplete', 409, report)
    }
    try {
      if (ownsBuildClaim) {
        const blocked = await blockExpiredSceneCompatibilityDraft(db, {
          worldId: draft.worldId, draftId: draft.id, actorKey: input.actorKey, buildAttempt,
          deadlineAt: deadline.deadlineAtUtc, report, basis: draft.basis, changes: [],
        })
        if (blocked) return blocked
      }
      const persisted = await readSceneCompatibilityDraft(db, draft.worldId, draft.id, input.actorKey)
      if (!persisted) throw new Error('draft row missing')
      // A ready row that could not be fenced is not evidence that the deadline
      // completed safely; preserve the identity and require a durable readback.
      if (persisted.status === 'ready') {
        throw new SceneCompatibilityServiceError('草稿期限已到，但其持久状态仍为 ready；请查询后续请求状态', 'result-unknown', 503, report)
      }
      return persisted
    } catch (error) {
      if (error instanceof SceneCompatibilityServiceError) throw error
      throw new SceneCompatibilityServiceError('草稿处理超时，持久状态无法核实', 'result-unknown', 503, report)
    }
  }

  try {
    deadline.check()
    const inspected = await inspectSceneCompatibilityInner(db, {
      worldId: input.worldId, target: input.target, access: input.access,
      budget: budgetRemaining(), control: deadline.control,
    }, deadline.check, deadline)
    finalReport = inspected.status === 'ready' ? inspected.report : null
    deadline.check()
    // B38:有效当前不需要修复;有效历史直接准备无变化恢复草稿;检查未完成不开放确认。
    if (inspected.status === 'ready' && inspected.report.status === 'valid' && input.purpose === 'repair-current') {
      throw new SceneCompatibilityServiceError('当前场景已完整有效，无需修复', 'repair-not-required')
    }
    const basis = inspected.status === 'ready' ? inspected.basis : fallbackBasis(input)
    const report = inspected.status === 'ready' ? inspected.report : null
    const record: CreateSceneCompatibilityDraftRecord = {
      actorKey: input.actorKey,
      draftRequestId: input.draftRequestId,
      worldId: input.worldId,
      purpose: input.purpose,
      target: input.target,
      expectedCurrentVersion: input.expectedCurrentVersion,
      basis,
    }
    deadline.check()
    draft = await createSceneCompatibilityDraft(db, record)
    deadline.check()
    if (draft.status !== 'building') return draft

    deadline.check()
    const inputFingerprint = await fingerprintSceneCompatibilityDraft(record)
    deadline.check()
    const claim = await claimSceneCompatibilityDraftBuild(db, {
      worldId: draft.worldId, draftId: draft.id, actorKey: input.actorKey, inputFingerprint,
    })
    draft = claim.draft
    buildAttempt = claim.buildAttempt
    ownsBuildClaim = claim.claimed && Boolean(claim.buildLeaseToken)
    deadline.check()
    if (!claim.claimed || !claim.buildLeaseToken) return claim.draft

    let candidate = null
    let changes = [] as SceneCompatibilityDraft['changes']
    finalReport = report
    if (inspected.status === 'ready' && inspected.report.status !== 'incomplete') {
      deadline.check()
      const stored = await readTarget(db, input.worldId, input.target)
      deadline.check()
      if (inspected.report.status === 'valid' && input.purpose === 'restore-history' && stored) {
        // 有效历史恢复:候选逐字采用目标历史文档,零变化。
        candidate = stored.document
        changes = []
        finalReport = inspected.report
      } else {
        const decoded = stored ? decodeSceneCompatibility(stored.document) : { status: 'missing' as const }
        if (decoded.status === 'ready') {
          deadline.check()
          const context = await loadSceneValidationContext(db, input.worldId, inspected.source, input.access)
          deadline.check()
          const repairBudget = budgetRemaining()
          const repair = await repairSceneCompatibility(
            decoded.envelope, context, repairBudget,
            operationWorkControl(deadline, repairBudget),
          )
          finalReport = repair.report
          if (deadline.expired()) return await timeoutDraft()
          candidate = repair.status === 'ready' ? repair.candidate : null
          changes = repair.changes
        }
      }
    }
    if (deadline.expired()) return await timeoutDraft()
    const status = candidate && finalReport?.status === 'valid' ? 'ready' : 'blocked'
    deadline.check()
    const published = await publishSceneCompatibilityDraft(db, {
      worldId: draft.worldId, draftId: draft.id, actorKey: input.actorKey,
      buildLeaseToken: claim.buildLeaseToken, buildAttempt: claim.buildAttempt,
      status, candidate, changes, report: finalReport, basis, deadlineAt: deadline.deadlineAtUtc,
    })
    draft = published
    if (deadline.expired()) return await timeoutDraft()
    return published
  } catch (error) {
    if (deadline.expired()) return await timeoutDraft()
    throw error
  } finally {
    deadline.close()
  }
}

class SceneDraftUnavailable extends Error {
  readonly status = 404
  readonly code = 'draft-unavailable'
  constructor() {
    super('兼容草稿不存在')
    this.name = 'SceneDraftUnavailable'
  }
}

/**
 * R08/B34: 惰性清理——仅在目标世界的读取路径上触发,每次最多清 10 条过期未提交草稿;
 * 已提交/有请求日志(含提交中与未知)的草稿不清。清理失败不影响读取本身。
 */
async function lazyCleanupExpiredDrafts(db: Db, worldId: string): Promise<void> {
  try {
    await cleanupExpiredSceneCompatibilityDrafts(db, worldId)
  } catch {
    // 惰性清理是尽力而为;读取结果不得因清理失败而失败
  }
}

export async function readCompatibilityDraft(db: Db, input: CompatibilityActor & { worldId: string; draftId: string }): Promise<SceneCompatibilityDraft> {
  await lazyCleanupExpiredDrafts(db, input.worldId)
  const draft = await readSceneCompatibilityDraft(db, input.worldId, input.draftId, input.actorKey)
  if (!draft) throw new SceneDraftUnavailable()
  return draft
}

export async function cancelCompatibilityDraft(db: Db, input: CompatibilityActor & { worldId: string; draftId: string }): Promise<SceneCompatibilityDraft> {
  const draft = await cancelSceneCompatibilityDraft(db, input.worldId, input.draftId, input.actorKey)
  if (!draft) throw new SceneDraftUnavailable()
  return draft
}

function auditFor(draft: SceneCompatibilityDraft, requestId: string): SceneRepairAudit {
  return { purpose: draft.purpose, source: draft.basis.source, basis: draft.basis, changes: draft.changes, draftId: draft.id, requestId }
}

export async function confirmCompatibility(db: Db, input: ConfirmInput): Promise<SceneCompatibilityRequestView> {
  // B35: 槽在取得提交执行权(claim/attempt)之前取得,忙时不产生新的执行权
  return withCompatibilityWorkSlot(() => confirmCompatibilityInner(db, input))
}

async function confirmCompatibilityInner(db: Db, input: ConfirmInput): Promise<SceneCompatibilityRequestView> {
  const claim = await claimSceneCompatibilityRequest(db, {
    worldId: input.worldId, draftId: input.draftId, requestId: input.requestId,
    expectedCurrentVersion: input.expectedCurrentVersion, expectedAttempt: input.expectedAttempt,
    actorKey: input.actorKey,
  })
  if (!claim.claimed || !claim.leaseToken) return readSceneCompatibilityRequest(db, input.worldId, input.requestId, input.actorKey)
  const failWith = async (code: SceneCompatibilityFailure['code'], message: string, report?: SceneCompatibilityReport): Promise<SceneCompatibilityRequestView> => {
    try {
      await failSceneCompatibilityRequest(db, { worldId: input.worldId, requestId: input.requestId, actorKey: input.actorKey, attempt: claim.attempt, leaseToken: claim.leaseToken as string, failureCode: code })
    } catch (error) {
      // Recovery or a newer attempt may fence this execution between its
      // validation failure and journal update. Return the durable request view
      // instead of turning a stale execution into an HTTP 500.
      if (error instanceof SceneCompatibilityLeaseLost) {
        return readSceneCompatibilityRequest(db, input.worldId, input.requestId, input.actorKey)
      }
      throw error
    }
    return { status: 'not-committed', attempt: claim.attempt, retryAllowed: false, error: requestFailure(code, message, report) }
  }
  const draft = await readSceneCompatibilityDraft(db, input.worldId, input.draftId, input.actorKey)
  if (!draft?.candidate || draft.status !== 'ready' || draft.report?.status !== 'valid') {
    return failWith('draft-blocked', '草稿尚未通过完整校验', draft?.report ?? undefined)
  }
  // 确认前完整复验:当前版本、上下文依据、基线引用与候选本身都必须与草稿依据一致。
  const current = await readCurrentScene(db, input.worldId)
  if (!current) return failWith('storage-failure', '当前场景版本索引不存在')
  if (current.version !== input.expectedCurrentVersion || current.contentHash !== draft.basis.currentContentHash) {
    return failWith('scene-changed', '场景已更新，请重新检查并预览')
  }
  let context: SceneValidationContext
  try {
    context = await loadSceneValidationContext(db, input.worldId, draft.basis.source, input.access)
  } catch (error) {
    return failWith('context-unavailable', error instanceof Error ? error.message : '校验上下文不可用')
  }
  if (context.contextFingerprint !== draft.basis.contextFingerprint
    || context.bindingHash !== draft.basis.bindingHash
    || context.rulesVersion !== draft.basis.rulesVersion
    || context.assetManifestHash !== draft.basis.assetManifestHash
    || context.templateCatalogHash !== draft.basis.templateCatalogHash) {
    return failWith('basis-changed', '校验依据已变化，请重新检查并预览')
  }
  const baseline = await readBaselineBasis(db, input.worldId)
  if (!sameBaseline(baseline, draft.basis.baseline)) {
    return failWith('basis-changed', '演示基线已变化，请重新检查并预览')
  }
  const decoded = decodeSceneCompatibility(draft.candidate)
  if (decoded.status !== 'ready') return failWith('scene-corrupt', '草稿候选无法解码')
  const report = await validateSceneEnvelope(decoded.envelope, context, sceneBudget(input.budget), controlWithDefaults(input.control), 'repair')
  if (report.status !== 'valid') {
    return failWith(report.status === 'incomplete' ? 'validation-incomplete' : 'scene-invalid', '候选复验未通过，请重新检查并预览', report)
  }
  const audit = auditFor(draft, input.requestId)
  try {
    const committed = await commitScene(db, {
      worldId: input.worldId, expectedVersion: input.expectedCurrentVersion, requestId: input.requestId,
      document: draft.candidate, summary: input.targetSummary ?? `兼容场景确认 ${input.draftId}`,
      kind: draft.purpose === 'restore-history' ? 'restore' : 'compatibility-repair', allowBaseline: input.allowBaseline,
      ...(input.baselineUpdate ? { baselineUpdate: input.baselineUpdate } : {}),
      compatibilityJson: JSON.stringify(audit),
      // B19：草稿/请求执行身份随依据持久化，插入闸门复核 ready 草稿与 attempt/token/租约
      compatibility: {
        draftId: draft.id, requestId: input.requestId, attempt: claim.attempt,
        leaseToken: claim.leaseToken, leaseUntil: claim.request.leaseUntil ?? '',
      },
      compatibilityCompletion: { actorKey: input.actorKey },
      ...(input.authority ? { authority: input.authority } : {}),
    })
    const result: SceneCommitResult = {
      worldId: input.worldId, version: committed.version, contentHash: committed.contentHash, requestId: input.requestId,
      document: committed.document, outcome: draft.purpose === 'restore-history' ? 'restored-history' : 'repaired-current', audit,
    }
    await completeSceneCompatibilityRequest(db, { worldId: input.worldId, requestId: input.requestId, actorKey: input.actorKey, attempt: claim.attempt, leaseToken: claim.leaseToken, resultVersion: committed.version })
    return { status: 'completed', attempt: claim.attempt, result }
  } catch (error) {
    // 提交异常后必须先核实持久状态:修订或成功记录可能已落库,不能按异常直接宣告未提交。
    const persisted = await readSceneCompatibilityRequest(db, input.worldId, input.requestId, input.actorKey).catch(() => null)
    if (persisted?.status === 'completed') return persisted
    if (!persisted || persisted.status === 'unknown') {
      return { status: 'unknown', retryAllowed: false }
    }
    const code = error instanceof Error && (
      error.message.includes('场景已被其他操作更新')
      || error.message.includes('同一 request ID 已用于其他场景用途')
      || error.message.includes('同一 request ID 不能提交不同场景内容')
    ) ? 'scene-changed' : 'storage-failure'
    const message = code === 'storage-failure'
      ? '场景确认过程中发生存储故障；提交结果可能未知，请先查询请求状态。'
      : error instanceof Error ? error.message : '场景确认失败'
    return failWith(code, message)
  }
}

export async function readCompatibilityRequest(db: Db, input: RequestInput & { access: SceneValidationAccess }): Promise<SceneCompatibilityRequestView> {
  await lazyCleanupExpiredDrafts(db, input.worldId)
  const view = await readSceneCompatibilityRequest(db, input.worldId, input.requestId, input.actorKey)
  return validateRetryBasis(db, input, view)
}

export async function recoverCompatibilityRequest(db: Db, input: RecoverInput): Promise<SceneCompatibilityRequestView> {
  const view = await recoverSceneCompatibilityRequest(db, {
    worldId: input.worldId, draftId: input.draftId, requestId: input.requestId,
    expectedCurrentVersion: input.expectedCurrentVersion, expectedAttempt: input.expectedAttempt,
    actorKey: input.actorKey,
  })
  return validateRetryBasis(db, input, view)
}
