import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import { commitments, dialogueTurns, dialogues, events, memories, personaMessages, personStates, schedules, timelines, universeRevisions, worldFacts, worldModelVersions, worldPersons, worlds } from '../db/schema'
import { ancestorCutoffs, readForkSnapshot, selectVisibleEvents, selectVisibleMemories, type ForkSnapshot } from '../agent/visibility'
import type { ForkScenario } from '../agent/types'
import { ensureUniverseRevision, PROJECTION_DOMAINS, type ProjectionDomain } from '../world-state/model'
import { WorldStateError } from '../world-state/types'

function databaseErrorMessages(error: unknown): string[] {
  const messages: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 20 && current; depth++) {
    if (current instanceof Error) {
      messages.push(current.message)
      current = (current as Error & { cause?: unknown }).cause
    } else {
      messages.push(String(current))
      break
    }
  }
  return messages
}

export function forkConflict(error: unknown, busyMessage = '分叉过程中数据库正忙；请刷新源时间线后重试。'): WorldStateError | null {
  const message = databaseErrorMessages(error).join('\n')
  if (message.includes('SQLITE_BUSY') || message.includes('SQLITE_LOCKED')
    || message.includes('D1_ERROR: Failed to parse body as JSON, got: Error: internal error;')) {
    return new WorldStateError(busyMessage, 409)
  }
  if (message.includes('active_timeline_limit')) {
    return new WorldStateError('活跃时间线已达上限（3 条），请先归档一条', 409)
  }
  if (['fork_source_state_conflict', 'fork_source_version_conflict', 'fork_source_schedule_conflict'].some(marker => message.includes(marker))) {
    return new WorldStateError('源宇宙在创建分叉前已变化；请刷新当前状态后重试。', 409)
  }
  return null
}

