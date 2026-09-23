import { and, eq, exists, isNull } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../db/client'
import { commitments, dialogueTurns, dialogues, events, memories, persons, personStates, schedules, timelines, universeRevisions, worldCommands, worldFacts, worldPersons, worlds } from '../db/schema'
import { ensureUniverseRevision } from './model'
import { validateWorldAction } from './rules'
import type { WorldCommandInput } from './types'
import { WorldStateError } from './types'

export interface CommitResult { commandId: string; factId: string; version: number; replayed: boolean }

/** One accepted command = one revision, one primary fact, one derived public event. */
export async function commitWorldCommand(db: Db, input: WorldCommandInput, atomicWrites: BatchItem<'sqlite'>[] = []): Promise<CommitResult> {
  if (!input.id || input.id.length > 100 || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new WorldStateError('命令 ID 或状态版本无效', 400)
  }
  const payloadJson = JSON.stringify(input.action)
  const existing = await db.select().from(worldCommands).where(eq(worldCommands.id, input.id)).get()
  if (existing) return replay(db, existing, input, payloadJson)

  const world = await db.select().from(worlds)
    .where(and(eq(worlds.id, input.worldId), eq(worlds.userId, input.userId))).get()
  if (!world) throw new WorldStateError('世界不存在', 404)
  if (input.actorKind === 'visitor') {
    const visitor = input.actorPersonId ? await db.select().from(persons)
      .where(and(eq(persons.id, input.actorPersonId), eq(persons.userId, input.userId), eq(persons.isUser, true))).get() : null
    const member = visitor ? await db.select().from(worldPersons)
      .where(and(eq(worldPersons.worldId, world.id), eq(worldPersons.personId, visitor.id))).get() : null
    if (!visitor || !member) throw new WorldStateError('在场身份不属于这个世界', 403)
    if (input.action.type === 'enter' || input.action.type === 'move') {
      if (input.action.personId !== visitor.id) throw new WorldStateError('在场身份只能移动自己', 403)
    } else if (input.action.type === 'inform') {
      if (input.action.sourceFactId) throw new WorldStateError('在场转告只能作为未经证实的消息', 403)
      const [senderState, recipientState] = await Promise.all([
        db.select().from(personStates).where(and(eq(personStates.personId, visitor.id), eq(personStates.timelineId, input.timelineId))).get(),
        db.select().from(personStates).where(and(eq(personStates.personId, input.action.recipientId), eq(personStates.timelineId, input.timelineId))).get(),
      ])
      if (!senderState || !recipientState || senderState.currentDialogueId || recipientState.currentDialogueId
        || senderState.location !== recipientState.location || visitor.id === input.action.recipientId) {
        throw new WorldStateError('只有未参与其他交谈时，才能向同一地点的空闲居民当面传递消息', 409)
      }
    } else if (input.action.type === 'scene_open') {
      if (input.action.visitorId !== visitor.id || !input.action.participantIds.includes(visitor.id)) {
        throw new WorldStateError('只能为自己的在场交谈创建场景', 403)
      }
    } else if (input.action.type === 'conversation') {
      const dialogue = await db.select().from(dialogues).where(and(
        eq(dialogues.id, input.action.dialogueId), eq(dialogues.timelineId, input.timelineId),
      )).get()
      if (!dialogue || dialogue.visitorId !== visitor.id || dialogue.kind !== 'scene') {
        throw new WorldStateError('在场身份不能记录其他人的交谈', 403)
      }
      if (!input.action.turns.some(turn => turn.personId === visitor.id)) throw new WorldStateError('交谈记录缺少来访者发言', 400)
    } else throw new WorldStateError('在场身份不能执行构造者行动', 403)
  }
  if (input.action.type === 'resident_state' && input.actorKind !== 'system') {
    throw new WorldStateError('居民状态只能由世界引擎记录', 403)
  }
  if ((input.action.type === 'dialogue_turn' || input.action.type === 'dialogue_start') && input.actorKind !== 'system') {
    throw new WorldStateError('居民发言只能由世界引擎记录', 403)
  }
  if (input.action.type === 'clock_advance' && input.actorKind !== 'system') {
    throw new WorldStateError('世界时钟只能由世界引擎推进', 403)
  }
  if (input.action.type === 'simulation_checkpoint' && input.actorKind !== 'system') {
    throw new WorldStateError('模拟检查点只能由世界引擎记录', 403)
  }
  if (input.action.type === 'dialogue_recovery' && input.actorKind !== 'system') {
    throw new WorldStateError('对话占用只能由世界引擎恢复', 403)
  }
  if (input.action.type === 'memory_summary' && input.actorKind !== 'system') {
    throw new WorldStateError('记忆摘要只能由世界引擎生成', 403)
  }
  if (input.action.type === 'schedule_set' && input.actorKind !== 'system') {
    throw new WorldStateError('居民日程只能由世界引擎生成', 403)
  }
  if (input.action.type === 'scene_open' && input.actorKind !== 'visitor') {
    throw new WorldStateError('场景交谈只能由在场者开启', 403)
  }
  if (input.action.type === 'conversation' && input.action.acceptedCommitments?.length && input.actorKind !== 'visitor') {
    throw new WorldStateError('居民接受来访者邀请只能记录在场交谈中', 403)
  }
  const timeline = await db.select().from(timelines)
    .where(and(eq(timelines.id, input.timelineId), eq(timelines.worldId, world.id))).get()
  if (!timeline || timeline.status !== 'active') throw new WorldStateError('时间线不存在或已归档', 404)
  if (world.status !== 'running') throw new WorldStateError('世界未运行，不能执行行动', 409)
  const revision = await ensureUniverseRevision(db, world.id, timeline.id)
  if (revision.version !== input.expectedVersion) throw new WorldStateError('世界状态已变化，请刷新后重试', 409)
  const plan = await validateWorldAction(db, world.id, timeline.id, input.action)
  const now = new Date().toISOString()
  const commitSimTime = plan.resultSimTime ?? timeline.simNow
  const resultVersion = input.expectedVersion + 1
  const factId = crypto.randomUUID()
  const command = db.insert(worldCommands).values({
    id: input.id, worldId: world.id, timelineId: timeline.id, actorKind: input.actorKind ?? 'owner', actorId: actorId(input),
    type: input.action.type, payloadJson, expectedVersion: input.expectedVersion, resultVersion, createdAt: now,
    tickLeaseToken: input.engineTickLeaseToken ?? null,
  })
  const advance = db.update(universeRevisions).set({ version: resultVersion, simTime: commitSimTime, updatedAt: now })
    .where(and(eq(universeRevisions.timelineId, timeline.id), eq(universeRevisions.version, input.expectedVersion)))
  const fact = db.insert(worldFacts).values({
    id: factId, timelineId: timeline.id, version: resultVersion, simTime: commitSimTime,
    factType: plan.factType, subjectId: plan.subjectId, valueJson: JSON.stringify(plan.value),
    sourceCommandId: input.id, visibility: plan.visibility,
  })
  const event = db.insert(events).values({
    id: plan.eventId ?? `command:${input.id}`, timelineId: timeline.id, simTime: commitSimTime,
    title: plan.eventTitle, description: plan.eventDescription, kind: plan.eventKind ?? 'action',
    actorPersonId: plan.movePersonId ?? plan.enterPersonId ?? plan.statePersonId ?? plan.dialogueTurn?.speakerId
      ?? plan.commitmentProposal?.personId ?? plan.commitment?.visitorId ?? (input.actorKind === 'visitor' ? input.actorPersonId : null),
    dialogueId: plan.dialogueId ?? plan.commitment?.dialogueId ?? null,
  })
  try {
    if (plan.clockAdvance) {
      await db.batch([
        command, advance,
        db.update(timelines).set({ simNow: plan.clockAdvance.to, lastRealTickAt: plan.clockAdvance.observedAt })
          .where(and(eq(timelines.id, timeline.id), eq(timelines.simNow, plan.clockAdvance.from), eq(timelines.status, 'active'))),
        fact,
        ...atomicWrites,
      ])
    } else if (plan.simulationCheckpoint) {
      await db.batch([
        command, advance, fact,
        db.update(personStates).set({ lastBeatSimTime: plan.simulationCheckpoint.lastBeatSimTime, updatedRealAt: now })
          .where(and(eq(personStates.personId, plan.simulationCheckpoint.personId), eq(personStates.timelineId, timeline.id))),
        ...atomicWrites,
      ])
    } else if (plan.dialogueRecovery) {
      const recovery = plan.dialogueRecovery
      const guardedAdvance = db.update(universeRevisions).set({ version: resultVersion, simTime: commitSimTime, updatedAt: now })
        .where(and(eq(universeRevisions.timelineId, timeline.id), eq(universeRevisions.version, input.expectedVersion),
          exists(db.select({ personId: personStates.personId }).from(personStates).where(and(
            eq(personStates.personId, recovery.personId), eq(personStates.timelineId, timeline.id),
            eq(personStates.currentDialogueId, recovery.dialogueId),
          )))))
      await db.batch([
        command, guardedAdvance,
        db.update(personStates).set({ currentDialogueId: null, updatedRealAt: now }).where(and(
          eq(personStates.personId, recovery.personId), eq(personStates.timelineId, timeline.id),
          eq(personStates.currentDialogueId, recovery.dialogueId),
        )),
        fact,
        ...atomicWrites,
      ])
    } else if (plan.memorySummary) {
      const summary = plan.memorySummary
      await db.batch([
        command, advance, fact,
        db.insert(memories).values({ id: summary.summaryId, personId: summary.personId, timelineId: timeline.id,
          type: 'summary', content: summary.content, simTime: summary.simTime, createdAt: summary.createdAt,
          importance: summary.importance, summarized: false }),
        ...summary.sourceMemoryIds.map(memoryId => db.update(memories).set({ summarized: true }).where(and(
          eq(memories.id, memoryId), eq(memories.personId, summary.personId), eq(memories.summarized, false),
        ))),
        ...atomicWrites,
      ])
    } else if (plan.memoryMaintenance) {
      const maintenance = plan.memoryMaintenance
      const before = maintenance.before
      const memoryBefore = and(
        eq(memories.id, maintenance.memoryId), eq(memories.personId, maintenance.personId),
        eq(memories.timelineId, timeline.id), eq(memories.type, before.type),
        eq(memories.content, before.content), eq(memories.importance, before.importance),
        before.simTime === null ? isNull(memories.simTime) : eq(memories.simTime, before.simTime),
        eq(memories.createdAt, before.createdAt), eq(memories.summarized, before.summarized),
      )
      const guardedAdvance = db.update(universeRevisions).set({ version: resultVersion, simTime: commitSimTime, updatedAt: now })
        .where(and(eq(universeRevisions.timelineId, timeline.id), eq(universeRevisions.version, input.expectedVersion),
          exists(db.select({ id: memories.id }).from(memories).where(memoryBefore))))
      const projection = maintenance.operation === 'correct' && maintenance.after
        ? db.update(memories).set(maintenance.after).where(memoryBefore)
        : db.delete(memories).where(memoryBefore)
      await db.batch([command, guardedAdvance, fact, projection, event, ...atomicWrites])
    } else if (plan.scheduleProjection) {
      const schedule = plan.scheduleProjection
      await db.batch([command, advance, fact, db.insert(schedules).values({ personId: schedule.personId,
        timelineId: timeline.id, worldDate: schedule.worldDate, itemsJson: JSON.stringify(schedule.items),
        generatedAt: schedule.generatedAt }), ...atomicWrites])
    } else if (plan.sceneOpen) {
      const scene = plan.sceneOpen
      await db.batch([command, advance, fact,
        db.insert(dialogues).values({ id: scene.dialogueId, timelineId: timeline.id, location: scene.location,
          participantIdsJson: JSON.stringify(scene.participantIds), status: 'scene', kind: 'scene',
          visitorId: scene.visitorId, turnLimit: scene.turnLimit, simStart: timeline.simNow, simEnd: timeline.simNow }),
        ...atomicWrites])
    } else if (plan.commitmentProposal) {
      const item = plan.commitmentProposal
      await db.batch([
        command, advance,
        db.insert(commitments).values({ id: item.id, worldId: world.id, timelineId: timeline.id,
          personId: item.personId, visitorId: item.visitorId, sourceDialogueId: item.sourceDialogueId,
          title: item.title, kind: item.kind, location: item.location, dueSim: item.dueSim,
          status: 'proposed', createdSim: timeline.simNow, updatedSim: timeline.simNow, createdAt: now }),
        fact, event, ...atomicWrites,
      ])
    } else if (plan.commitment) {
      const item = plan.commitment
      await db.batch([
        command, advance,
        db.update(commitments).set({ status: item.next, updatedSim: timeline.simNow }).where(and(
          eq(commitments.id, item.id), eq(commitments.status, item.prior), eq(commitments.timelineId, timeline.id),
        )),
        fact, event.onConflictDoNothing(),
        db.insert(memories).values({ id: `${plan.eventId}:memory`, personId: item.personId, timelineId: timeline.id,
          type: 'relationship', content: item.memoryText, simTime: timeline.simNow, createdAt: now, importance: 8,
          summarized: false }).onConflictDoNothing(),
        ...(item.mood ? [db.update(personStates).set({ mood: item.mood, updatedRealAt: now }).where(and(
          eq(personStates.personId, item.personId), eq(personStates.timelineId, timeline.id),
        ))] : []),
        ...atomicWrites,
      ])
    } else if (plan.enterPersonId && plan.moveTo) {
      await db.batch([
        command, advance, fact,
        db.insert(personStates).values({ personId: plan.enterPersonId, timelineId: timeline.id,
          simTime: timeline.simNow, location: plan.moveTo, activity: '刚来到这里', mood: '平静',
          goal: '探索这个世界', updatedRealAt: now, lastBeatSimTime: timeline.simNow }),
        event, ...atomicWrites,
      ])
    } else if (plan.movePersonId && plan.moveTo) {
      await db.batch([
        command, advance, fact,
        db.update(personStates).set({ location: plan.moveTo, simTime: timeline.simNow, updatedRealAt: now })
          .where(and(eq(personStates.timelineId, timeline.id), eq(personStates.personId, plan.movePersonId))),
        event, ...atomicWrites,
      ])
    } else if (plan.statePersonId && plan.statePatch) {
      const action = input.action
      if (action.type !== 'resident_state') throw new Error('resident state plan/action mismatch')
      const timelineAdvance = commitSimTime > timeline.simNow
        ? [db.update(timelines).set({ simNow: commitSimTime }).where(and(eq(timelines.id, timeline.id), eq(timelines.simNow, timeline.simNow)))]
        : []
      await db.batch([
        command, advance, ...timelineAdvance, fact,
        db.update(personStates).set({ ...plan.statePatch, simTime: commitSimTime, updatedRealAt: now }).where(and(
          eq(personStates.timelineId, timeline.id), eq(personStates.personId, plan.statePersonId),
        )),
        event,
        ...(plan.storyEvents ?? []).map((story, index) => db.insert(events).values({
          id: `${input.id}:story:${index}`, timelineId: timeline.id, simTime: story.simTime,
          title: story.title, description: story.description, kind: 'action', actorPersonId: plan.statePersonId,
        })),
        ...(plan.stateMemories ?? []).map((memory, index) => db.insert(memories).values({
          id: `${input.id}:memory:${index}`, personId: plan.statePersonId!, timelineId: timeline.id,
          type: memory.type, content: memory.content, simTime: commitSimTime, createdAt: now,
          importance: memory.importance, summarized: false,
        })),
        ...atomicWrites,
      ])
    } else if (plan.dialogueStart) {
      const action = input.action
      if (action.type !== 'dialogue_start') throw new Error('dialogue start plan/action mismatch')
      await db.batch([
        command, advance, fact,
        db.insert(dialogues).values({ id: action.dialogueId, timelineId: timeline.id, location: action.location,
          participantIdsJson: JSON.stringify(action.participantIds), status: 'ongoing', kind: 'npc',
          turnLimit: action.turnLimit, simStart: timeline.simNow }),
        ...action.participantIds.map(personId => db.update(personStates).set({
          currentDialogueId: action.dialogueId, updatedRealAt: now,
        }).where(and(eq(personStates.timelineId, timeline.id), eq(personStates.personId, personId)))),
        event, ...atomicWrites,
      ])
    } else if (plan.dialogueTurn) {
      const action = input.action
      if (action.type !== 'dialogue_turn') throw new Error('dialogue turn plan/action mismatch')
      const thought = db.insert(memories).values({ id: `${input.id}:thought`, personId: action.speakerId, timelineId: timeline.id,
        type: 'thought', content: action.thought, simTime: timeline.simNow, createdAt: now, importance: 5, summarized: false })
      const memory = action.memory ? [db.insert(memories).values({ id: `${input.id}:memory`, personId: action.speakerId,
        timelineId: timeline.id, type: 'relationship', content: action.memory.content, simTime: timeline.simNow,
        createdAt: now, importance: action.memory.importance, summarized: false })] : []
      await db.batch([
        command, advance, fact,
        db.insert(dialogueTurns).values({ id: `${input.id}:turn`, dialogueId: action.dialogueId,
          turnIndex: action.turnIndex, personId: action.speakerId, utterance: action.utterance, thought: action.thought,
          simTime: timeline.simNow, createdAt: now }),
        thought, ...memory, event,
        ...(plan.dialogueTurn.closes ? [
          db.update(dialogues).set({ status: 'ended', simEnd: timeline.simNow }).where(and(
            eq(dialogues.id, action.dialogueId), eq(dialogues.status, 'ongoing'),
          )),
          ...plan.dialogueTurn.participantIds.map(personId => db.update(personStates).set({
            currentDialogueId: null, lastBeatSimTime: timeline.simNow, updatedRealAt: now,
          }).where(and(eq(personStates.timelineId, timeline.id), eq(personStates.personId, personId),
            eq(personStates.currentDialogueId, action.dialogueId)))),
        ] : []),
        ...atomicWrites,
      ])
    } else {
      await db.batch([command, advance, fact,
        ...(plan.acceptedCommitments ?? []).map(item => db.insert(commitments).values({
          id: item.id, worldId: world.id, timelineId: timeline.id, personId: item.personId, visitorId: item.visitorId,
          sourceDialogueId: item.sourceDialogueId, title: item.title, kind: item.kind, location: item.location,
          dueSim: item.dueSim, status: 'accepted', createdSim: timeline.simNow, updatedSim: timeline.simNow, createdAt: now,
        })),
        event, ...atomicWrites])
    }
  } catch (error) {
    const committed = await db.select().from(worldCommands).where(eq(worldCommands.id, input.id)).get()
    if (committed) return replay(db, committed, input, payloadJson)
    const latest = await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timeline.id)).get()
    if (latest?.version !== input.expectedVersion) throw new WorldStateError('世界状态已变化，请刷新后重试', 409)
    const [latestTimeline, latestWorld] = await Promise.all([
      db.select().from(timelines).where(eq(timelines.id, timeline.id)).get(),
      db.select().from(worlds).where(eq(worlds.id, world.id)).get(),
    ])
    if (latestTimeline?.simNow !== timeline.simNow || latestTimeline?.status !== 'active' || latestWorld?.status !== 'running') {
      throw new WorldStateError('世界时间或运行状态已变化，请刷新后重试', 409)
    }
    throw error
  }
  return { commandId: input.id, factId, version: resultVersion, replayed: false }
}

async function replay(db: Db, existing: typeof worldCommands.$inferSelect, input: WorldCommandInput, payloadJson: string): Promise<CommitResult> {
  if (existing.worldId !== input.worldId || existing.timelineId !== input.timelineId
    || existing.actorKind !== (input.actorKind ?? 'owner') || existing.actorId !== actorId(input)
    || existing.expectedVersion !== input.expectedVersion || existing.payloadJson !== payloadJson) {
    throw new WorldStateError('命令 ID 已用于另一项行动', 409)
  }
  const fact = await db.select({ id: worldFacts.id }).from(worldFacts)
    .where(eq(worldFacts.sourceCommandId, existing.id)).get()
  if (!fact) throw new Error('已提交命令缺少事实记录')
  return { commandId: existing.id, factId: fact.id, version: existing.resultVersion, replayed: true }
}

function actorId(input: WorldCommandInput): string | null {
  return input.actorKind === 'system' ? null : input.actorKind === 'visitor' ? input.actorPersonId ?? null : input.userId
}
