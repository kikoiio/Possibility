import type {
  SceneCompatibilityDraft,
  SceneCompatibilityDraftView,
  SceneCompatibilityFailure,
  SceneCompatibilityRequestView,
  SceneCommitReceipt,
  SceneInspectionResult,
  SceneValidationReport,
} from '@possibility/voxel-contract'

/** Convert a validation report to the paged, bounded shape used by HTTP clients. */
export function reportView(report: SceneValidationReport | null) {
  if (!report) return null
  const issues = report.issues.slice(0, 256)
  return {
    ...report,
    issues: {
      items: issues,
      offset: 0,
      limit: issues.length,
      total: report.issueCount,
      countIsExact: report.countIsExact,
      hasMore: report.issueCount > issues.length,
    },
  }
}

export interface DraftPageQuery {
  limit?: number
  offset?: number
  issuesOffset?: number
  changesOffset?: number
}

function page<T>(items: T[], offset: number, limit: number) {
  const visible = items.slice(offset, offset + limit)
  return { items: visible, offset, limit, total: items.length, hasMore: offset + visible.length < items.length }
}

function reportPage(report: SceneValidationReport | null, offset: number, limit: number) {
  if (!report) return null
  const retainedIssues = report.issues.slice(0, 256)
  return {
    ...report,
    issues: {
      ...page(retainedIssues, offset, limit),
      total: report.issueCount,
      countIsExact: report.countIsExact,
    },
  }
}

/** Public draft DTO. Candidate scene data and execution identity never cross this boundary. */
export function toDraftView(draft: SceneCompatibilityDraft, query: DraftPageQuery = {}): SceneCompatibilityDraftView {
  const limit = Math.max(1, Math.min(50, Math.trunc(query.limit ?? 20)))
  const issuesOffset = Math.max(0, Math.trunc(query.issuesOffset ?? query.offset ?? 0))
  const changesOffset = Math.max(0, Math.trunc(query.changesOffset ?? query.offset ?? 0))
  const candidate = draft.candidate as { spaces?: Array<{ id?: string; name?: string }> } | null
  return {
    id: draft.id,
    worldId: draft.worldId,
    purpose: draft.purpose,
    target: structuredClone(draft.target),
    basis: structuredClone(draft.basis),
    status: draft.status,
    previewSpaces: candidate?.spaces?.map(space => ({
      spaceId: space.id ?? '', name: space.name ?? space.id ?? '',
    })).filter(space => space.spaceId.length > 0) ?? (draft.candidate ? [{ spaceId: 'single', name: '场景' }] : []),
    canConfirm: draft.status === 'ready' && draft.candidate !== null && draft.report?.status === 'valid',
    changes: page(draft.changes, changesOffset, limit),
    report: reportPage(draft.report, issuesOffset, limit),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  }
}

/** Parse independent list cursors for GET /drafts/:draftId. */
export function parseDraftPageQuery(query: Record<string, string | undefined>): DraftPageQuery | null {
  const parse = (raw: string | undefined): number | null | undefined => {
    if (raw === undefined) return undefined
    if (!/^\d+$/.test(raw)) return null
    const value = Number(raw)
    return Number.isSafeInteger(value) ? value : null
  }
  const limit = parse(query.limit)
  const offset = parse(query.offset)
  const issuesOffset = parse(query.issuesOffset)
  const changesOffset = parse(query.changesOffset)
  if (limit === null || offset === null || issuesOffset === null || changesOffset === null) return null
  return {
    limit: Math.max(1, Math.min(50, limit ?? 20)),
    offset,
    issuesOffset,
    changesOffset,
  }
}

/** Completed results return a receipt only; the committed document remains behind scene reads. */
export function toReceipt(result: {
  worldId: string
  version: number
  contentHash: string
  requestId: string
  outcome: 'repaired-current' | 'restored-history'
  audit: { source: { worldId: string; version: number; contentHash: string }; basis: { rulesVersion: string } }
}): SceneCommitReceipt {
  return {
    worldId: result.worldId,
    version: result.version,
    contentHash: result.contentHash,
    requestId: result.requestId,
    outcome: result.outcome,
    source: structuredClone(result.audit.source),
    rulesVersion: result.audit.basis.rulesVersion,
  }
}

export function toRequestView(view: SceneCompatibilityRequestView): unknown {
  if (view.status !== 'completed') {
    if (view.status === 'not-committed' && 'error' in view) {
      return { ...view, error: failureView(view.error) }
    }
    return view
  }
  return { status: 'completed', attempt: view.attempt, result: toReceipt(view.result) }
}

function failureView(failure: SceneCompatibilityFailure) {
  return {
    code: failure.code,
    message: failure.message,
    action: failure.action,
    ...(failure.report ? { report: reportView(failure.report) } : {}),
  }
}

export function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return { errorCode: code, error: message, ...(details ? { details } : {}) }
}

export function parseTarget(value: unknown): { kind: 'current' } | { kind: 'history'; version: number; targetRevisionId?: string } | null {
  if (value === undefined || value === null) return { kind: 'current' }
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const target = value as { kind?: unknown; version?: unknown; targetRevisionId?: unknown }
  if (target.kind === 'current') return { kind: 'current' }
  if (target.kind === 'history' && Number.isSafeInteger(target.version) && (target.version as number) > 0) {
    if (target.targetRevisionId !== undefined && (typeof target.targetRevisionId !== 'string' || target.targetRevisionId.length === 0 || target.targetRevisionId.length > 200)) return null
    return { kind: 'history', version: target.version as number, ...(typeof target.targetRevisionId === 'string' ? { targetRevisionId: target.targetRevisionId } : {}) }
  }
  return null
}

export function parseQueryTarget(version: string | undefined, targetRevisionId?: string) {
  if (version === undefined || version === '') return targetRevisionId ? null : { kind: 'current' as const }
  if (targetRevisionId && (targetRevisionId.length > 200 || targetRevisionId.length === 0)) return null
  const parsed = Number(version)
  return Number.isSafeInteger(parsed) && parsed > 0
    ? { kind: 'history' as const, version: parsed, ...(targetRevisionId ? { targetRevisionId } : {}) }
    : null
}

export function isPurpose(value: unknown): value is 'repair-current' | 'restore-history' {
  return value === 'repair-current' || value === 'restore-history'
}

export function isCandidate(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as { kind?: unknown; operations?: unknown; document?: unknown }
  if (candidate.kind === 'operations') return Array.isArray(candidate.operations)
  return candidate.kind === 'document' && candidate.document !== undefined
}

export function inspectionError(result: Exclude<SceneInspectionResult, { status: 'ready' }>) {
  return errorBody(result.error.code, result.error.message, result.error.report ? { report: reportView(result.error.report) ?? undefined } : undefined)
}
