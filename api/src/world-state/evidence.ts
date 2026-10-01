import { and, asc, eq, isNull, or } from 'drizzle-orm'
import { readForkSnapshot } from '../agent/visibility'
import { hydrateTimelines } from '../life/snapshot-store'
import type { Db } from '../db/client'
import {
  commitments, dialogueTurns, dialogues, events, memories, personaMessages, personStates, schedules,
  timelines, universeEvidence, universeRevisions, worldCommands, worldFacts, worldModelVersions,
} from '../db/schema'
import { PROJECTION_DOMAINS, type ProjectionBaseline, type ProjectionDomain, type ProjectionRows } from './model'

/** Immutable inputs used to replay one timeline. It deliberately contains no current projection rows. */
export interface CollectedReplayInput {
  worldId: string
  timelineId: string
  timeline: typeof timelines.$inferSelect | null
  revision: typeof universeRevisions.$inferSelect | null
  evidenceRecord: typeof universeEvidence.$inferSelect | null
  baseline: ProjectionBaseline | null
  commands: (typeof worldCommands.$inferSelect)[]
  facts: (typeof worldFacts.$inferSelect)[]
  modelRows: (typeof worldModelVersions.$inferSelect)[]
  personNames: Record<string, string>
  sourceFacts: (typeof worldFacts.$inferSelect)[]
  visibleTimelineIds: string[]
}

/** Stored projection rows used only as the comparison target. It cannot carry replay evidence. */
export interface CurrentProjectionView {
  worldId: string
  timelineId: string
  rows: ProjectionRows
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
    dialogues: 'dialogues', dialogueTurns: 'dialogueTurns', personaMessages: 'personaMessages', knowledge: 'knowledge',
  }
  if (domains.some(domain => typeof domain === 'string' && rowDomain[domain as ProjectionDomain]
    && !Array.isArray(rows[rowDomain[domain as ProjectionDomain]!])) ) return null
  return candidate as unknown as ProjectionBaseline
}

/** 装配一条线的回放基线:分叉线取其不可变分叉快照,主线取钉住模型的 projectionBaseline。
 * completeDomains 不足(且无 legacy  attest)返回 null——调用方 fail-closed。 */
export function resolveProjectionBaseline(
  timeline: typeof timelines.$inferSelect | null,
  revision: typeof universeRevisions.$inferSelect | null,
  evidenceRecord: typeof universeEvidence.$inferSelect | null,
  modelRows: (typeof worldModelVersions.$inferSelect)[],
): ProjectionBaseline | null {
  if (!timeline || !revision) return null
  if (timeline.parentTimelineId) {
    const checkpoint = readForkSnapshot(timeline)
    if (!checkpoint) return null
    let completeDomains = checkpoint.completeDomains
    if (!completeDomains && evidenceRecord?.level === 'complete') {
      let reasons: unknown = []
      try { reasons = JSON.parse(evidenceRecord.reasonCodesJson) } catch { /* invalid evidence remains fail-closed */ }
      const attestedLegacyFork = Array.isArray(reasons) && reasons.includes('legacy_fork_domains_derivable')
        && checkpoint.historyComplete && Number.isSafeInteger(checkpoint.sourceStateVersion)
        && Number.isSafeInteger(checkpoint.worldModelVersion) && Array.isArray(checkpoint.dialogues)
        && Array.isArray(checkpoint.dialogueTurns) && Array.isArray(checkpoint.personaMessages)
        && Array.isArray(checkpoint.worldFacts)
      if (attestedLegacyFork) completeDomains = [...PROJECTION_DOMAINS]
    }
    if (!completeDomains) return null
    return parseBaseline({
      source: 'fork', version: checkpoint.sourceStateVersion ?? 0, capturedAt: checkpoint.capturedAt,
      simTime: checkpoint.sourceSimTime, completeDomains,
      rows: {
        states: checkpoint.states, schedules: checkpoint.schedules, events: checkpoint.events,
        commitments: checkpoint.projectedCommitments ?? checkpoint.commitments,
        memories: checkpoint.memories, dialogues: checkpoint.dialogues ?? [],
        dialogueTurns: checkpoint.dialogueTurns ?? [], personaMessages: checkpoint.personaMessages ?? [],
        knowledge: (checkpoint.worldFacts ?? []).filter(fact => fact.factType === 'knowledge'),
      },
    })
  }
  const model = modelRows.find(row => row.version === revision.worldModelVersion)
  try {
    const pinned = model ? JSON.parse(model.modelJson) as { projectionBaseline?: unknown } : null
    return parseBaseline(pinned?.projectionBaseline)
  } catch { return null }
}

