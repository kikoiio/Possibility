import type { AssetManifest } from './assets'
import type { AssetPlacement, EditOperation, VoxelCoord, VoxelDocument } from './types'
import type { SerializedVoxelDocument, SerializedVoxelSpaces } from './serialize'

/** Serialized scene documents accepted by the voxel storage and transport layers. */
export type SceneDocument = SerializedVoxelDocument | SerializedVoxelSpaces
/** Server-side name for the same stored document union; kept out of the public API package. */
export type StoredSceneDocument = SceneDocument

/** The scene being inspected. World identity is supplied by service-layer inputs. */
export type SceneTarget =
  | { kind: 'current' }
  | { kind: 'history'; version: number; targetRevisionId?: string }

export type CompatibilityPurpose = 'repair-current' | 'restore-history'

/** Actions exposed by scene generation and compatibility results. */
export type SceneAction = 'retry' | 'recheck' | 'repair' | 'use-fallback' | 'enter'
/** Compatibility spelling for callers that describe actions as next steps. */
export type SceneCompatibilityAction = SceneAction

export type SceneCandidateSource = 'generated' | 'edited' | 'fallback'

/** A normalized, serializable description of a deterministic normalization fix. */
export interface SceneNormalizationFix {
  code: string
  summary: string
}

/**
 * Redacted result metadata shared by API responses, logs, and evidence.
 * It deliberately contains hashes/counters and user-facing summaries only;
 * raw prompts, provider payloads, credentials, and scene documents do not belong here.
 */
export interface SceneRedactedSummary {
  redacted: true
  source?: SceneCandidateSource
  attempt?: number
  providerCalls?: number
  candidateHash?: string | null
  contentHash?: string | null
  issueCodes?: string[]
  normalizationFixes?: SceneNormalizationFix[]
  rulesVersion?: string
  assetManifestHash?: string
  bindingHash?: string
  contextFingerprint?: string
  workUnitsUsed?: number
  stopReason?: SceneStopReason | null
  persisted?: boolean
  fallback?: boolean
  summary?: string
  nextStep?: string
}

/** Compatibility aliases used by API and evidence consumers. */
export type SceneResultSummary = SceneRedactedSummary
export type SceneCandidateSummary = SceneRedactedSummary
export type SceneCompatibilitySummary = SceneRedactedSummary

/** The serializable metadata common to gate-like compatibility results. */
export interface SceneCompatibilityOutcome {
  actions: SceneAction[]
  fallback: boolean
  summary: SceneRedactedSummary
}

/** Marker accepted on wire for old and new fallback responses. */
export type SceneFallbackMarker = boolean

/** Inputs supplied to a deterministic scene provider in tests and acceptance fixtures. */
export interface DeterministicSceneProviderInput {
  prompt: string
  requestId: string
  attempt: number
  world?: unknown
  personIds?: string[]
}

/** A provider failure that can be safely surfaced in a redacted attempt summary. */
export interface DeterministicSceneProviderFailure {
  code: string
  message?: string
  summary?: string
  retryable?: boolean
}

/** Optional structured shape for fixed provider fixtures. The provider may return any JSON value. */
export interface DeterministicSceneProviderResult<T = unknown> {
  status: 'ready' | 'failed'
  value?: T
  failure?: DeterministicSceneProviderFailure
  summary?: SceneRedactedSummary
}

/**
 * Provider contract used by deterministic tests. `calls` is the canonical counter;
 * `callCount` is retained as a readable compatibility alias for existing fixtures.
 */
export interface DeterministicSceneProvider {
  generate(input: DeterministicSceneProviderInput): Promise<unknown>
  readonly calls: number
  readonly callCount: number
  readonly getCallCount?: () => number
}

/** A fixed result/failure sequence is convenient for deterministic provider fixtures. */
export interface DeterministicSceneProviderScript {
  results: Array<unknown>
  repeatLast?: boolean
}

