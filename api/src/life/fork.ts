import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../db/client'
import { commitments, dialogueTurns, dialogues, events, memories, personaMessages, personStates, schedules, timelines, universeEvidence, universeRevisions, voxelEventProjections, worldCommands, worldFacts, worldModelVersions, worldPersons, worlds } from '../db/schema'
import { ancestorCutoffs, readForkSnapshot, selectVisibleEvents, selectVisibleMemories, type ForkSnapshot } from '../agent/visibility'
import { hydrateTimelines, SNAPSHOT_REF_JSON, writeForkSnapshot } from './snapshot-store'
import type { ForkScenario } from '../agent/types'
import { ensureUniverseRevision, PROJECTION_DOMAINS, type ProjectionDomain } from '../world-state/model'
import { reconstructAt, type Reconstruction } from '../world-state/reconstruct'
import { WorldStateError } from '../world-state/types'
import { gateUniverseWrite } from '../engine/guard'
import { forkActionSummary, type PreparedForkAction } from './fork-action'

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
  if (['fork_source_state_conflict', 'fork_source_version_conflict', 'fork_source_schedule_conflict', 'fork_source_version_guard'].some(marker => message.includes(marker))) {
    return new WorldStateError('源宇宙在创建分叉前已变化；请刷新当前状态后重试。', 409)
  }
  return null
}

export interface ForkTimelineOptions {
  expectedSourceVersion?: number
  initialAction?: PreparedForkAction
}

export interface ForkActionReceipt {
  commandId: string
  factId: string
  version: number
  summary: string
}

