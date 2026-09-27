import { and, eq } from 'drizzle-orm'
import { readForkSnapshot } from '../agent/visibility'
import type { Db } from '../db/client'
import { timelines, universeEvidence, universeRevisions, worldModelVersions } from '../db/schema'
import { PROJECTION_DOMAINS, createRootProjectionBaseline, type ProjectionBaseline, type ProjectionRows } from './model'
import { collectReplayInput, readCurrentProjection, type CollectedReplayInput } from './evidence'
import { rebuildProjection, type ProjectionDifference } from './rebuild'

export type UniverseEvidenceLevel = 'complete' | 'upgradeable' | 'incomplete'

export interface UniverseClassification {
  timelineId: string
  level: UniverseEvidenceLevel
  assessedVersion: number | null
  baselineVersion: number | null
  reasonCodes: string[]
  /** Present only when immutable legacy evidence determines one exact baseline. */
  upgradeBaseline?: ProjectionBaseline
}

export interface UniverseUpgradePlan {
  timelineId: string
  kind: 'root_model_version' | 'fork_evidence_attestation'
  source: { table: 'world_model_versions' | 'universe_evidence'; id: string; version?: number }
  expectedJson?: string
  replacementJson?: string
  targetModelVersion?: number
  baseline: ProjectionBaseline
  reasonCodes: string[]
}

export interface UniverseAssessmentResult {
  before: UniverseClassification
  after: UniverseClassification
  plan: UniverseUpgradePlan | null
}

function uniqueReasonCodes(codes: string[]): string[] {
  return [...new Set(codes.filter(Boolean))].sort()
}

function reasonForDifference(difference: ProjectionDifference): string {
  if (difference.reasonCode) return difference.reasonCode
  const separator = difference.detail.indexOf(': ')
  return separator < 0 ? `${difference.domain}_${difference.kind}` : difference.detail.slice(0, separator)
}

function rootLegacyBaseline(evidence: CollectedReplayInput): { baseline?: ProjectionBaseline; reasons: string[] } {
  const modelRow = evidence.modelRows[0]
  if (!modelRow || !evidence.timeline || !evidence.revision) return { reasons: ['pinned_model_missing'] }
  let model: Record<string, unknown>
  try {
    const parsed = JSON.parse(modelRow.modelJson) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { reasons: ['pinned_model_invalid'] }
    model = parsed as Record<string, unknown>
  } catch {
    return { reasons: ['pinned_model_invalid'] }
  }
  // A malformed newer baseline does not erase independently complete legacy
  // evidence. We may fall back only to the immutable initial state/event record
  // below, and the ordinary replay comparison must still match every domain.
  const initialStates = model.initialStates
  const initialEvents = model.initialEvents
  if (!initialStates || typeof initialStates !== 'object' || Array.isArray(initialStates)) {
    return { reasons: ['legacy_root_initial_states_missing'] }
  }
  const stateEvidence = initialStates as Record<string, unknown>
  if (typeof stateEvidence.capturedAt !== 'string' || !Array.isArray(stateEvidence.states)) {
    return { reasons: ['legacy_root_initial_states_invalid'] }
  }
  if (!initialEvents || typeof initialEvents !== 'object' || Array.isArray(initialEvents)) {
    return { reasons: ['legacy_root_initial_events_missing'] }
  }
  const eventEvidence = initialEvents as Record<string, unknown>
  if (eventEvidence.timelineId !== evidence.timelineId || !Array.isArray(eventEvidence.eventIds)
    || eventEvidence.eventIds.some(id => typeof id !== 'string')) {
    return { reasons: ['legacy_root_initial_events_invalid'] }
  }
  // IDs alone cannot reconstruct event content. An explicitly empty list is the
  // only legacy event baseline that is unique without consulting projections.
  if (eventEvidence.eventIds.length > 0) return { reasons: ['legacy_root_initial_event_content_missing'] }
  const baselineStates: ProjectionRows['states'] = []
  for (const value of stateEvidence.states) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { reasons: ['legacy_root_initial_states_invalid'] }
    }
    const state = value as Record<string, unknown>
    if (typeof state.personId !== 'string' || typeof state.simTime !== 'string'
      || typeof state.location !== 'string' || typeof state.activity !== 'string'
      || typeof state.mood !== 'string' || typeof state.goal !== 'string'
      || (state.lastBeatSimTime !== null && typeof state.lastBeatSimTime !== 'string')
      || (state.currentDialogueId !== null && typeof state.currentDialogueId !== 'string')) {
      return { reasons: ['legacy_root_initial_states_invalid'] }
    }
    baselineStates.push({
      personId: state.personId,
      timelineId: evidence.timelineId,
      simTime: state.simTime,
      location: state.location,
      activity: state.activity,
      mood: state.mood,
      goal: state.goal,
      currentDialogueId: state.currentDialogueId,
      lastBeatSimTime: state.lastBeatSimTime,
      updatedRealAt: stateEvidence.capturedAt,
    })
  }
  const initialTimes = new Set(baselineStates.map(state => state.simTime))
  const simTime = initialTimes.size === 0 ? stateEvidence.capturedAt
    : initialTimes.size === 1 ? [...initialTimes][0] : null
  if (!simTime) return { reasons: ['legacy_root_initial_clock_ambiguous'] }
  return {
    baseline: createRootProjectionBaseline(stateEvidence.capturedAt, simTime, baselineStates),
    reasons: ['legacy_root_baseline_derivable'],
  }
}