export type SceneCandidate =
  | {
      kind: 'operations'
      spaceId?: string
      operations: EditOperation[]
      id?: string
      source?: SceneSourceRef
      label?: string
      explanation?: string
    }
  | {
      kind: 'document'
      spaceId?: string
      document: unknown
      id?: string
      source?: SceneSourceRef
      label?: string
      explanation?: string
    }

/** Candidate after deterministic normalization, ready for the compatibility gate. */
export interface NormalizedSceneCandidate {
  candidate: SceneCandidate
  document: SceneDocument
  normalizationFixes: SceneNormalizationFix[]
  source: SceneCandidateSource
  attempt: number
  requestId: string
  contentHash: string
  summary?: SceneRedactedSummary
}

/** Shared result shape for inspection, create-before-commit, and repair gates. */
export interface SceneGateResult extends SceneCompatibilityOutcome {
  status: 'valid' | 'invalid' | 'incomplete'
  candidate: NormalizedSceneCandidate
  report: SceneValidationReport
  basis: SceneValidationBasis
  persisted: boolean
}

export interface SceneSourceRef {
  worldId: string
  version: number
  contentHash: string
  /** X1 scene identity. Absent only for legacy world-scoped A1 records. */
  timelineId?: string
  representation?: string
  /** Optional selected space identity for space-specific inspection/repair. */
  spaceId?: string
  /** Stable revision identity, including when the visible source is an ancestor. */
  targetRevisionId?: string
}

export interface SceneValidationBasis {
  expectedCurrentVersion: number
  currentContentHash: string
  source: SceneSourceRef
  candidateHash: string | null
  rulesVersion: string
  assetManifestHash: string
  templateCatalogHash: string
  bindingHash: string
  contextFingerprint: string
  baseline: {
    id: string
    status: string
    sceneVersion: number
    contentHash: string
  } | null
}

export interface SceneBindingContext {
  personIds: string[]
  locations: Array<{ name: string; stableId?: string }>
  protectedObjects: Array<{ spaceId: string; objectId: string; reasons: string[] }>
  protectedPlacements: Array<{ spaceId: string; placementId: string; reasons: string[] }>
  locationBindings: Array<{
    spaceId: string
    carrierId: string
    location: { name: string; stableId?: string }
  }>
  personBindings: Array<{ spaceId: string; objectId: string; personId: string }>
  entries: Array<{
    fromSpaceId: string
    at: VoxelCoord
    toSpaceId: string
    carrierId?: string
  }>
}

export interface SceneValidationContext {
  rulesVersion: string
  assets: AssetManifest
  bindings: SceneBindingContext
  assetManifestHash: string
  templateCatalogHash: string
  bindingHash: string
  contextFingerprint: string
}

export type SceneCompatibilityFormat = 'single' | 'spaces'

export interface SceneCompatibilityEnvelope {
  original: StoredSceneDocument
  spaces: Array<{ spaceId: string; document: VoxelDocument }>
  format: SceneCompatibilityFormat
  compatibilityChanges: SceneRepairChange[]
}

export type SceneDecodeResult =
  | { status: 'ready'; envelope: SceneCompatibilityEnvelope }
  | { status: 'unsupported' | 'corrupt'; issues: SceneIssue[] }

/** Compatibility aliases used by callers that name the envelope operation explicitly. */
export type SceneCompatibilityDecodeResult = SceneDecodeResult
export type SceneCompatibilityEnvelopeDecodeResult = SceneDecodeResult

export type SceneIssueOrigin = 'existing' | 'edit' | 'repair'
export type SceneIssueCategory =
  | 'format'
  | 'structure'
  | 'asset'
  | 'binding'
  | 'connection'
  | 'walkability'
export type SceneIssueCode =
  | 'invalid-envelope'
  | 'invalid-document'
  | 'unsupported-format'
  | 'unsupported-version'
  | 'unsupported-size'
  | 'scene-missing'
  | 'scene-corrupt'
  | 'scene-invalid'
  | 'asset-collision'
  | 'asset-unsupported'
  | 'asset-overlap'
  | 'asset-unsupported'
  | 'walk-clearance'
  | 'walk-connectivity'
  | 'walk-lighting'
  | 'walk-stairs'
  | 'walk-gap'
  | 'binding-mismatch'
  | 'missing-location'
  | 'missing-resident'
  | 'connection-invalid'
  | 'context-unavailable'
  | 'budget-exceeded'
  | 'cancelled'
  | 'deadline'
  | string

