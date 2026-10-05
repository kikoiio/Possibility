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
  type SceneRepairAudit,
  type SceneSourceRef,
  type SceneTarget,
  type SceneValidationBasis,
  type SceneValidationContext,
  type SceneWorkBudget,
  type SceneWorkControl,
} from '@possibility/voxel-contract'
import type { Db } from '../../db/client'
import { eq } from 'drizzle-orm'
import { demoBaselines } from '../../db/schema'
import {
  cancelSceneCompatibilityDraft,
  claimSceneCompatibilityDraftBuild,
  claimSceneCompatibilityRequest,
  completeSceneCompatibilityRequest,
  createSceneCompatibilityDraft,
  failSceneCompatibilityRequest,
  fingerprintSceneCompatibilityDraft,
  publishSceneCompatibilityDraft,
  readSceneCompatibilityDraft,
  readSceneCompatibilityRequest,
  recoverSceneCompatibilityRequest,
  type CreateSceneCompatibilityDraftRecord,
} from './repository'
import { commitScene, readCurrentScene, readSceneVersion } from '../repository'
import { loadSceneValidationContext, type SceneValidationAccess } from './context'

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
  allowBaseline?: boolean
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

async function readBaselineBasis(db: Db, worldId: string): Promise<SceneValidationBasis['baseline']> {
  const row = await db.select().from(demoBaselines).where(eq(demoBaselines.worldId, worldId)).get()
  if (!row) return null
  return { id: row.id, status: row.status, sceneVersion: row.sceneVersion, contentHash: row.contentHash }
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
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(candidate)))
  return `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function emptyReport(reason: 'context-unavailable'): SceneCompatibilityReport {
  return {
    status: 'incomplete', issues: [], issueCount: 0, countIsExact: false, stopReason: reason,
    checkedSpaceIds: [], pendingSpaceIds: [], workUnitsUsed: 0, elapsedMs: 0,
    ruleNotes: { items: [], total: 0, hasMore: false },
  }
}

export async function inspectSceneCompatibility(db: Db, input: SceneInspectionInput): Promise<SceneInspectionResult> {
  const target = input.target ?? { kind: 'current' as const }
  let stored
  try {
    stored = await readTarget(db, input.worldId, target)
  } catch (error) {
    return failure('corrupt', error instanceof Error ? error.message : '场景读取失败')
  }
  if (!stored) return failure('missing', '请求的场景版本不存在')
  const decoded = decodeSceneCompatibility(stored.document)
  if (decoded.status !== 'ready') {
    return failure(decoded.status, decoded.issues[0]?.summary ?? '场景无法解码')
  }
  try {
    const source = sourceFor(input.worldId, stored)
    const current = await readCurrentScene(db, input.worldId)
    if (!current) return failure('corrupt', '当前场景版本索引不存在')
    const context = await loadSceneValidationContext(db, input.worldId, source, input.access)
    const budget = sceneBudget(input.budget)
    const report = await validateSceneEnvelope(decoded.envelope, context, budget, controlWithDefaults(input.control), 'existing')
    return { status: 'ready', source, basis: basisFor(source, current.version, context, null, current.contentHash, await readBaselineBasis(db, input.worldId)), report, canCreateRepairDraft: report.status === 'invalid' }
  } catch (error) {
    return failure('corrupt', error instanceof Error ? error.message : '场景校验失败')
  }
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
    const report = await validateSceneEnvelope(materialized.envelope, context, budget, controlWithDefaults(input.control), 'edit')
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

export async function createCompatibilityDraft(db: Db, input: CreateDraftInput): Promise<SceneCompatibilityDraft> {
  const inspected = await inspectSceneCompatibility(db, { worldId: input.worldId, target: input.target, access: input.access, budget: input.budget, control: input.control })
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
  const draft = await createSceneCompatibilityDraft(db, record)
  if (draft.status !== 'building') return draft
  const claim = await claimSceneCompatibilityDraftBuild(db, {
    worldId: draft.worldId,
    draftId: draft.id,
    actorKey: input.actorKey,
    inputFingerprint: await fingerprintSceneCompatibilityDraft(record),
  })
  if (!claim.claimed || !claim.buildLeaseToken) return claim.draft

  let candidate = null
  let changes = [] as SceneCompatibilityDraft['changes']
  let finalReport = report
  if (inspected.status === 'ready') {
    const stored = await readTarget(db, input.worldId, input.target)
    if (inspected.report.status === 'valid' && input.purpose === 'restore-history' && stored) {
      // 有效历史恢复:候选逐字采用目标历史文档,零变化。
      candidate = stored.document
      changes = []
      finalReport = inspected.report
    } else {
      const decoded = stored ? decodeSceneCompatibility(stored.document) : { status: 'missing' as const }
      if (decoded.status === 'ready') {
        const context = await loadSceneValidationContext(db, input.worldId, inspected.source, input.access)
        const budget = sceneBudget(input.budget)
        const repair = await repairSceneCompatibility(decoded.envelope, context, budget, controlWithDefaults(input.control))
        candidate = repair.status === 'ready' ? repair.candidate : null
        changes = repair.changes
        finalReport = repair.report
      }
    }
  }
  const status = candidate && finalReport?.status === 'valid' ? 'ready' : 'blocked'
  return publishSceneCompatibilityDraft(db, {
    worldId: draft.worldId,
    draftId: draft.id,
    actorKey: input.actorKey,
    buildLeaseToken: claim.buildLeaseToken,
    buildAttempt: claim.buildAttempt,
    status,
    candidate,
    changes,
    report: finalReport,
    basis,
  })
}

class SceneDraftUnavailable extends Error {
  readonly status = 404
  readonly code = 'draft-unavailable'
  constructor() {
    super('兼容草稿不存在')
    this.name = 'SceneDraftUnavailable'
  }
}

export async function readCompatibilityDraft(db: Db, input: CompatibilityActor & { worldId: string; draftId: string }): Promise<SceneCompatibilityDraft> {
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
  const claim = await claimSceneCompatibilityRequest(db, {
    worldId: input.worldId, draftId: input.draftId, requestId: input.requestId,
    expectedCurrentVersion: input.expectedCurrentVersion, expectedAttempt: input.expectedAttempt,
    actorKey: input.actorKey,
  })
  if (!claim.claimed || !claim.leaseToken) return readSceneCompatibilityRequest(db, input.worldId, input.requestId, input.actorKey)
  const failWith = async (code: SceneCompatibilityFailure['code'], message: string, report?: SceneCompatibilityReport): Promise<SceneCompatibilityRequestView> => {
    await failSceneCompatibilityRequest(db, { worldId: input.worldId, requestId: input.requestId, actorKey: input.actorKey, attempt: claim.attempt, leaseToken: claim.leaseToken as string, failureCode: code })
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
      compatibilityJson: JSON.stringify(audit),
      // B19：草稿/请求执行身份随依据持久化，插入闸门复核 ready 草稿与 attempt/token/租约
      compatibility: {
        draftId: draft.id, requestId: input.requestId, attempt: claim.attempt,
        leaseToken: claim.leaseToken, leaseUntil: claim.request.leaseUntil ?? '',
      },
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
    const code = error instanceof Error && /场景已被|request|更新/.test(error.message) ? 'scene-changed' : 'storage-failure'
    return failWith(code, error instanceof Error ? error.message : '场景确认失败')
  }
}

export async function readCompatibilityRequest(db: Db, input: RequestInput): Promise<SceneCompatibilityRequestView> {
  return readSceneCompatibilityRequest(db, input.worldId, input.requestId, input.actorKey)
}

export async function recoverCompatibilityRequest(db: Db, input: RecoverInput): Promise<SceneCompatibilityRequestView> {
  return recoverSceneCompatibilityRequest(db, {
    worldId: input.worldId, draftId: input.draftId, requestId: input.requestId,
    expectedCurrentVersion: input.expectedCurrentVersion, expectedAttempt: input.expectedAttempt,
    actorKey: input.actorKey,
  })
}
