import type { Db } from '../db/client'
import type { CollectedReplayInput, CurrentProjectionView } from './evidence'
import { auditProjectionEvidence, type InvariantViolation } from './invariants'
import { PROJECTION_DOMAINS, type ProjectionDomain, type ProjectionRows } from './model'
import { reduceProjection, type ReplayDiagnostic } from './projector'

export interface ProjectionDifference {
  domain: ProjectionDomain | 'history'
  recordId?: string
  kind: 'missing' | 'extra' | 'mismatch' | 'unproven' | 'unsupported' | 'wrong_version' | 'wrong_timeline'
  commandId?: string
  factId?: string
  version?: number
  reasonCode?: string
  detail: string
}

export interface ReconstructionResult {
  status: 'complete' | 'incomplete' | 'legacy' | 'unsupported'
  throughVersion: number
  differences: ProjectionDifference[]
}

function projectionDomain(code: string): ProjectionDomain | 'history' {
  if (code.includes('clock')) return 'clock'
  if (code.includes('state') || code.includes('location')) return 'states'
  if (code.includes('schedule')) return 'schedules'
  if (code.includes('event')) return 'events'
  if (code.includes('commitment')) return 'commitments'
  if (code.includes('memory')) return 'memories'
  if (code.includes('persona_message')) return 'personaMessages'
  if (code.includes('dialogue') || code.includes('conversation')) return code.includes('turn') ? 'dialogueTurns' : 'dialogues'
  if (code.includes('knowledge') || code.includes('fact')) return 'knowledge'
  return 'history'
}

function violationDifference(violation: InvariantViolation): ProjectionDifference {
  const kind: ProjectionDifference['kind'] = violation.code.includes('unsupported')
    ? 'unsupported'
    : violation.code.includes('missing') ? 'missing'
      : violation.code.includes('unproven') ? 'unproven' : 'mismatch'
  return {
    domain: projectionDomain(violation.code), kind, commandId: violation.commandId,
    recordId: violation.recordId, version: violation.version, detail: `${violation.code}: ${violation.detail}`,
  }
}

function replayDifference(diagnostic: ReplayDiagnostic): ProjectionDifference {
  return { domain: diagnostic.domain, kind: diagnostic.kind, commandId: diagnostic.commandId,
    factId: diagnostic.factId, recordId: diagnostic.recordId, version: diagnostic.version,
    reasonCode: diagnostic.reasonCode, detail: diagnostic.reasonCode }
}

/** Run the established deterministic replay/invariant reducers against the collected snapshot. */
export async function rebuildProjection(
  db: Db,
  worldId: string,
  timelineId: string,
  evidence: CollectedReplayInput,
  current: CurrentProjectionView,
): Promise<ReconstructionResult> {
  if (!evidence.timeline) return { status: 'incomplete', throughVersion: 0, differences: [{
    domain: 'history', kind: 'missing', detail: 'missing_timeline: Timeline does not belong to the requested world',
  }] }
  if (!evidence.revision) return { status: 'legacy', throughVersion: 0, differences: [] }
  const violations = await auditProjectionEvidence(db, worldId, timelineId, evidence, current)
  const complete = evidence.baseline !== null
    && PROJECTION_DOMAINS.every(domain => evidence.baseline!.completeDomains.includes(domain))
  // A partial/absent legacy baseline is classification evidence, not proof that the
  // materialized projection is corrupt. Only compare an independently rebuilt
  // projection once every domain has an immutable starting point.
  const replay = complete ? reduceProjection({
    worldId,
    timelineId,
    baseline: evidence.baseline,
    commands: evidence.commands,
    facts: evidence.facts,
    throughVersion: evidence.revision.version,
    personNames: evidence.personNames,
    sourceFacts: evidence.sourceFacts,
    visibleTimelineIds: evidence.visibleTimelineIds,
  }) : null
  const independentDifferences = replay ? [
    ...replay.diagnostics.map(replayDifference),
    ...(replay.projection ? compareProjection(replay.projection, current.rows, {
      timelineId,
      baselineVersion: evidence.baseline?.version,
    }) : []),
  ] : []
  const hasUnsupported = replay?.diagnostics.some(diagnostic => diagnostic.kind === 'unsupported')
    || violations.some(violation => violation.code.includes('unsupported'))
  return {
    status: hasUnsupported ? 'unsupported' : complete ? 'complete' : 'incomplete',
    throughVersion: evidence.revision.version,
    differences: [...independentDifferences, ...violations.map(violationDifference)],
  }
}

/** Compare semantic row content while ignoring storage-only timestamps and timeline ownership columns. */
export function compareProjection(
  expected: ProjectionRows,
  current: ProjectionRows,
  context: { timelineId?: string; baselineVersion?: number } = {},
): ProjectionDifference[] {
  const ignored = new Set(['timelineId', 'updatedRealAt'])
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).sort().join(',')}]`
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => !ignored.has(key))
        .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${key}:${stable(item)}`).join(',')}}`
    }
    return JSON.stringify(value)
  }
  const differences: ProjectionDifference[] = []
  if (expected.simTime !== current.simTime) differences.push({ domain: 'clock', kind: 'mismatch',
    reasonCode: 'clock_projection_mismatch', detail: `Expected ${expected.simTime}, got ${current.simTime}` })
  const rowId = (domain: Exclude<ProjectionDomain, 'clock'>, row: unknown): string => {
    const value = row as Record<string, unknown>
    if (domain === 'states') return String(value.personId)
    if (domain === 'schedules') return `${String(value.personId)}:${String(value.worldDate)}`
    return String(value.id)
  }
  for (const domain of PROJECTION_DOMAINS) {
    if (domain === 'clock') continue
    const expectedRows = expected[domain] as unknown[]
    const currentRows = current[domain] as unknown[]
    const expectedById = new Map(expectedRows.map(row => [rowId(domain, row), row]))
    const currentById = new Map(currentRows.map(row => [rowId(domain, row), row]))
    for (const [recordId, row] of expectedById) {
      const actual = currentById.get(recordId)
      if (!actual) {
        differences.push({ domain, kind: 'missing', recordId, reasonCode: `${domain}_projection_missing`,
          commandId: context.baselineVersion === 0 ? `baseline:${context.timelineId}` : undefined,
          version: context.baselineVersion, detail: `Expected ${domain} record ${recordId} is missing` })
      } else if (stable(row) !== stable(actual)) {
        differences.push({ domain, kind: 'mismatch', recordId, reasonCode: `${domain}_projection_mismatch`,
          commandId: context.baselineVersion === 0 ? `baseline:${context.timelineId}` : undefined,
          version: context.baselineVersion, detail: `Projection record ${recordId} differs for ${domain}` })
      }
    }
    for (const recordId of currentById.keys()) {
      if (!expectedById.has(recordId)) differences.push({ domain, kind: 'extra', recordId,
        reasonCode: `${domain}_projection_extra`, detail: `Projection has unexpected ${domain} record ${recordId}` })
    }
  }
  return differences
}