export interface SceneIssue {
  id: string
  code: SceneIssueCode
  origin: SceneIssueOrigin
  category: SceneIssueCategory
  spaceId: string | null
  objectId?: string
  placementId?: string
  at?: VoxelCoord
  summary: string
  suggestion: string
  blocking: true
  reason?: 'collision' | 'unsupported'
  relatedObjectIds?: string[]
  relatedPlacementIds?: string[]
  /** Legacy transport spelling; new reports use summary. */
  message?: string
}

export interface SceneRuleNote {
  code: 'furniture-cavity'
  spaceId: string
  objectId: string
  at: VoxelCoord
  message: string
}

export type SceneStopReason =
  | 'unsupported-size'
  | 'work-limit'
  | 'visit-limit'
  | 'issue-limit'
  | 'attempt-limit'
  | 'deadline'
  | 'cancelled'
  | 'context-unavailable'
  | 'payload-limit'
  | 'space-limit'
  | 'workspace-limit'

export interface SceneValidationReport {
  status: 'valid' | 'invalid' | 'incomplete'
  issues: SceneIssue[]
  issueCount: number
  countIsExact: boolean
  stopReason: SceneStopReason | null
  checkedSpaceIds: string[]
  pendingSpaceIds: string[]
  workUnitsUsed: number
  /** Deterministic algorithm workspace accounting; excludes JS runtime/process RSS. */
  workspaceBytesUsed?: number
  /** Number of cells actually visited by the walkability floods in this report. */
  visitedCellsUsed?: number
  elapsedMs: number
  ruleNotes: { items: SceneRuleNote[]; total: number; hasMore: boolean }
}

/** Compatibility spelling retained for existing consumers. */
export type SceneCompatibilityReport = SceneValidationReport
export type SceneReport = SceneValidationReport

export interface SceneWorkBudget {
  maxWorkUnits: number
  maxVisitedPerFlood: number
  maxCollectedIssues: number
  maxRepairCandidates: number
  maxRepairPasses: number
  maxWallMs: number
  maxWorkspaceBytes: number
  maxSerializedBytes: number
  maxSpaces: number
  /** Optional tighter repair-specific limits used by the pure repair planner. */
  maxRepairChanges?: number
  /** Aggregate work cap across initial inspection and every repair-candidate revalidation. */
  maxRepairWorkUnits?: number
  maxDraftWallMs?: number
}

export interface SceneWorkControl {
  signal: AbortSignal
  nowMs(): number
  yieldControl(): Promise<void>
}

/** Compatibility aliases for early callers; new code should use SceneWorkBudget/SceneWorkControl. */
export type SceneBudget = SceneWorkBudget
export type SceneControl = Partial<SceneWorkControl> & {
  budget?: Partial<SceneWorkBudget>
  deadlineAt?: number
  onStop?: (reason: SceneStopReason) => void
  now?: () => number
}

export type SceneRepairChange =
  | {
      id: string
      spaceId: string
      issueIds: string[]
      summary: string
      kind: 'move-asset'
      placementId: string
      from: VoxelCoord
      to: VoxelCoord
    }
  | {
      id: string
      spaceId: string
      issueIds: string[]
      summary: string
      kind: 'remove-asset'
      placementId: string
      original: AssetPlacement
    }
  | {
      id: string
      spaceId: string
      issueIds: string[]
      summary: string
      kind: 'set-block'
      at: VoxelCoord
      fromBlock: string
      toBlock: string
    }
  | {
      id: string
      spaceId: string
      issueIds: string[]
      summary: string
      kind: 'assign-placement-id'
      placementIndex: number
      placementId: string
    }