function forkLegacyBaseline(evidence: CollectedReplayInput): { baseline?: ProjectionBaseline; reasons: string[] } {
  if (!evidence.timeline) return { reasons: ['timeline_missing'] }
  const checkpoint = readForkSnapshot(evidence.timeline)
  if (!checkpoint) return { reasons: ['legacy_fork_checkpoint_missing_or_invalid'] }
  if (!checkpoint.historyComplete) return { reasons: ['legacy_fork_history_incomplete'] }
  if (!Number.isSafeInteger(checkpoint.sourceStateVersion) || !Number.isSafeInteger(checkpoint.worldModelVersion)) {
    return { reasons: ['legacy_fork_checkpoint_version_missing'] }
  }
  if (!Array.isArray(checkpoint.dialogues) || !Array.isArray(checkpoint.dialogueTurns)
    || !Array.isArray(checkpoint.personaMessages) || !Array.isArray(checkpoint.worldFacts)) {
    return { reasons: ['legacy_fork_checkpoint_domain_missing'] }
  }
  if (!Array.isArray(checkpoint.projectedCommitments) && checkpoint.commitments.length > 0) {
    return { reasons: ['legacy_fork_commitment_mapping_missing'] }
  }
  return {
    baseline: {
      source: 'fork',
      version: checkpoint.sourceStateVersion!,
      capturedAt: checkpoint.capturedAt,
      simTime: checkpoint.sourceSimTime,
      completeDomains: [...PROJECTION_DOMAINS],
      rows: {
        states: checkpoint.states,
        schedules: checkpoint.schedules,
        events: checkpoint.events,
        commitments: checkpoint.projectedCommitments ?? checkpoint.commitments,
        memories: checkpoint.memories,
        dialogues: checkpoint.dialogues,
        dialogueTurns: checkpoint.dialogueTurns,
        personaMessages: checkpoint.personaMessages,
        knowledge: checkpoint.worldFacts.filter(fact => fact.factType === 'knowledge'),
      },
    },
    reasons: ['legacy_fork_domains_derivable'],
  }
}

/**
 * Read-only classification. It never promotes data merely because current
 * projection rows exist: an upgradeable result always carries the one baseline
 * derivable from immutable model/checkpoint evidence.
 */
export async function classifyUniverse(db: Db, worldId: string, timelineId: string): Promise<UniverseClassification> {
  const [evidence, current] = await Promise.all([
    collectReplayInput(db, worldId, timelineId),
    readCurrentProjection(db, worldId, timelineId),
  ])
  const assessedVersion = evidence.revision?.version ?? null
  if (!evidence.timeline) return { timelineId, level: 'incomplete', assessedVersion, baselineVersion: null,
    reasonCodes: ['timeline_missing'] }
  if (!evidence.revision) return { timelineId, level: 'incomplete', assessedVersion, baselineVersion: null,
    reasonCodes: ['revision_missing'] }

  if (evidence.baseline && PROJECTION_DOMAINS.every(domain => evidence.baseline!.completeDomains.includes(domain))) {
    const result = await rebuildProjection(db, worldId, timelineId, evidence, current)
    const reasonCodes = uniqueReasonCodes(result.differences.map(reasonForDifference))
    return reasonCodes.length === 0 && result.status === 'complete'
      ? { timelineId, level: 'complete', assessedVersion, baselineVersion: evidence.baseline.version,
          reasonCodes: ['replay_verified'] }
      : { timelineId, level: 'incomplete', assessedVersion, baselineVersion: evidence.baseline.version,
          reasonCodes: uniqueReasonCodes(['replay_verification_failed', ...reasonCodes]) }
  }

  const candidate = evidence.timeline.parentTimelineId
    ? forkLegacyBaseline(evidence)
    : rootLegacyBaseline(evidence)
  if (!candidate.baseline) return { timelineId, level: 'incomplete', assessedVersion, baselineVersion: null,
    reasonCodes: uniqueReasonCodes(candidate.reasons) }
  const verified = await rebuildProjection(db, worldId, timelineId,
    { ...evidence, baseline: candidate.baseline }, current)
  const verificationReasons = uniqueReasonCodes(verified.differences.map(reasonForDifference))
  if (verified.status !== 'complete' || verificationReasons.length > 0) {
    return { timelineId, level: 'incomplete', assessedVersion, baselineVersion: candidate.baseline.version,
      reasonCodes: uniqueReasonCodes(['legacy_upgrade_verification_failed', ...verificationReasons]) }
  }
  return { timelineId, level: 'upgradeable', assessedVersion, baselineVersion: candidate.baseline.version,
    reasonCodes: uniqueReasonCodes(candidate.reasons), upgradeBaseline: candidate.baseline }
}

