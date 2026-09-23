import { and, eq, exists, gt, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { engineTickLeases, personStates, timelines, worldCommands, worlds } from '../db/schema'
import { commitWorldCommand } from './commit'
import { ensureUniverseRevision } from './model'
import type { WorldAction } from './types'
import { WorldStateError } from './types'

/** Engine-facing move: versioned, idempotent by resulting location, no model call. */
export async function moveResident(db: Db, worldId: string, timelineId: string, personId: string, to: string) {
  const world = await db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  if (!world) throw new WorldStateError('世界不存在', 404)
  const timeline = await db.select().from(timelines)
    .where(and(eq(timelines.id, timelineId), eq(timelines.worldId, worldId))).get()
  if (!timeline) throw new WorldStateError('时间线不存在', 404)
  const current = await db.select().from(personStates)
    .where(and(eq(personStates.personId, personId), eq(personStates.timelineId, timelineId))).get()
  if (!current || current.location === to) return null
  for (let attempt = 0; attempt < 2; attempt++) {
    const revision = await ensureUniverseRevision(db, worldId, timelineId)
    try {
      return await commitWorldCommand(db, {
        id: crypto.randomUUID(), worldId, timelineId, userId: world.userId,
        actorKind: 'system', expectedVersion: revision.version,
        action: { type: 'move', personId, to },
      })
    } catch (error) {
      if (!(error instanceof WorldStateError) || error.status !== 409 || attempt === 1) throw error
      const after = await db.select().from(personStates)
        .where(and(eq(personStates.personId, personId), eq(personStates.timelineId, timelineId))).get()
      if (after?.location === to) return null
    }
  }
  return null
}

/** Engine-generated schedule/beat outcomes use the same atomic fact boundary as visitor actions. */
export async function recordResidentState(db: Db, p: {
  worldId: string
  timelineId: string
  sourceKey: string
  engineTickLeaseToken?: string
  action: Extract<WorldAction, { type: 'resident_state' }>
}) {
  const world = await db.select().from(worlds).where(eq(worlds.id, p.worldId)).get()
  if (!world) throw new WorldStateError('世界不存在', 404)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.sourceKey))
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const id = `system:${hash}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await db.select().from(worldCommands).where(eq(worldCommands.id, id)).get()
    const revision = await ensureUniverseRevision(db, p.worldId, p.timelineId)
    try {
      return await commitWorldCommand(db, {
        id, worldId: p.worldId, timelineId: p.timelineId, userId: world.userId, actorKind: 'system',
        expectedVersion: existing?.expectedVersion ?? revision.version, engineTickLeaseToken: p.engineTickLeaseToken, action: p.action,
      })
    } catch (error) {
      if (!(error instanceof WorldStateError) || error.status !== 409 || existing || attempt === 2) throw error
    }
  }
  throw new WorldStateError('居民状态竞争过多，请稍后重试', 409)
}

/** Real elapsed time changes the observable Universe clock, so commit it as a fact. */
export async function advanceWorldClock(db: Db, p: {
  worldId: string
  timelineId: string
  observedAt: Date
  worldSpeed: number
  maxElapsedSeconds: number
  engineTickLeaseToken?: string
}): Promise<string> {
  if (!Number.isFinite(p.worldSpeed) || p.worldSpeed < 0 || !Number.isFinite(p.maxElapsedSeconds) || p.maxElapsedSeconds <= 0) {
    throw new WorldStateError('世界时钟配置无效', 400)
  }
  const world = await db.select().from(worlds).where(eq(worlds.id, p.worldId)).get()
  if (!world) throw new WorldStateError('世界不存在', 404)
  for (let attempt = 0; attempt < 4; attempt++) {
    const timeline = await db.select().from(timelines).where(and(
      eq(timelines.id, p.timelineId), eq(timelines.worldId, p.worldId), eq(timelines.status, 'active'),
    )).get()
    if (!timeline) throw new WorldStateError('时间线不存在或已归档', 404)
    const observedAt = p.observedAt.toISOString()
    if (!timeline.lastRealTickAt) {
      await db.update(timelines).set({ lastRealTickAt: observedAt }).where(and(
        eq(timelines.id, timeline.id), eq(timelines.simNow, timeline.simNow), isNull(timelines.lastRealTickAt),
        ...(p.engineTickLeaseToken ? [exists(db.select({ id: engineTickLeases.id }).from(engineTickLeases).where(and(
          eq(engineTickLeases.id, 'autonomous-world-tick'), eq(engineTickLeases.ownerToken, p.engineTickLeaseToken),
          gt(engineTickLeases.leaseUntil, Date.now()),
        )))] : []),
      ))
      const latest = await db.select().from(timelines).where(eq(timelines.id, timeline.id)).get()
      return latest?.simNow ?? timeline.simNow
    }
    const lastTickMs = Date.parse(timeline.lastRealTickAt)
    const observedMs = p.observedAt.getTime()
    if (!Number.isFinite(lastTickMs) || !Number.isFinite(observedMs)) throw new WorldStateError('时钟锚点无效', 400)
    const elapsedSeconds = Math.min(Math.max((observedMs - lastTickMs) / 1000, 0), p.maxElapsedSeconds)
    if (elapsedSeconds === 0 || p.worldSpeed === 0) {
      if (observedMs > lastTickMs) await db.update(timelines).set({ lastRealTickAt: observedAt }).where(and(
        eq(timelines.id, timeline.id), eq(timelines.simNow, timeline.simNow), eq(timelines.lastRealTickAt, timeline.lastRealTickAt),
        ...(p.engineTickLeaseToken ? [exists(db.select({ id: engineTickLeases.id }).from(engineTickLeases).where(and(
          eq(engineTickLeases.id, 'autonomous-world-tick'), eq(engineTickLeases.ownerToken, p.engineTickLeaseToken),
          gt(engineTickLeases.leaseUntil, Date.now()),
        )))] : []),
      ))
      const latest = await db.select().from(timelines).where(eq(timelines.id, timeline.id)).get()
      return latest?.simNow ?? timeline.simNow
    }
    const from = timeline.simNow
    const to = new Date(Date.parse(from) + elapsedSeconds * 1000 * p.worldSpeed).toISOString()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${timeline.id}:${from}:${to}:${observedAt}`))
    const id = `system:clock:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
    const revision = await ensureUniverseRevision(db, world.id, timeline.id)
    try {
      await commitWorldCommand(db, {
        id, worldId: world.id, timelineId: timeline.id, userId: world.userId,
        actorKind: 'system', expectedVersion: revision.version, engineTickLeaseToken: p.engineTickLeaseToken,
        action: { type: 'clock_advance', from, to, observedAt },
      })
      return to
    } catch (error) {
      if (!(error instanceof WorldStateError) || error.status !== 409 || attempt === 3) throw error
    }
  }
  const latest = await db.select().from(timelines).where(eq(timelines.id, p.timelineId)).get()
  return latest?.simNow ?? ''
}

/** Idempotently records an engine cursor without publishing it as a resident action. */
export async function recordSimulationCheckpoint(db: Db, p: {
  worldId: string
  timelineId: string
  sourceKey: string
  personId: string
  lastBeatSimTime: string
  engineTickLeaseToken?: string
}) {
  const world = await db.select().from(worlds).where(eq(worlds.id, p.worldId)).get()
  if (!world) throw new WorldStateError('世界不存在', 404)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.sourceKey))
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const id = `system:checkpoint:${hash}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await db.select().from(worldCommands).where(eq(worldCommands.id, id)).get()
    const revision = await ensureUniverseRevision(db, p.worldId, p.timelineId)
    try {
      return await commitWorldCommand(db, {
        id, worldId: p.worldId, timelineId: p.timelineId, userId: world.userId, actorKind: 'system',
        expectedVersion: existing?.expectedVersion ?? revision.version, engineTickLeaseToken: p.engineTickLeaseToken,
        action: { type: 'simulation_checkpoint', personId: p.personId, lastBeatSimTime: p.lastBeatSimTime },
      })
    } catch (error) {
      if (!(error instanceof WorldStateError) || error.status !== 409 || existing || attempt === 2) throw error
    }
  }
  throw new WorldStateError('模拟检查点竞争过多，请稍后重试', 409)
}