export type SceneRepairResult =
  | {
      status: 'ready'
      candidate: StoredSceneDocument
      changes: SceneRepairChange[]
      report: SceneValidationReport
      actions?: SceneAction[]
      fallback?: boolean
      summary?: SceneRedactedSummary
    }
  | {
      status: 'blocked'
      changes: SceneRepairChange[]
      report: SceneValidationReport
      actions?: SceneAction[]
      fallback?: boolean
      summary?: SceneRedactedSummary
    }

export interface SceneCompatibilityDraft {
  id: string
  draftRequestId: string
  actorKey: string
  worldId: string
  purpose: CompatibilityPurpose
  target: SceneTarget
  basis: SceneValidationBasis
  status: 'building' | 'ready' | 'blocked' | 'cancelled' | 'superseded'
  candidate: StoredSceneDocument | null
  changes: SceneRepairChange[]
  report: SceneValidationReport | null
  actions?: SceneAction[]
  fallback?: boolean
  summary?: SceneRedactedSummary
  createdAt: string
  updatedAt: string
}

export interface CreateCompatibilityDraftInput {
  draftRequestId: string
  worldId: string
  purpose: CompatibilityPurpose
  target: SceneTarget
  expectedCurrentVersion: number
}

export interface ConfirmCompatibilityInput {
  worldId: string
  draftId: string
  requestId: string
  expectedCurrentVersion: number
  expectedAttempt: number
}

export interface SceneRepairAudit {
  purpose: CompatibilityPurpose
  source: SceneSourceRef
  basis: SceneValidationBasis
  changes: SceneRepairChange[]
  draftId: string
  requestId: string
}

export interface SceneCommitResult {
  worldId: string
  version: number
  contentHash: string
  requestId: string
  document: StoredSceneDocument
  outcome: 'repaired-current' | 'restored-history'
  audit: SceneRepairAudit
}

export interface SceneCompatibilityRequest {
  worldId: string
  requestId: string
  actorKey: string
  draftId: string
  requestFingerprint: string
  attempt: number
  state: 'submitting' | 'not-committed' | 'completed'
  leaseToken: string | null
  leaseUntil: string | null
  resultVersion: number | null
  failureCode: SceneCompatibilityErrorCode | null
  createdAt: string
  updatedAt: string
}

export type SceneCompatibilityRequestView =
  | { status: 'completed'; attempt: number; result: SceneCommitResult }
  | { status: 'submitting'; attempt: number; retryAllowed: false }
  | { status: 'not-committed'; attempt: number; nextAttempt: number; retryAllowed: true }
  | {
      status: 'not-committed'
      attempt: number
      retryAllowed: false
      error: SceneCompatibilityFailure
    }
  | { status: 'missing'; retryAllowed: false }
  | { status: 'unknown'; retryAllowed: false }

export type SceneCompatibilityErrorCode =
  | 'world-unavailable'
  | 'authentication-required'
  | 'edit-forbidden'
  | 'scene-missing'
  | 'scene-corrupt'
  | 'format-unsupported'
  | 'context-unavailable'
  | 'validation-incomplete'
  | 'scene-invalid'
  | 'compatibility-required'
  | 'draft-blocked'
  | 'draft-unavailable'
  | 'repair-not-required'
  | 'scene-changed'
  | 'basis-changed'
  | 'request-mismatch'
  | 'preflight-required'
  | 'storage-failure'
  | 'result-unknown'
  | 'service-busy'

export interface SceneCompatibilityFailure {
  code: SceneCompatibilityErrorCode
  message: string
  action: 'sign-in' | 'recheck' | 'review-repair' | 'query-result' | 'retry-same-request' | 'return'
  report?: SceneValidationReport
}

export type SceneIssuePage = {
  items: SceneIssue[]
  offset: number
  limit: number
  total: number
  countIsExact: boolean
  hasMore: boolean
}