/** Read only baseline, command, fact, and pinned-model evidence required for deterministic replay. */
export async function collectReplayInput(db: Db, worldId: string, timelineId: string): Promise<CollectedReplayInput> {
  const [timelineRows, revisionRows, evidenceRows, commands, facts, modelRows] = await db.batch([
    db.select().from(timelines).where(and(eq(timelines.id, timelineId), eq(timelines.worldId, worldId))),
    db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timelineId)),
    db.select().from(universeEvidence).where(eq(universeEvidence.timelineId, timelineId)),
    db.select().from(worldCommands).where(eq(worldCommands.timelineId, timelineId)).orderBy(asc(worldCommands.resultVersion)),
    db.select().from(worldFacts).where(eq(worldFacts.timelineId, timelineId)).orderBy(asc(worldFacts.version)),
    db.select().from(worldModelVersions).where(eq(worldModelVersions.worldId, worldId)),
  ])
  const timeline = (await hydrateTimelines(db, timelineRows))[0] ?? null
  const revision = revisionRows[0] ?? null
  const evidenceRecord = evidenceRows[0] ?? null
  const baseline = resolveProjectionBaseline(timeline, revision, evidenceRecord, modelRows)
  const pinnedModelRows = revision ? modelRows.filter(row => row.version === revision.worldModelVersion) : []
  let personNames: Record<string, string> = {}
  try {
    const model = pinnedModelRows[0] ? JSON.parse(pinnedModelRows[0].modelJson) as {
      residents?: { id?: unknown; name?: unknown }[]
    } : null
    personNames = Object.fromEntries((model?.residents ?? [])
      .filter((resident): resident is { id: string; name: string } => typeof resident.id === 'string' && typeof resident.name === 'string')
      .map(resident => [resident.id, resident.name]))
  } catch { /* malformed models are diagnosed by replay/invariant validation */ }
  const checkpoint = timeline?.parentTimelineId ? readForkSnapshot(timeline) : null
  let ancestorIds: string[] = []
  try {
    const parsed = timeline ? JSON.parse(timeline.ancestorIdsJson) as unknown : []
    ancestorIds = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch { /* invalid ancestry remains limited to the current line */ }
  return { worldId, timelineId, timeline, revision, evidenceRecord, baseline, commands, facts, modelRows: pinnedModelRows,
    personNames, sourceFacts: checkpoint?.worldFacts ?? [], visibleTimelineIds: [...new Set([...ancestorIds, timelineId])] }
}

/** Read only the materialized projection used as the audit comparison target. */
export async function readCurrentProjection(db: Db, worldId: string, timelineId: string): Promise<CurrentProjectionView> {
  const [timelineRows, revisionRows, states, scheduleRows, eventRows, commitmentRows, memoryRows,
    dialogueRows, turnRows, messageRows, facts] = await db.batch([
    db.select().from(timelines).where(and(eq(timelines.id, timelineId), eq(timelines.worldId, worldId))),
    db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timelineId)),
    db.select().from(personStates).where(eq(personStates.timelineId, timelineId)),
    db.select().from(schedules).where(eq(schedules.timelineId, timelineId)),
    db.select().from(events).where(eq(events.timelineId, timelineId)),
    db.select().from(commitments).where(and(eq(commitments.worldId, worldId), eq(commitments.timelineId, timelineId))),
    db.select().from(memories).where(or(eq(memories.timelineId, timelineId), isNull(memories.timelineId))),
    db.select().from(dialogues).where(eq(dialogues.timelineId, timelineId)),
    db.select().from(dialogueTurns),
    db.select().from(personaMessages).where(and(eq(personaMessages.worldId, worldId), eq(personaMessages.timelineId, timelineId))),
    db.select().from(worldFacts).where(eq(worldFacts.timelineId, timelineId)).orderBy(asc(worldFacts.version)),
  ])
  const timeline = (await hydrateTimelines(db, timelineRows))[0] ?? null
  const revision = revisionRows[0] ?? null
  const checkpoint = timeline ? readForkSnapshot(timeline) : null
  const mergeById = <T extends { id: string }>(baseline: T[] | undefined, own: T[]): T[] =>
    [...new Map([...(baseline ?? []), ...own].map(row => [row.id, row])).values()]
  const memoryProjection = timeline?.parentTimelineId
    ? mergeById(checkpoint?.memories, memoryRows.filter(row => row.timelineId === timelineId))
    : memoryRows.filter(row => row.timelineId === null || row.timelineId === timelineId)
  const dialogueProjection = timeline?.parentTimelineId
    ? mergeById(checkpoint?.dialogues, dialogueRows)
    : dialogueRows
  const dialoguesById = new Set(dialogueProjection.map(row => row.id))
  const turnProjection = timeline?.parentTimelineId
    ? mergeById(checkpoint?.dialogueTurns, turnRows.filter(row => dialoguesById.has(row.dialogueId)))
    : turnRows.filter(row => dialoguesById.has(row.dialogueId))
  return {
    worldId,
    timelineId,
    rows: {
      simTime: revision?.simTime ?? timeline?.simNow ?? '',
      states,
      schedules: scheduleRows,
      events: timeline?.parentTimelineId ? mergeById(checkpoint?.events, eventRows) : eventRows,
      commitments: commitmentRows,
      memories: memoryProjection,
      dialogues: dialogueProjection,
      dialogueTurns: turnProjection,
      personaMessages: timeline?.parentTimelineId ? mergeById(checkpoint?.personaMessages, messageRows) : messageRows,
      knowledge: [
        ...(checkpoint?.worldFacts ?? []),
        ...facts,
      ].filter(fact => fact.factType === 'knowledge'),
    },
  }
}