/** Clears only a confirmed stale dialogue lock and records that recovery privately. */
export async function recoverDialogueLock(db: Db, p: {
  worldId: string
  timelineId: string
  sourceKey: string
  personId: string
  dialogueId: string
  engineTickLeaseToken?: string
}): Promise<Awaited<ReturnType<typeof commitWorldCommand>> | null> {
  const world = await db.select().from(worlds).where(eq(worlds.id, p.worldId)).get()
  if (!world) throw new WorldStateError('世界不存在', 404)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.sourceKey))
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const id = `system:dialogue-recovery:${hash}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await db.select().from(worldCommands).where(eq(worldCommands.id, id)).get()
    const revision = await ensureUniverseRevision(db, p.worldId, p.timelineId)
    try {
      return await commitWorldCommand(db, {
        id, worldId: p.worldId, timelineId: p.timelineId, userId: world.userId, actorKind: 'system',
        expectedVersion: existing?.expectedVersion ?? revision.version, engineTickLeaseToken: p.engineTickLeaseToken,
        action: { type: 'dialogue_recovery', personId: p.personId, dialogueId: p.dialogueId },
      })
    } catch (error) {
      const state = await db.select().from(personStates).where(and(
        eq(personStates.personId, p.personId), eq(personStates.timelineId, p.timelineId),
      )).get()
      if (state?.currentDialogueId !== p.dialogueId) return null
      if (error instanceof WorldStateError && (error.status !== 409 || existing || attempt === 2)) throw error
      if (attempt === 2) throw error
    }
  }
  return null
}

/** Compresses one resident's private memory batch with an immutable source fact and atomic projection. */
export async function recordMemorySummary(db: Db, p: {
  worldId: string
  timelineId: string
  personId: string
  sourceMemoryIds: string[]
  content: string
  importance: number
  simTime: string
  createdAt: string
  engineTickLeaseToken?: string
}) {
  const world = await db.select().from(worlds).where(eq(worlds.id, p.worldId)).get()
  if (!world) throw new WorldStateError('世界不存在', 404)
  const sourceKey = `${p.timelineId}:${p.personId}:${p.sourceMemoryIds.join(',')}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceKey))
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const action: Extract<WorldAction, { type: 'memory_summary' }> = {
    type: 'memory_summary', personId: p.personId, sourceMemoryIds: p.sourceMemoryIds,
    summaryId: `summary:${hash}`, content: p.content, importance: p.importance, simTime: p.simTime, createdAt: p.createdAt,
  }
  const id = `system:memory-summary:${hash}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await db.select().from(worldCommands).where(eq(worldCommands.id, id)).get()
    const revision = await ensureUniverseRevision(db, p.worldId, p.timelineId)
    try {
      return await commitWorldCommand(db, { id, worldId: p.worldId, timelineId: p.timelineId, userId: world.userId,
      actorKind: 'system', expectedVersion: existing?.expectedVersion ?? revision.version,
      engineTickLeaseToken: p.engineTickLeaseToken, action })
    } catch (error) {
      if (!(error instanceof WorldStateError) || error.status !== 409 || existing || attempt === 2) throw error
    }
  }
  throw new WorldStateError('记忆摘要提交竞争过多，请稍后重试', 409)
}

/** NPC dialogue turns become public, attributable facts; private thought/memory is written atomically. */
export async function recordDialogueTurn(db: Db, p: {
  worldId: string
  timelineId: string
  sourceKey: string
  action: Extract<WorldAction, { type: 'dialogue_turn' }>
  engineTickLeaseToken?: string
}) {
  const world = await db.select().from(worlds).where(eq(worlds.id, p.worldId)).get()
  if (!world) throw new WorldStateError('世界不存在', 404)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.sourceKey))
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const id = `system:${hash}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await db.select().from(worldCommands).where(eq(worldCommands.id, id)).get()
    const revision = await ensureUniverseRevision(db, p.worldId, p.timelineId)
    try {
      return await commitWorldCommand(db, {
        id, worldId: p.worldId, timelineId: p.timelineId, userId: world.userId, actorKind: 'system',
        expectedVersion: existing?.expectedVersion ?? revision.version, engineTickLeaseToken: p.engineTickLeaseToken, action: p.action,
      })
    } catch (error) {
      if (!(error instanceof WorldStateError) || error.status !== 409 || existing || attempt === 2) throw error
    }
  }
  throw new WorldStateError('居民交谈竞争过多，请稍后重试', 409)
}