export type SceneRepairChangePage = {
  items: SceneRepairChange[]
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

export type SceneValidationReportView = Omit<SceneValidationReport, 'issues'> & {
  issues: SceneIssuePage
}

export type SceneRepairAuditView = Omit<SceneRepairAudit, 'changes'> & {
  changes: SceneRepairChangePage
}

export interface SceneCompatibilityDraftView {
  id: string
  worldId: string
  purpose: CompatibilityPurpose
  target: SceneTarget
  basis: SceneValidationBasis
  status: SceneCompatibilityDraft['status']
  previewSpaces: { spaceId: string; name: string }[]
  canConfirm: boolean
  changes: SceneRepairChangePage
  report: SceneValidationReportView | null
  actions?: SceneAction[]
  fallback?: boolean
  summary?: SceneRedactedSummary
  createdAt: string
  updatedAt: string
}

export type SceneCommitReceipt = Omit<SceneCommitResult, 'document' | 'audit'> & {
  source: SceneSourceRef
  rulesVersion: string
}

export type SceneCompatibilityFailureView = Omit<SceneCompatibilityFailure, 'report'> & {
  report?: SceneValidationReportView
}

export type SceneCompatibilityRequestResponse =
  | { status: 'completed'; attempt: number; result: SceneCommitReceipt }
  | { status: 'submitting'; attempt: number; retryAllowed: false }
  | { status: 'not-committed'; attempt: number; nextAttempt: number; retryAllowed: true }
  | {
      status: 'not-committed'
      attempt: number
      retryAllowed: false
      error: SceneCompatibilityFailureView
    }
  | { status: 'missing' | 'unknown'; retryAllowed: false }

export interface SceneInspectionResultReady extends Partial<SceneCompatibilityOutcome> {
  status: 'ready'
  source: SceneSourceRef
  basis: SceneValidationBasis
  report: SceneValidationReport
  canCreateRepairDraft: boolean
}

export type SceneInspectionResult =
  | SceneInspectionResultReady
  | { status: 'missing' | 'corrupt' | 'unsupported'; error: SceneCompatibilityFailure }

export type SceneEditPreflightResult =
  | ({ status: 'valid'; basis: SceneValidationBasis & { candidateHash: string }; report: SceneValidationReport } & Partial<SceneCompatibilityOutcome>)
  | ({ status: 'invalid' | 'incomplete'; report: SceneValidationReport } & Partial<SceneCompatibilityOutcome>)
  | ({ status: 'compatibility-required'; report: SceneValidationReport } & Partial<SceneCompatibilityOutcome>)

/** Public aliases for the remaining lifecycle DTOs used by older callers. */
export type SceneDraftRequest = CreateCompatibilityDraftInput
export type SceneConfirmRequest = ConfirmCompatibilityInput
export type SceneAuditRequest = SceneRepairAudit
export type SceneCommitRequest = ConfirmCompatibilityInput
export type SceneValidationIssue = SceneIssue
export type SceneVoxelValidationIssue = SceneIssue

export interface SceneHttpError {
  code: SceneCompatibilityErrorCode
  message: string
  requestId?: string
  issues?: SceneIssue[]
  retryable?: boolean
  details?: Record<string, unknown>
}

export interface SceneHttpErrorView {
  errorCode: SceneCompatibilityErrorCode
  error: string
  requestId?: string
  issues?: SceneIssuePage
  retryable?: boolean
}

const SCENE_ACTIONS: readonly SceneAction[] = ['retry', 'recheck', 'repair', 'use-fallback', 'enter']
const SCENE_STOP_REASONS: readonly SceneStopReason[] = [
  'unsupported-size', 'work-limit', 'visit-limit', 'issue-limit', 'attempt-limit',
  'deadline', 'cancelled', 'context-unavailable', 'payload-limit', 'space-limit', 'workspace-limit',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) ? value : undefined
}

/** Parse known action values while ignoring unknown fields from newer/older payloads. */
export function parseSceneActions(value: unknown): SceneAction[] {
  if (!Array.isArray(value)) return []
  const actions: SceneAction[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !SCENE_ACTIONS.includes(item as SceneAction)) continue
    const action = item as SceneAction
    if (!actions.includes(action)) actions.push(action)
  }
  return actions
}

/** Return a JSON-safe action array with unsupported/duplicate values removed. */
export function serializeSceneActions(value: unknown): SceneAction[] {
  return parseSceneActions(value)
}