function evidenceWrite(db: Db, classification: UniverseClassification, assessedAt: string,
  reasonCodes = classification.reasonCodes) {
  const values = {
    timelineId: classification.timelineId,
    level: classification.level,
    assessedVersion: classification.assessedVersion,
    baselineVersion: classification.baselineVersion,
    reasonCodesJson: JSON.stringify(uniqueReasonCodes(reasonCodes)),
    assessedAt,
  }
  return db.insert(universeEvidence).values(values).onConflictDoUpdate({
    target: universeEvidence.timelineId,
    set: {
      level: values.level,
      assessedVersion: values.assessedVersion,
      baselineVersion: values.baselineVersion,
      reasonCodesJson: values.reasonCodesJson,
      assessedAt: values.assessedAt,
    },
  })
}

/** Build the smallest write plan; current projection values never enter it. */
export async function planUniverseUpgrade(
  db: Db,
  worldId: string,
  timelineId: string,
  classification?: UniverseClassification,
): Promise<UniverseUpgradePlan | null> {
  const assessed = classification ?? await classifyUniverse(db, worldId, timelineId)
  if (assessed.level !== 'upgradeable' || !assessed.upgradeBaseline) return null
  const timeline = await db.select().from(timelines).where(and(
    eq(timelines.id, timelineId), eq(timelines.worldId, worldId),
  )).get()
  if (!timeline) return null
  if (timeline.parentTimelineId) {
    return {
      timelineId,
      kind: 'fork_evidence_attestation',
      source: { table: 'universe_evidence', id: timelineId },
      baseline: assessed.upgradeBaseline,
      reasonCodes: assessed.reasonCodes,
    }
  }
  const revision = await collectReplayInput(db, worldId, timelineId)
  const modelRow = revision.modelRows[0]
  if (!modelRow) return null
  const parsed = JSON.parse(modelRow.modelJson) as Record<string, unknown>
  const modelVersions = await db.select({ version: worldModelVersions.version }).from(worldModelVersions)
    .where(eq(worldModelVersions.worldId, worldId)).all()
  const targetModelVersion = Math.max(0, ...modelVersions.map(row => row.version)) + 1
  return {
    timelineId,
    kind: 'root_model_version',
    source: { table: 'world_model_versions', id: worldId, version: modelRow.version },
    expectedJson: modelRow.modelJson,
    replacementJson: JSON.stringify({ ...parsed, projectionBaseline: assessed.upgradeBaseline }),
    targetModelVersion,
    baseline: assessed.upgradeBaseline,
    reasonCodes: assessed.reasonCodes,
  }
}

/**
 * Classify and persist one Universe. Upgrade writes and the complete evidence
 * switch share one D1 batch, so an injected failure rolls both back.
 */
export async function assessAndUpgradeUniverse(
  db: Db,
  worldId: string,
  timelineId: string,
  assessedAt = new Date().toISOString(),
): Promise<UniverseAssessmentResult> {
  const before = await classifyUniverse(db, worldId, timelineId)
  const plan = await planUniverseUpgrade(db, worldId, timelineId, before)
  if (!plan) {
    await evidenceWrite(db, before, assessedAt)
    return { before, after: before, plan: null }
  }
  const completeRecord: UniverseClassification = {
    timelineId,
    level: 'complete',
    assessedVersion: before.assessedVersion,
    baselineVersion: plan.baseline.version,
    reasonCodes: uniqueReasonCodes([...plan.reasonCodes, 'replay_verified']),
  }
  if (plan.kind === 'root_model_version') {
    await db.batch([
      db.insert(worldModelVersions).values({ worldId, version: plan.targetModelVersion!,
        modelJson: plan.replacementJson!, createdAt: assessedAt }),
      db.update(universeRevisions).set({ worldModelVersion: plan.targetModelVersion!, updatedAt: assessedAt }).where(and(
        eq(universeRevisions.timelineId, timelineId),
        eq(universeRevisions.version, before.assessedVersion!),
        eq(universeRevisions.worldModelVersion, plan.source.version!),
      )),
      evidenceWrite(db, completeRecord, assessedAt),
    ])
  } else {
    await evidenceWrite(db, completeRecord, assessedAt)
  }
  const reviewed = await classifyUniverse(db, worldId, timelineId)
  if (reviewed.level !== 'complete' || reviewed.assessedVersion !== before.assessedVersion) {
    throw new Error(`Universe upgrade post-review failed: ${reviewed.reasonCodes.join(',')}`)
  }
  return { before, after: { ...reviewed, reasonCodes: completeRecord.reasonCodes }, plan }
}
