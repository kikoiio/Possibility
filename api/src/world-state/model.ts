import type { Db } from '../db/client'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { commitments, dialogueTurns, dialogues, events, memories, personaMessages, personStates, schedules, worldFacts } from '../db/schema'
import { events as eventsTable, persons, timelines, universeRevisions, worldModelVersions, worldPersons, worlds } from '../db/schema'
import { WorldStateError } from './types'

export const PROJECTION_DOMAINS = [
  'clock', 'states', 'schedules', 'events', 'commitments', 'memories',
  'dialogues', 'dialogueTurns', 'personaMessages', 'knowledge',
] as const

export type ProjectionDomain = typeof PROJECTION_DOMAINS[number]

/** The versioned, comparable view of one timeline at a particular revision. */
export interface ProjectionRows {
  simTime: string
  states: (typeof personStates.$inferSelect)[]
  schedules: (typeof schedules.$inferSelect)[]
  events: (typeof events.$inferSelect)[]
  commitments: (typeof commitments.$inferSelect)[]
  memories: (typeof memories.$inferSelect)[]
  dialogues: (typeof dialogues.$inferSelect)[]
  dialogueTurns: (typeof dialogueTurns.$inferSelect)[]
  personaMessages: (typeof personaMessages.$inferSelect)[]
  /** Timeline-visible knowledge derived from immutable facts; it is not a stored projection table. */
  knowledge: (typeof worldFacts.$inferSelect)[]
}

/** An immutable replay starting point. Missing domains are unproven; an empty listed domain is complete. */
export interface ProjectionBaseline {
  source: 'root' | 'fork'
  version: number
  capturedAt: string
  simTime: string
  completeDomains: ProjectionDomain[]
  rows: Partial<Omit<ProjectionRows, 'simTime' | 'knowledge'>>
}

export function createRootProjectionBaseline(
  capturedAt: string,
  simTime: string,
  states: ProjectionRows['states'],
): ProjectionBaseline {
  return {
    source: 'root',
    version: 0,
    capturedAt,
    simTime,
    completeDomains: [...PROJECTION_DOMAINS],
    rows: {
      states: [...states],
      schedules: [],
      events: [],
      commitments: [],
      memories: [],
      dialogues: [],
      dialogueTurns: [],
      personaMessages: [],
    },
  }
}

export interface PinnedWorldModel {
  name: string
  description: string
  locations: { name: string; description: string }[]
  residents: { id: string; name: string; model: unknown }[]
  /** Exact initial projection for new timelines; absent on legacy model snapshots. */
  initialStates?: { capturedAt: string; states: {
    personId: string; simTime: string; location: string; activity: string; mood: string; goal: string;
    lastBeatSimTime: string | null; currentDialogueId: string | null;
  }[] }
  /** Event IDs already present at the exact baseline, distinct from later command-backed events. */
  initialEvents?: { timelineId: string; eventIds: string[] }
  /** Full immutable projection evidence; absent on legacy model snapshots. */
  projectionBaseline?: ProjectionBaseline
}

/** A revision may only use a complete immutable world definition, never a falsy or partial JSON value. */
export function parsePinnedWorldModel(json: string): PinnedWorldModel {
  let parsed: unknown
  try { parsed = JSON.parse(json) as unknown } catch { /* handled below */ }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorldStateError('宇宙固定设定内容损坏', 409)
  }
  const model = parsed as Record<string, unknown>
  if (typeof model.name !== 'string' || typeof model.description !== 'string'
    || !Array.isArray(model.locations) || !Array.isArray(model.residents)) {
    throw new WorldStateError('宇宙固定设定内容不完整', 409)
  }
  return model as unknown as PinnedWorldModel
}

/** A timeline keeps the definition it was started/forked with, not mutable asset rows. */
export async function readPinnedWorldModel(db: Db, worldId: string, timelineId: string): Promise<PinnedWorldModel | null> {
  const revision = await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timelineId)).get()
  if (!revision) return null
  const row = await db.select().from(worldModelVersions).where(and(
    eq(worldModelVersions.worldId, worldId), eq(worldModelVersions.version, revision.worldModelVersion),
  )).get()
  if (!row) throw new WorldStateError('宇宙固定设定版本缺失；不能改用可编辑的人物或世界资料', 409)
  return parsePinnedWorldModel(row.modelJson)
}

/** Legacy worlds get an explicit version-1 baseline from their current definitions. */
export async function ensureWorldModel(db: Db, worldId: string) {
  const existing = await db.select().from(worldModelVersions)
    .where(and(eq(worldModelVersions.worldId, worldId), eq(worldModelVersions.version, 1))).get()
  if (existing) return existing
  const world = await db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  if (!world) throw new WorldStateError('世界不存在', 404)
  const members = await db.select().from(worldPersons).where(eq(worldPersons.worldId, worldId)).all()
  const residents = members.length
    ? await db.select().from(persons).where(inArray(persons.id, members.map(m => m.personId))).all()
    : []
  const mainTimeline = await db.select().from(timelines).where(and(
    eq(timelines.worldId, worldId), isNull(timelines.parentTimelineId),
  )).get()
  const capturedAt = new Date().toISOString()
  const initialEventRows = mainTimeline
    ? await db.select({ id: eventsTable.id }).from(eventsTable).where(eq(eventsTable.timelineId, mainTimeline.id)).all()
    : []
  const model = {
    name: world.name,
    description: world.description,
    locations: JSON.parse(world.locationsJson || '[]') as unknown,
    residents: residents.map(p => ({ id: p.id, name: p.name, model: JSON.parse(p.modelJson || '{}') as unknown })),
    ...(mainTimeline ? {
      initialEvents: { timelineId: mainTimeline.id, eventIds: initialEventRows.map(event => event.id) },
    } : {}),
  }
  await db.insert(worldModelVersions).values({ worldId, version: 1, modelJson: JSON.stringify(model), createdAt: capturedAt }).onConflictDoNothing()
  return (await db.select().from(worldModelVersions)
    .where(and(eq(worldModelVersions.worldId, worldId), eq(worldModelVersions.version, 1))).get())!
}

export async function ensureUniverseRevision(db: Db, worldId: string, timelineId: string) {
  const timeline = await db.select().from(timelines)
    .where(and(eq(timelines.id, timelineId), eq(timelines.worldId, worldId))).get()
  if (!timeline) throw new WorldStateError('时间线不存在', 404)
  let revision = await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timelineId)).get()
  if (revision) return revision
  await ensureWorldModel(db, worldId)
  const now = new Date().toISOString()
  await db.insert(universeRevisions).values({ timelineId, version: 0, simTime: timeline.simNow, worldModelVersion: 1, updatedAt: now }).onConflictDoNothing()
  revision = await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timelineId)).get()
  if (!revision) throw new Error('无法初始化世界状态版本')
  return revision
}