/** Read a consistent source snapshot, then atomically persist the child and all copied rows. */
export async function forkTimeline(db: Db, worldId: string, sourceId: string, scenario: ForkScenario | null = null, requestId?: string) {
  if (requestId && (requestId.length > 100 || !requestId.trim())) throw new Error('分叉请求 ID 无效')
  const replay = async () => {
    if (!requestId) return null
    const prior = await db.select().from(timelines).where(eq(timelines.id, requestId)).get()
    if (!prior) return null
    const priorSnapshot = readForkSnapshot(prior)
    if (prior.worldId !== worldId || prior.parentTimelineId !== sourceId || prior.forkScenarioJson !== (scenario ? JSON.stringify(scenario) : null) || !priorSnapshot) {
      throw new Error('分叉请求 ID 已用于另一条时间线')
    }
    return { id: prior.id, simNow: prior.simNow, snapshot: priorSnapshot }
  }
  const existing = await replay()
  if (existing) return existing
  const world = await db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  if (!world || world.status !== 'running') throw new Error('世界未运行，不能分叉')
  await ensureUniverseRevision(db, worldId, sourceId)
  const worldTimelineIds = db.select({ id: timelines.id }).from(timelines).where(eq(timelines.worldId, worldId))
  const [worldTimelines, states, scheduleRows, memoryRows, eventRows, dialogueRows, transcriptRows, commitmentRows, sourceRevisions, sourceFacts, personaMessageRows] = await db.batch([
    db.select().from(timelines).where(eq(timelines.worldId, worldId)),
    db.select().from(personStates).where(eq(personStates.timelineId, sourceId)),
    db.select().from(schedules).where(eq(schedules.timelineId, sourceId)),
    db.select().from(memories).where(and(
      inArray(memories.personId, db.select({ id: worldPersons.personId }).from(worldPersons).where(eq(worldPersons.worldId, worldId))),
      or(isNull(memories.timelineId), inArray(memories.timelineId, worldTimelineIds)),
    )),
    db.select().from(events).where(inArray(events.timelineId, worldTimelineIds)),
    db.select().from(dialogues).where(inArray(dialogues.timelineId, worldTimelineIds)),
    db.select().from(dialogueTurns).where(inArray(dialogueTurns.dialogueId,
      db.select({ id: dialogues.id }).from(dialogues).where(inArray(dialogues.timelineId, worldTimelineIds)))),
    db.select().from(commitments).where(and(eq(commitments.worldId, worldId), eq(commitments.timelineId, sourceId))),
    db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, sourceId)),
    db.select().from(worldFacts).where(eq(worldFacts.timelineId, sourceId)),
    db.select().from(personaMessages).where(inArray(personaMessages.timelineId, worldTimelineIds)),
  ])
  const source = worldTimelines.find((t) => t.id === sourceId)
  if (!source || source.status !== 'active') throw new Error('只能分叉活跃时间线')
  if (worldTimelines.filter((t) => t.status === 'active').length >= 3) throw new Error('活跃时间线已达上限（3 条）')
  // A historical scenario is not a historical state snapshot; never relabel today's state as the past.
  if (scenario && Date.parse(scenario.startTime) !== Date.parse(source.simNow)) {
    throw new Error('历史状态快照不可用，请以当前时间线时间创建分叉')
  }
  const sourceRevision = sourceRevisions[0]
  if (!sourceRevision) throw new Error('分叉源状态版本不可用')
  const sourceModel = await db.select().from(worldModelVersions).where(and(
    eq(worldModelVersions.worldId, worldId), eq(worldModelVersions.version, sourceRevision.worldModelVersion),
  )).get()
  const now = new Date().toISOString()
  const forkId = requestId ?? crypto.randomUUID()
  const memberships = states.length ? await db.select().from(worldPersons)
    .where(inArray(worldPersons.personId, states.map(s => s.personId))).all() : []
  const membershipCounts = new Map<string, Set<string>>()
  for (const row of memberships) membershipCounts.set(row.personId, (membershipCounts.get(row.personId) ?? new Set<string>()).add(row.worldId))
  const sharedPersonIds = new Set([...membershipCounts].filter(([, ids]) => ids.size > 1).map(([id]) => id))
  const inherited = selectVisibleEvents(eventRows, source, worldTimelines)
  const inheritedDialogueIds = new Set(inherited.events.map(event => event.dialogueId).filter((id): id is string => id !== null))
  const sourceCheckpoint = readForkSnapshot(source)
  const frozenDialogueById = new Map((sourceCheckpoint?.dialogues ?? []).map(dialogue => [dialogue.id, dialogue]))
  const frozenTurnsByDialogue = new Map<string, typeof transcriptRows>()
  for (const turn of sourceCheckpoint?.dialogueTurns ?? []) {
    frozenTurnsByDialogue.set(turn.dialogueId, [...(frozenTurnsByDialogue.get(turn.dialogueId) ?? []), turn])
  }
  const visibleDialogueRows = dialogueRows.filter(dialogue => inheritedDialogueIds.has(dialogue.id))
  const checkpointDialogues = visibleDialogueRows.flatMap(dialogue => {
    if (dialogue.timelineId === source.id) return [dialogue]
    // An older checkpoint without transcript data cannot be safely refreshed
    // from the mutable ancestor rows; omit it rather than leak later turns.
    return frozenDialogueById.has(dialogue.id) ? [frozenDialogueById.get(dialogue.id)!] : []
  })
  const checkpointDialogueIds = new Set(checkpointDialogues.map(dialogue => dialogue.id))
  const checkpointDialogueTurns = [...checkpointDialogueIds].flatMap(dialogueId => {
    const dialogue = checkpointDialogues.find(item => item.id === dialogueId)!
    return dialogue.timelineId === source.id
      ? transcriptRows.filter(turn => turn.dialogueId === dialogueId)
      : frozenTurnsByDialogue.get(dialogueId) ?? []
  })
  const cutoffs = ancestorCutoffs(source, worldTimelines)
  let modelDomains: ProjectionDomain[] = []
  try {
    const modelValue = sourceModel ? JSON.parse(sourceModel.modelJson) as { projectionBaseline?: { completeDomains?: unknown } } : null
    if (Array.isArray(modelValue?.projectionBaseline?.completeDomains)) {
      modelDomains = modelValue.projectionBaseline.completeDomains.filter((domain): domain is ProjectionDomain =>
        typeof domain === 'string' && (PROJECTION_DOMAINS as readonly string[]).includes(domain))
    }
  } catch { /* a malformed legacy model cannot prove projection completeness */ }
  const completeDomains = sourceCheckpoint?.completeDomains ?? modelDomains
  const visiblePersonaMessages = [...new Map([
    ...(sourceCheckpoint?.personaMessages ?? []),
    ...personaMessageRows.filter(message => message.timelineId === source.id),
  ].map(message => [message.id, message])).values()]
  const copiedSchedules = scheduleRows.filter((s) => s.worldDate >= source.simNow.slice(0, 10))
  const snapshot: ForkSnapshot = {
    version: 1, sourceTimelineId: source.id, sourceSimTime: source.simNow, capturedAt: now,
    ancestorCutoffs: [{ timelineId: source.id, realTime: now, simTime: source.simNow }, ...cutoffs],
    states, schedules: copiedSchedules, commitments: commitmentRows,
    memories: [...new Set([...states.map((s) => s.personId), ...memoryRows.map((m) => m.personId)])]
      .flatMap((personId) => selectVisibleMemories(memoryRows, personId, source, worldTimelines))
      .filter(m => m.timelineId !== null || !sharedPersonIds.has(m.personId)),
    events: inherited.events, historyComplete: inherited.historyComplete,
    dialogues: checkpointDialogues, dialogueTurns: checkpointDialogueTurns,
    personaMessages: visiblePersonaMessages, completeDomains: [...completeDomains],
    sourceStateVersion: sourceRevision.version,
    worldModelVersion: sourceRevision.worldModelVersion,
    worldFacts: [...(readForkSnapshot(source)?.worldFacts ?? []), ...sourceFacts],
  }
  const insertTimeline = db.insert(timelines).values({
    id: forkId, worldId, parentTimelineId: source.id,
    forkScenarioJson: scenario ? JSON.stringify(scenario) : null,
    forkSnapshotJson: JSON.stringify(snapshot), simNow: source.simNow, createdAt: now,
    status: 'active', ancestorIdsJson: JSON.stringify([...cutoffs.map((a) => a.timelineId).reverse(), source.id]),
    lastRealTickAt: now,
  })
  try { await db.batch([
    insertTimeline,
    db.insert(universeRevisions).values({ timelineId: forkId, version: 0, simTime: source.simNow,
      worldModelVersion: sourceRevision.worldModelVersion, updatedAt: now }),
    ...states.map((s) => db.insert(personStates).values({
      ...s, timelineId: forkId, currentDialogueId: null, updatedRealAt: now,
    })),
    ...copiedSchedules.map((s) => db.insert(schedules).values({ ...s, timelineId: forkId })),
    ...commitmentRows.filter((c) => c.status === 'proposed' || c.status === 'accepted')
      .map((c) => db.insert(commitments).values({ ...c, id: crypto.randomUUID(), timelineId: forkId })),
  ]) } catch (error) {
    const committed = await replay()
    if (committed) return committed
    const conflict = forkConflict(error)
    if (conflict) throw conflict
    throw error
  }
  return { id: forkId, simNow: source.simNow, snapshot }
}
