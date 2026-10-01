import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { timelines, universeEvidence, universeRevisions, worldCommands, worldFacts, worldModelVersions } from '../db/schema'
import { readForkSnapshot } from '../agent/visibility'
import { hydrateTimelines } from '../life/snapshot-store'
import { WorldStateError } from './types'
import { publicUniverseEvidence } from './evidence-status'

export async function readWorldState(db: Db, worldId: string, timelineId: string) {
  const timelineRow = await db.select().from(timelines)
    .where(and(eq(timelines.id, timelineId), eq(timelines.worldId, worldId))).get()
  if (!timelineRow) throw new WorldStateError('时间线不存在', 404)
  const timeline = (await hydrateTimelines(db, [timelineRow]))[0]
  const revision = await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timelineId)).get()
  const evidenceRow = await db.select().from(universeEvidence).where(eq(universeEvidence.timelineId, timelineId)).get()
  const model = revision ? await db.select().from(worldModelVersions)
    .where(and(eq(worldModelVersions.worldId, worldId), eq(worldModelVersions.version, revision.worldModelVersion))).get() : null
  const facts = await db.select().from(worldFacts).where(eq(worldFacts.timelineId, timelineId))
    .orderBy(asc(worldFacts.version)).all()
  const forkSnapshot = readForkSnapshot(timeline)
  const inherited = forkSnapshot?.worldFacts ?? []
  const allFacts = [...inherited, ...facts]
  const current = new Map<string, typeof facts[number]>()
  for (const fact of allFacts) current.set(`${fact.factType}:${fact.subjectId}`, fact)
  return {
    timelineId,
    version: revision?.version ?? 0,
    worldModelVersion: revision?.worldModelVersion ?? null,
    evidenceStatus: !revision || (timeline.parentTimelineId && forkSnapshot?.sourceStateVersion == null)
      ? 'legacy' as const : 'structured' as const,
    evidence: publicUniverseEvidence(evidenceRow),
    model: model ? JSON.parse(model.modelJson) as unknown : null,
    facts: allFacts.map(f => ({ ...f, value: JSON.parse(f.valueJson) as unknown })),
    current: [...current.values()].map(f => ({ ...f, value: JSON.parse(f.valueJson) as unknown })),
  }
}

export async function readCommandResult(db: Db, id: string) {
  return db.select().from(worldCommands).where(eq(worldCommands.id, id)).get()
}
