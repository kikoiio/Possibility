import { and, asc, eq, or, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { readForkSnapshot } from '../agent/visibility'
import {
  commitments, dialogueTurns, dialogues, events, memories, personaMessages, personStates, schedules,
  timelines, universeRevisions, worldCommands, worldFacts, worldModelVersions,
} from '../db/schema'
import { auditProjectionEvidence, type InvariantViolation } from './invariants'
import { PROJECTION_DOMAINS, type ProjectionBaseline, type ProjectionDomain, type ProjectionRows } from './model'

export interface TimelineEvidence {
  timeline: typeof timelines.$inferSelect | null
  revision: typeof universeRevisions.$inferSelect | null
  baseline: ProjectionBaseline | null
  commands: (typeof worldCommands.$inferSelect)[]
  facts: (typeof worldFacts.$inferSelect)[]
  modelRows: (typeof worldModelVersions.$inferSelect)[]
  current: ProjectionRows
}

export interface ProjectionDifference {
  domain: ProjectionDomain | 'history'
  recordId?: string
  kind: 'missing' | 'mismatch' | 'unproven' | 'unsupported'
  commandId?: string
  version?: number
  detail: string
}

export interface ReconstructionResult {
  status: 'complete' | 'incomplete' | 'legacy' | 'unsupported'
  throughVersion: number
  differences: ProjectionDifference[]
}

function parseBaseline(value: unknown): ProjectionBaseline | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const domains = candidate.completeDomains
  if ((candidate.source !== 'root' && candidate.source !== 'fork')
    || !Number.isInteger(candidate.version) || typeof candidate.capturedAt !== 'string'
    || typeof candidate.simTime !== 'string' || !Array.isArray(domains)
    || domains.some(domain => typeof domain !== 'string' || !(PROJECTION_DOMAINS as readonly string[]).includes(domain))
    || !candidate.rows || typeof candidate.rows !== 'object' || Array.isArray(candidate.rows)) return null
  const rows = candidate.rows as Record<string, unknown>
  const rowDomain: Partial<Record<ProjectionDomain, string>> = {
    states: 'states', schedules: 'schedules', events: 'events', commitments: 'commitments', memories: 'memories',
    dialogues: 'dialogues', dialogueTurns: 'dialogueTurns', personaMessages: 'personaMessages',
  }
  if (domains.some(domain => typeof domain === 'string' && rowDomain[domain as ProjectionDomain]
    && !Array.isArray(rows[rowDomain[domain as ProjectionDomain]!])) ) return null
  return candidate as unknown as ProjectionBaseline
}