/** Read a consistent source snapshot, then atomically persist the child and all copied rows. */
export async function forkTimeline(
  db: Db,
  worldId: string,
  sourceId: string,
  scenario: ForkScenario | null = null,
  requestId?: string,
  options: ForkTimelineOptions = {},
) {
  if (requestId && (requestId.length > 100 || !requestId.trim())) throw new Error('分叉请求 ID 无效')
  const replay = async () => {
    if (!requestId) return null
    const prior = await db.select().from(timelines).where(eq(timelines.id, requestId)).get()
    if (!prior) return null
    const priorSnapshot = readForkSnapshot((await hydrateTimelines(db, [prior]))[0])
    if (prior.worldId !== worldId || prior.parentTimelineId !== sourceId || prior.forkScenarioJson !== (scenario ? JSON.stringify(scenario) : null) || !priorSnapshot) {
      throw new Error('分叉请求 ID 已用于另一条时间线')
    }
    const actionCommandId = `fork:${prior.id}:initial`
    const priorActionCommand = await db.select().from(worldCommands).where(eq(worldCommands.id, actionCommandId)).get()
    const expectedPayload = options.initialAction ? JSON.stringify(options.initialAction.action) : null
    if ((priorActionCommand?.payloadJson ?? null) !== expectedPayload) {
      throw new Error('分叉请求 ID 已用于另一条时间线或不同初始动作')
    }
    if (!options.initialAction) return { id: prior.id, simNow: prior.simNow, snapshot: priorSnapshot }
    const priorFact = await db.select().from(worldFacts).where(eq(worldFacts.sourceCommandId, actionCommandId)).get()
    if (!priorFact) throw new Error('分叉动作回执不存在')
    return { id: prior.id, simNow: prior.simNow, snapshot: priorSnapshot,
      action: { commandId: actionCommandId, factId: priorFact.id, version: priorFact.version,
        summary: forkActionSummary(options.initialAction.action) } satisfies ForkActionReceipt }
  }
  const existing = await replay()
  if (existing) return existing
  const selectedSource = await db.select().from(timelines).where(and(
    eq(timelines.id, sourceId), eq(timelines.worldId, worldId),
  )).get()
  if (!selectedSource || selectedSource.status !== 'active') throw new Error('只能分叉活跃时间线')
  const writeGate = await gateUniverseWrite(db, worldId, sourceId)
  const world = await db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  const pausedInitialization = !!options.initialAction && world?.status === 'paused'
    && !writeGate.ok && writeGate.error.includes('已暂停')
  if (!writeGate.ok && !pausedInitialization) throw new WorldStateError(writeGate.error, writeGate.status === 404 ? 404 : 409)
  if (!world || (world.status !== 'running' && !(options.initialAction && world.status === 'paused'))) throw new Error('世界未运行，不能分叉')
  await ensureUniverseRevision(db, worldId, sourceId)
  const worldTimelineIds = db.select({ id: timelines.id }).from(timelines).where(eq(timelines.worldId, worldId))
  const [worldTimelinesRaw, states, scheduleRows, memoryRows, eventRows, dialogueRows, transcriptRows, commitmentRows, sourceRevisions, sourceFacts, personaMessageRows, sourceVoxelEvents] = await db.batch([
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
    // S4:体素事件投影(派生数据;历史路径由重建水位过滤替代)
    db.select().from(voxelEventProjections).where(eq(voxelEventProjections.timelineId, sourceId)),
  ])
  // 快照正文外置(F4):水合一次,下游 visibility 链路全部走回填后的行
  const worldTimelines = await hydrateTimelines(db, worldTimelinesRaw)
  const source = worldTimelines.find((t) => t.id === sourceId)
  if (!source || source.status !== 'active') throw new Error('只能分叉活跃时间线')
  if (worldTimelines.filter((t) => t.status === 'active').length >= 3) throw new Error('活跃时间线已达上限（3 条）')
  // S4/F6:startTime 等于源 simNow → 既有实况拷贝路径;否则 → 历史重建路径。
  // 不可变命令日志无竞争,历史路径不做源线版本冲突预检。
  let reconstruction: Reconstruction | null = null
  if (scenario && Date.parse(scenario.startTime) !== Date.parse(source.simNow)) {
    const result = await reconstructAt(db, worldId, source.id, scenario.startTime)
    if (!result.ok) {
      const status = result.reasonCode === 'future_time' || result.reasonCode === 'before_history_start' ? 400 : 409
      throw new WorldStateError(result.message, status)
    }
    reconstruction = result
  }
  const forkSimTime = reconstruction?.simTime ?? source.simNow
  const sourceRevision = sourceRevisions[0]
  if (!sourceRevision) throw new Error('分叉源状态版本不可用')
  if (options.expectedSourceVersion !== undefined
    && (!Number.isSafeInteger(options.expectedSourceVersion) || options.expectedSourceVersion < 0
      || sourceRevision.version !== options.expectedSourceVersion)) {
    throw new WorldStateError('源宇宙在创建分叉前已变化；请刷新当前状态后重试。', 409)
  }
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
  const copiedSchedules = (reconstruction?.rows.schedules ?? scheduleRows)
    .filter((s) => s.worldDate >= forkSimTime.slice(0, 10))
  const commitmentPool = reconstruction?.rows.commitments ?? commitmentRows
  // Persist the exact child IDs inside its immutable checkpoint. Reconstructing
  // them later from source commitments would otherwise be impossible.
  const copiedCommitments = commitmentPool.filter((commitment) => commitment.status === 'proposed' || commitment.status === 'accepted')
    .map((commitment) => ({ ...commitment, id: `fork:${forkId}:${commitment.id}`, timelineId: forkId }))
  // S4:体素事件投影物化给子线——id 重命名到子线命名空间(重蒸馏 upsert 同键命中),
  // 版本水位 0(对子线而言在分叉点即存在,同继承日程纪律);子线 bootstrap 即刻可见事件
  const copiedVoxelEvents = (reconstruction?.rows.voxelEvents ?? sourceVoxelEvents)
    .map((row) => ({
      ...row,
      id: `vep:${forkId}:${row.id.split(':').slice(2).join(':')}`,
      timelineId: forkId,
      createdVersion: 0,
    }))
  const snapshot: ForkSnapshot = {
    version: 1, sourceTimelineId: source.id, sourceSimTime: forkSimTime, capturedAt: now,
    ancestorCutoffs: [{ timelineId: source.id, realTime: now, simTime: forkSimTime }, ...cutoffs],
    states: reconstruction?.rows.states ?? states, schedules: copiedSchedules,
    commitments: commitmentPool, projectedCommitments: copiedCommitments,
    memories: reconstruction?.rows.memories ?? [...new Set([...states.map((s) => s.personId), ...memoryRows.map((m) => m.personId)])]
      .flatMap((personId) => selectVisibleMemories(memoryRows, personId, source, worldTimelines))
      .filter(m => m.timelineId !== null || !sharedPersonIds.has(m.personId)),
    events: reconstruction?.rows.events ?? inherited.events,
    historyComplete: reconstruction ? true : inherited.historyComplete,
    dialogues: reconstruction?.rows.dialogues ?? checkpointDialogues,
    dialogueTurns: reconstruction?.rows.dialogueTurns ?? checkpointDialogueTurns,
    personaMessages: reconstruction?.rows.personaMessages ?? visiblePersonaMessages,
    completeDomains: reconstruction ? [...reconstruction.evidence.completeDomains] : [...completeDomains],
    sourceStateVersion: reconstruction?.evidence.throughVersion ?? sourceRevision.version,
    worldModelVersion: sourceRevision.worldModelVersion,
    worldFacts: reconstruction?.rows.worldFacts ?? [...(readForkSnapshot(source)?.worldFacts ?? []), ...sourceFacts],
    ...(reconstruction ? { reconstruction: reconstruction.evidence } : {}),
  }
  const preparedAction = options.initialAction
  const childVersion = preparedAction ? 1 : 0
  const childRevision = db.insert(universeRevisions).values({ timelineId: forkId, version: childVersion, simTime: forkSimTime,
    worldModelVersion: sourceRevision.worldModelVersion, updatedAt: now })
  const timelineValues = {
    id: forkId, worldId, parentTimelineId: source.id,
    forkScenarioJson: scenario ? JSON.stringify(scenario) : null,
    forkSnapshotJson: SNAPSHOT_REF_JSON, simNow: forkSimTime, createdAt: now,
    status: 'active' as const, ancestorIdsJson: JSON.stringify([...cutoffs.map((a) => a.timelineId).reverse(), source.id]),
    lastRealTickAt: now,
  }
  const insertTimeline = options.expectedSourceVersion === undefined
    ? db.insert(timelines).values(timelineValues)
    : db.insert(timelines).select(db.select({
        id: sql<string>`${timelineValues.id}`.as('id'),
        worldId: sql<string>`${timelineValues.worldId}`.as('world_id'),
        parentTimelineId: sql<string | null>`${timelineValues.parentTimelineId}`.as('parent_timeline_id'),
        forkScenarioJson: sql<string | null>`${timelineValues.forkScenarioJson}`.as('fork_scenario_json'),
        simNow: sql<string>`${timelineValues.simNow}`.as('sim_now'),
        createdAt: sql<string>`${timelineValues.createdAt}`.as('created_at'),
        status: sql<'active'>`${timelineValues.status}`.as('status'),
        ancestorIdsJson: sql<string>`${timelineValues.ancestorIdsJson}`.as('ancestor_ids_json'),
        lastRealTickAt: sql<string>`${timelineValues.lastRealTickAt}`.as('last_real_tick_at'),
        forkSnapshotJson: sql<string>`${timelineValues.forkSnapshotJson}`.as('fork_snapshot_json'),
      }).from(universeRevisions).innerJoin(timelines, eq(timelines.id, universeRevisions.timelineId)).where(and(
        eq(universeRevisions.timelineId, source.id), eq(universeRevisions.version, options.expectedSourceVersion),
        eq(timelines.id, source.id), eq(timelines.worldId, worldId), eq(timelines.status, 'active'),
      )))
  const actionCommandId = `fork:${forkId}:initial`
  const actionCommand = preparedAction ? db.insert(worldCommands).values({
    id: actionCommandId, worldId, timelineId: forkId, actorKind: 'owner', actorId: null,
    type: preparedAction.action.type, payloadJson: JSON.stringify(preparedAction.action),
    expectedVersion: 0, resultVersion: 1, tickLeaseToken: null, createdAt: now,
  }) : null
  const actionFactId = preparedAction ? crypto.randomUUID() : null
  const actionFact = preparedAction && actionFactId ? db.insert(worldFacts).values({
    id: actionFactId, timelineId: forkId, version: 1, simTime: forkSimTime,
    factType: preparedAction.plan.factType, subjectId: preparedAction.plan.subjectId,
    valueJson: JSON.stringify(preparedAction.plan.value), sourceCommandId: actionCommandId,
    visibility: preparedAction.plan.visibility,
  }) : null
  const actionEvent = preparedAction ? db.insert(events).values({
    id: preparedAction.plan.eventId ?? `command:${actionCommandId}`, timelineId: forkId,
    simTime: forkSimTime, title: preparedAction.plan.eventTitle,
    description: preparedAction.plan.eventDescription, kind: preparedAction.plan.eventKind ?? 'action',
    actorPersonId: null, dialogueId: null, createdVersion: 1,
  }) : null
  // Existing SQLite guards require a running world for child/command inserts.
  // Toggle only inside this atomic batch; observers see the original paused state
  // unless every fork and action write commits successfully.
  const pauseForInitialization = pausedInitialization
    ? db.update(worlds).set({ status: 'running' }).where(and(eq(worlds.id, worldId), eq(worlds.status, 'paused')))
    : null
  const restorePause = pausedInitialization
    ? db.update(worlds).set({ status: 'paused' }).where(and(eq(worlds.id, worldId), eq(worlds.status, 'running')))
    : null
  const forkWrites: BatchItem<'sqlite'>[] = [
    ...(pauseForInitialization ? [pauseForInitialization] : []),
    insertTimeline,
    writeForkSnapshot(db, forkId, snapshot, now),
    childRevision,
    db.insert(universeEvidence).values({ timelineId: forkId, level: 'complete', assessedVersion: 0,
      baselineVersion: reconstruction?.evidence.throughVersion ?? sourceRevision.version, reasonCodesJson: '["fork_checkpoint_complete"]', assessedAt: now }),
    ...(reconstruction?.rows.states ?? states).map((s) => db.insert(personStates).values({
      ...s, timelineId: forkId, currentDialogueId: null, updatedRealAt: now,
    })),
    // 继承日程对子线而言在 V=0(分叉点)即存在——版本水位 0
    ...copiedSchedules.map((s) => db.insert(schedules).values({ ...s, timelineId: forkId, createdVersion: 0 })),
    ...copiedCommitments.map((commitment) => db.insert(commitments).values(commitment)),
    ...copiedVoxelEvents.map((row) => db.insert(voxelEventProjections).values(row)),
    ...(actionCommand ? [actionCommand] : []),
    ...(actionFact ? [actionFact] : []),
    ...(actionEvent ? [actionEvent] : []),
    ...(preparedAction ? [db.update(universeEvidence).set({ assessedVersion: 1, assessedAt: now })
      .where(and(eq(universeEvidence.timelineId, forkId), eq(universeEvidence.assessedVersion, 0)))] : []),
    ...(restorePause ? [restorePause] : []),
  ]
  try { await db.batch(forkWrites as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]) } catch (error) {
    const committed = await replay()
    if (committed) return committed
    if (options.expectedSourceVersion !== undefined && /constraint|foreign key/i.test(databaseErrorMessages(error).join('\n'))) {
      const latest = await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, source.id)).get()
      if (latest && latest.version !== options.expectedSourceVersion) {
        throw new WorldStateError('源宇宙在创建分叉前已变化；请刷新当前状态后重试。', 409)
      }
    }
    const conflict = forkConflict(error)
    if (conflict) throw conflict
    throw error
  }
  return { id: forkId, simNow: forkSimTime, snapshot,
    ...(preparedAction && actionFactId ? { action: { commandId: actionCommandId, factId: actionFactId,
      version: 1, summary: forkActionSummary(preparedAction.action) } satisfies ForkActionReceipt } : {}) }
}