/** Parse the boolean fallback marker used by both current and legacy result DTOs. */
export function parseSceneFallbackMarker(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (!isRecord(value)) return false
  if (typeof value.fallback === 'boolean') return value.fallback
  if (typeof value.used === 'boolean') return value.used
  return value.source === 'fallback' || value.kind === 'fallback'
}

/** Return the stable wire representation for a fallback marker. */
export function serializeSceneFallbackMarker(value: unknown): SceneFallbackMarker {
  return parseSceneFallbackMarker(value)
}

/** Compatibility aliases for callers that omit the word "Marker". */
export const parseSceneFallback = parseSceneFallbackMarker
export const serializeSceneFallback = serializeSceneFallbackMarker

/** Parse a redacted summary and drop unknown or potentially sensitive fields. */
export function parseSceneRedactedSummary(value: unknown): SceneRedactedSummary | null {
  if (!isRecord(value)) return null
  const result: SceneRedactedSummary = { redacted: true }
  const source = value.source
  if (source === 'generated' || source === 'edited' || source === 'fallback') result.source = source
  const attempt = finiteInteger(value.attempt)
  if (attempt !== undefined && attempt >= 0) result.attempt = attempt
  const providerCalls = finiteInteger(value.providerCalls)
  if (providerCalls !== undefined && providerCalls >= 0) result.providerCalls = providerCalls
  for (const key of ['candidateHash', 'contentHash', 'rulesVersion', 'assetManifestHash', 'bindingHash', 'contextFingerprint', 'summary', 'nextStep'] as const) {
    const item = value[key]
    if (typeof item === 'string') result[key] = item
    else if ((key === 'candidateHash' || key === 'contentHash') && item === null) result[key] = null
  }
  if (Array.isArray(value.issueCodes)) {
    result.issueCodes = value.issueCodes.filter((item): item is string => typeof item === 'string')
  }
  if (Array.isArray(value.normalizationFixes)) {
    result.normalizationFixes = value.normalizationFixes.flatMap(item => {
      if (!isRecord(item) || typeof item.code !== 'string' || typeof item.summary !== 'string') return []
      return [{ code: item.code, summary: item.summary }]
    })
  }
  const workUnitsUsed = finiteInteger(value.workUnitsUsed)
  if (workUnitsUsed !== undefined && workUnitsUsed >= 0) result.workUnitsUsed = workUnitsUsed
  if (value.stopReason === null || SCENE_STOP_REASONS.includes(value.stopReason as SceneStopReason)) {
    result.stopReason = value.stopReason as SceneStopReason | null
  }
  if (typeof value.persisted === 'boolean') result.persisted = value.persisted
  if (typeof value.fallback === 'boolean') result.fallback = value.fallback
  return result
}

/** Serialize only the stable, redacted summary fields. */
export function serializeSceneRedactedSummary(value: unknown): SceneRedactedSummary | null {
  const parsed = parseSceneRedactedSummary(value)
  return parsed ? { ...parsed, ...(parsed.issueCodes ? { issueCodes: [...parsed.issueCodes] } : {}), ...(parsed.normalizationFixes ? { normalizationFixes: parsed.normalizationFixes.map(fix => ({ ...fix })) } : {}) } : null
}

/** Parse action/fallback/summary fields from any compatibility result. */
export function parseSceneCompatibilityOutcome(value: unknown): SceneCompatibilityOutcome {
  const record = isRecord(value) ? value : {}
  return {
    actions: parseSceneActions(record.actions),
    fallback: parseSceneFallbackMarker(record.fallback),
    summary: parseSceneRedactedSummary(record.summary) ?? { redacted: true },
  }
}

/** Serialize action/fallback/summary fields without carrying unknown legacy fields through. */
export function serializeSceneCompatibilityOutcome(value: unknown): SceneCompatibilityOutcome {
  const outcome = parseSceneCompatibilityOutcome(value)
  return {
    actions: serializeSceneActions(outcome.actions),
    fallback: serializeSceneFallbackMarker(outcome.fallback),
    summary: serializeSceneRedactedSummary(outcome.summary) ?? { redacted: true },
  }
}