/** Collect replay inputs and current projections in one read-only D1 batch. */
export async function collectTimelineEvidence(db: Db, worldId: string, timelineId: string): Promise<TimelineEvidence> {
  const [timelineRows, revisionRows, commands, facts, states, scheduleRows, eventRows, commitmentRows, memoryRows,
    dialogueRows, turnRows, messageRows, modelRows] = await db.batch([
    db.select().from(timelines).where(and(eq(timelines.id, timelineId), eq(timelines.worldId, worldId))),
    db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timelineId)),
    db.select().from(worldCommands).where(eq(worldCommands.timelineId, timelineId)).orderBy(asc(worldCommands.resultVersion)),
    db.select().from(worldFacts).where(eq(worldFacts.timelineId, timelineId)).orderBy(asc(worldFacts.version)),
    db.select().from(personStates).where(eq(personStates.timelineId, timelineId)),
    db.select().from(schedules).where(eq(schedules.timelineId, timelineId)),
    db.select().from(events).where(eq(events.timelineId, timelineId)),
    db.select().from(commitments).where(and(eq(commitments.worldId, worldId), eq(commitments.timelineId, timelineId))),
    db.select().from(memories).where(or(eq(memories.timelineId, timelineId), isNull(memories.timelineId))),
    db.select().from(dialogues).where(eq(dialogues.timelineId, timelineId)),
    db.select().from(dialogueTurns),
    db.select().from(personaMessages).where(and(eq(personaMessages.worldId, worldId), eq(personaMessages.timelineId, timelineId))),
    db.select().from(worldModelVersions).where(eq(worldModelVersions.worldId, worldId)),
  ])
  const timeline = timelineRows[0] ?? null
  const revision = revisionRows[0] ?? null
  const baseline = (() => {
    if (!timeline || !revision) return null
    if (timeline.parentTimelineId) {
      const checkpoint = readForkSnapshot(timeline)
      if (!checkpoint?.completeDomains) return null
      return parseBaseline({
        source: 'fork', version: checkpoint.sourceStateVersion ?? 0, capturedAt: checkpoint.capturedAt,
        simTime: checkpoint.sourceSimTime, completeDomains: checkpoint.completeDomains,
        rows: {
          states: checkpoint.states, schedules: checkpoint.schedules, events: checkpoint.events,
          commitments: checkpoint.commitments, memories: checkpoint.memories, dialogues: checkpoint.dialogues ?? [],
          dialogueTurns: checkpoint.dialogueTurns ?? [], personaMessages: checkpoint.personaMessages ?? [],
        },
      })
    }
    const model = modelRows.find(row => row.version === revision.worldModelVersion)
    try {
      const pinned = model ? JSON.parse(model.modelJson) as { projectionBaseline?: unknown } : null
      return parseBaseline(pinned?.projectionBaseline)
    } catch { return null }
  })()
  const memoryProjection = timeline?.parentTimelineId
    ? memoryRows.filter(row => row.timelineId === timelineId)
    : memoryRows.filter(row => row.timelineId === null || row.timelineId === timelineId)
  const dialoguesById = new Set(dialogueRows.map(row => row.id))
  const current: ProjectionRows = {
    simTime: revision?.simTime ?? timeline?.simNow ?? '',
    states, schedules: scheduleRows, events: eventRows, commitments: commitmentRows,
    memories: memoryProjection,
    dialogues: dialogueRows,
    dialogueTurns: turnRows.filter(row => dialoguesById.has(row.dialogueId)),
    personaMessages: messageRows,
    knowledge: [
      ...(timeline ? readForkSnapshot(timeline)?.worldFacts ?? [] : []),
      ...facts,
    ].filter(fact => fact.factType === 'knowledge'),
  }
  const pinnedModelRows = revision ? modelRows.filter(row => row.version === revision.worldModelVersion) : []
  return { timeline, revision, baseline, commands, facts, modelRows: pinnedModelRows, current }
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

/** Run the established deterministic replay/invariant reducers against the collected snapshot. */
export async function rebuildProjection(db: Db, worldId: string, timelineId: string, evidence: TimelineEvidence): Promise<ReconstructionResult> {
  if (!evidence.timeline) return { status: 'incomplete', throughVersion: 0, differences: [{
    domain: 'history', kind: 'missing', detail: 'missing_timeline: Timeline does not belong to the requested world',
  }] }
  if (!evidence.revision) return { status: 'legacy', throughVersion: 0, differences: [] }
  const violations = await auditProjectionEvidence(db, worldId, timelineId, evidence)
  const complete = evidence.baseline !== null
    && PROJECTION_DOMAINS.every(domain => evidence.baseline!.completeDomains.includes(domain))
  const hasUnsupported = violations.some(violation => violation.code.includes('unsupported'))
  return {
    status: hasUnsupported ? 'unsupported' : complete ? 'complete' : 'incomplete',
    throughVersion: evidence.revision.version,
    differences: violations.map(violationDifference),
  }
}

/** Compare semantic row content while ignoring storage-only timestamps and timeline ownership columns. */
export function compareProjection(expected: ProjectionRows, current: ProjectionRows): ProjectionDifference[] {
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
  if (expected.simTime !== current.simTime) differences.push({ domain: 'clock', kind: 'mismatch', detail: `Expected ${expected.simTime}, got ${current.simTime}` })
  for (const domain of PROJECTION_DOMAINS) {
    if (domain === 'clock') continue
    const expectedRows = expected[domain] as unknown[]
    const currentRows = current[domain] as unknown[]
    if (stable(expectedRows) !== stable(currentRows)) differences.push({
      domain, kind: 'mismatch', detail: `Projection rows differ for ${domain}`,
    })
  }
  return differences
}