/** Creating an NPC encounter, occupying both residents, and publishing its event is one commit. */
export async function startNpcDialogue(db: Db, p: {
  worldId: string
  timelineId: string
  sourceKey: string
  participantIds: string[]
  location: string
  turnLimit: number
  engineTickLeaseToken?: string
}) {
  const world = await db.select().from(worlds).where(eq(worlds.id, p.worldId)).get()
  if (!world) throw new WorldStateError('世界不存在', 404)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.sourceKey))
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const id = `system:${hash}`
  const dialogueId = `dialogue:${hash}`
  const action: Extract<WorldAction, { type: 'dialogue_start' }> = {
    type: 'dialogue_start', dialogueId, participantIds: p.participantIds, location: p.location, turnLimit: p.turnLimit,
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await db.select().from(worldCommands).where(eq(worldCommands.id, id)).get()
    const revision = await ensureUniverseRevision(db, p.worldId, p.timelineId)
    try {
      return await commitWorldCommand(db, { id, worldId: p.worldId, timelineId: p.timelineId, userId: world.userId,
        actorKind: 'system', expectedVersion: existing?.expectedVersion ?? revision.version,
        engineTickLeaseToken: p.engineTickLeaseToken, action })
    } catch (error) {
      if (!(error instanceof WorldStateError) || error.status !== 409 || existing || attempt === 2) throw error
    }
  }
  throw new WorldStateError('居民交谈竞争过多，请稍后重试', 409)
}
