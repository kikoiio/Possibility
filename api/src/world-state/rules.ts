import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import { commitments, dialogueTurns, dialogues, memories, personStates, persons, schedules, timelines, worldFacts, worldPersons, worlds } from '../db/schema'
import type { WorldAction } from './types'
import { WorldStateError } from './types'
import { readWorldState } from './query'
import { readPinnedWorldModel } from './model'

export interface ActionPlan {
  factType: 'location' | 'environment' | 'knowledge' | 'commitment' | 'conversation' | 'resident_state' | 'intervention' | 'clock' | 'memory_summary' | 'memory_maintenance' | 'schedule'
  subjectId: string
  value: Record<string, unknown>
  visibility: 'world' | 'private'
  eventTitle: string
  eventDescription: string
  eventKind?: 'action' | 'dialogue' | 'injected'
  moveTo?: string
  movePersonId?: string
  enterPersonId?: string
  commitment?: { id: string; prior: string; next: string; personId: string; visitorId: string; dialogueId: string | null; mood: string | null; memoryText: string }
  dialogueId?: string
  eventId?: string
  statePersonId?: string
  statePatch?: { location?: string; activity?: string; mood?: string; goal?: string; lastBeatSimTime?: string }
  storyEvents?: { simTime: string; title: string; description: string }[]
  stateMemories?: { type: 'thought' | 'timeline' | 'relationship' | 'world'; content: string; importance: number }[]
  resultSimTime?: string
  dialogueTurn?: { dialogueId: string; speakerId: string; turnIndex: number; participantIds: string[]; closes: boolean }
  dialogueStart?: { dialogueId: string; participantIds: string[]; location: string; turnLimit: number }
  sceneOpen?: { dialogueId: string; visitorId: string; participantIds: string[]; location: string; turnLimit: number }
  acceptedCommitments?: { id: string; personId: string; visitorId: string; sourceDialogueId: string; title: string;
    kind: 'meeting' | 'help'; location: string; dueSim: string }[]
  commitmentProposal?: { id: string; personId: string; visitorId: string; sourceDialogueId: string; title: string;
    kind: 'meeting' | 'help'; location: string; dueSim: string }
  clockAdvance?: { from: string; to: string; observedAt: string }
  simulationCheckpoint?: { personId: string; lastBeatSimTime: string }
  dialogueRecovery?: { personId: string; dialogueId: string }
  memorySummary?: { personId: string; sourceMemoryIds: string[]; summaryId: string; content: string; importance: number;
    simTime: string; createdAt: string }
  memoryMaintenance?: { operation: 'correct' | 'forget'; memoryId: string; personId: string;
    before: { type: string; content: string; importance: number; simTime: string | null; createdAt: string; summarized: boolean };
    after?: { content: string; importance: number } }
  scheduleProjection?: { personId: string; worldDate: string; generatedAt: string;
    items: { start: string; end: string; location: string; activity: string; kind?: 'sleep' }[] }
}

export async function validateWorldAction(db: Db, worldId: string, timelineId: string, action: WorldAction): Promise<ActionPlan> {
  const world = await db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  const timeline = await db.select().from(timelines)
    .where(and(eq(timelines.id, timelineId), eq(timelines.worldId, worldId))).get()
  if (!world || !timeline) throw new WorldStateError('世界或时间线不存在', 404)
  const pinned = await readPinnedWorldModel(db, worldId, timelineId)
  let locations: { name: string }[] = pinned?.locations ?? []
  if (!pinned) try { locations = JSON.parse(world.locationsJson || '[]') as { name: string }[] } catch { /* invalid legacy world */ }
  const hasLocation = (name: string) => locations.some(l => l.name === name)
  const assertUniqueLocationAtTime = async (personId: string, location: string, simTime: string) => {
    const priorFacts = await db.select().from(worldFacts).where(and(
      eq(worldFacts.timelineId, timelineId), eq(worldFacts.subjectId, personId), eq(worldFacts.simTime, simTime),
      inArray(worldFacts.factType, ['location', 'resident_state']),
    )).all()
    for (const fact of priorFacts) {
      let value: Record<string, unknown>
      try { value = JSON.parse(fact.valueJson) as Record<string, unknown> } catch { continue }
      const after = value.after && typeof value.after === 'object' ? value.after as Record<string, unknown> : {}
      const changes = value.changes && typeof value.changes === 'object' ? value.changes as Record<string, unknown> : {}
      const recordedLocation = typeof value.to === 'string' ? value.to
        : typeof changes.location === 'string' ? changes.location
          : typeof after.location === 'string' ? after.location : null
      if (recordedLocation && recordedLocation !== location) {
        throw new WorldStateError('同一世界时刻已记录该居民在另一地点，请等待时间推进后再移动', 409)
      }
    }
  }

  if (action.type === 'enter' || action.type === 'move') {
    if (typeof action.personId !== 'string' || !action.personId || typeof action.to !== 'string' || !hasLocation(action.to)) throw new WorldStateError('目的地不属于这个世界', 400)
    const member = await db.select().from(worldPersons).where(and(eq(worldPersons.worldId, worldId), eq(worldPersons.personId, action.personId))).get()
    const state = await db.select().from(personStates).where(and(eq(personStates.personId, action.personId), eq(personStates.timelineId, timelineId))).get()
    const person = await db.select().from(persons).where(eq(persons.id, action.personId)).get()
    if (!member) throw new WorldStateError('人物不属于这个世界', 404)
    if (action.type === 'enter' && state) throw new WorldStateError('已在世界中，请使用移动', 409)
    if (action.type === 'move' && !state) throw new WorldStateError('尚未进入这个宇宙', 409)
    if (state?.location === action.to) throw new WorldStateError('人物已在该地点', 409)
    if (action.type === 'move') await assertUniqueLocationAtTime(action.personId, action.to, timeline.simNow)
    return {
      factType: 'location', subjectId: action.personId,
      value: { from: state?.location ?? null, to: action.to }, visibility: 'world',
      eventTitle: `${person?.name ?? '一位人物'}来到${action.to}`,
      eventDescription: state
        ? `${person?.name ?? '一位人物'}从${state.location}来到${action.to}。`
        : `${person?.name ?? '一位人物'}进入世界，来到${action.to}。`,
      moveTo: action.to, movePersonId: state ? action.personId : undefined,
      enterPersonId: state ? undefined : action.personId,
    }
  }

  if (action.type === 'environment') {
    if (action.location != null && typeof action.location !== 'string') throw new WorldStateError('地点无效', 400)
    const location = action.location?.trim() || null
    if (location && !hasLocation(location)) throw new WorldStateError('地点不属于这个世界', 400)
    const condition = typeof action.condition === 'string' ? action.condition.trim() : ''
    const value = typeof action.value === 'string' ? action.value.trim() : ''
    if (!condition || !value || condition.length > 40 || value.length > 200) throw new WorldStateError('环境条件无效', 400)
    return {
      factType: 'environment', subjectId: `${location ?? 'world'}:${condition}`,
      value: { location, condition, value }, visibility: 'world',
      eventTitle: `${location ?? '世界'}的${condition}发生变化`,
      eventDescription: `${location ?? '整个世界'}的${condition}变为：${value}。`,
    }
  }

  if (action.type === 'intervention') {
    const requestId = typeof action.requestId === 'string' ? action.requestId.trim() : ''
    const text = typeof action.text === 'string' ? action.text.trim() : ''
    if (!requestId || requestId.length > 80 || !text || text.length > 2000) throw new WorldStateError('叙事干预参数无效', 400)
    return {
      factType: 'intervention', subjectId: requestId, value: { requestId, text, authoredBy: 'builder' },
      visibility: 'world', eventTitle: text.slice(0, 60), eventDescription: text,
      eventKind: 'injected', eventId: `intervention:${requestId}`,
    }
  }

  if (action.type === 'clock_advance') {
    const fromMs = Date.parse(action.from)
    const toMs = Date.parse(action.to)
    const observedMs = Date.parse(action.observedAt)
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || !Number.isFinite(observedMs)
      || action.from !== timeline.simNow || toMs <= fromMs || toMs - fromMs > 24 * 60 * 60_000) {
      throw new WorldStateError('世界时钟推进参数无效或基准已变化', 409)
    }
    return {
      factType: 'clock', subjectId: timelineId,
      value: { from: action.from, to: action.to, observedAt: action.observedAt }, visibility: 'world',
      eventTitle: '世界时钟推进', eventDescription: `世界时间推进至 ${action.to}。`,
      clockAdvance: { from: action.from, to: action.to, observedAt: action.observedAt },
      resultSimTime: action.to,
    }
  }

  if (action.type === 'simulation_checkpoint') {
    const value = typeof action.lastBeatSimTime === 'string' ? Date.parse(action.lastBeatSimTime) : NaN
    if (typeof action.personId !== 'string' || !action.personId || !Number.isFinite(value)
      || value > Date.parse(timeline.simNow)) throw new WorldStateError('模拟检查点无效', 400)
    const [member, state] = await Promise.all([
      db.select().from(worldPersons).where(and(eq(worldPersons.worldId, worldId), eq(worldPersons.personId, action.personId))).get(),
      db.select().from(personStates).where(and(eq(personStates.personId, action.personId), eq(personStates.timelineId, timelineId))).get(),
    ])
    if (!member || !state) throw new WorldStateError('模拟检查点人物不属于这个宇宙', 404)
    if (state.lastBeatSimTime && value <= Date.parse(state.lastBeatSimTime)) {
      throw new WorldStateError('模拟检查点不能倒退或重复', 409)
    }
    return {
      factType: 'resident_state', subjectId: action.personId,
      value: { cause: 'runtime_checkpoint', changes: { lastBeatSimTime: action.lastBeatSimTime } },
      visibility: 'private', eventTitle: '', eventDescription: '',
      statePersonId: action.personId, statePatch: { lastBeatSimTime: action.lastBeatSimTime },
      simulationCheckpoint: { personId: action.personId, lastBeatSimTime: action.lastBeatSimTime },
    }
  }

  if (action.type === 'dialogue_recovery') {
    if (typeof action.personId !== 'string' || !action.personId || typeof action.dialogueId !== 'string' || !action.dialogueId) {
      throw new WorldStateError('对话恢复参数无效', 400)
    }
    const [member, state, dialogue] = await Promise.all([
      db.select().from(worldPersons).where(and(eq(worldPersons.worldId, worldId), eq(worldPersons.personId, action.personId))).get(),
      db.select().from(personStates).where(and(eq(personStates.personId, action.personId), eq(personStates.timelineId, timelineId))).get(),
      db.select().from(dialogues).where(and(eq(dialogues.id, action.dialogueId), eq(dialogues.timelineId, timelineId))).get(),
    ])
    if (!member || !state) throw new WorldStateError('对话参与者不属于这个宇宙', 404)
    if (state.currentDialogueId !== action.dialogueId) throw new WorldStateError('人物占用状态已变化', 409)
    if (dialogue?.status === 'ongoing') throw new WorldStateError('对话仍在进行，不能清除占用', 409)
    return {
      factType: 'resident_state', subjectId: action.personId,
      value: { cause: 'dialogue_recovery', previousDialogueId: action.dialogueId,
        reason: dialogue ? 'dialogue_ended' : 'dialogue_missing', changes: { currentDialogueId: null } },
      visibility: 'private', eventTitle: '', eventDescription: '',
      dialogueRecovery: { personId: action.personId, dialogueId: action.dialogueId },
    }
  }

  if (action.type === 'schedule_set') {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/
    const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/
    if (typeof action.personId !== 'string' || !action.personId || !datePattern.test(action.worldDate)
      || action.worldDate !== timeline.simNow.slice(0, 10) || action.generatedAt !== timeline.simNow
      || !Array.isArray(action.items) || action.items.length < 6 || action.items.length > 10) {
      throw new WorldStateError('居民日程参数无效或世界日期已变化', 409)
    }
    const [member, state, existing] = await Promise.all([
      db.select().from(worldPersons).where(and(eq(worldPersons.worldId, worldId), eq(worldPersons.personId, action.personId))).get(),
      db.select().from(personStates).where(and(eq(personStates.personId, action.personId), eq(personStates.timelineId, timelineId))).get(),
      db.select().from(schedules).where(and(eq(schedules.personId, action.personId), eq(schedules.timelineId, timelineId), eq(schedules.worldDate, action.worldDate))).get(),
    ])
    if (!member || !state) throw new WorldStateError('日程人物不属于这个宇宙', 404)
    if (existing) throw new WorldStateError('该居民今天已有日程', 409)
    const toMinute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
    let previousStart = -1
    let previousEnd = -1
    let dayOffset = 0
    for (const item of action.items) {
      if (!item || typeof item !== 'object' || !timePattern.test(item.start) || !timePattern.test(item.end)
        || !hasLocation(item.location) || typeof item.activity !== 'string' || !item.activity.trim()
        || (item.kind !== undefined && item.kind !== 'sleep')) throw new WorldStateError('日程项目无效', 400)
      const rawStart = toMinute(item.start)
      if (rawStart < previousStart) dayOffset += 24 * 60
      const start = rawStart + dayOffset
      let end = toMinute(item.end)
      if (end <= rawStart) end += 24 * 60
      end += dayOffset
      if (start < previousEnd) throw new WorldStateError('日程项目存在重叠', 400)
      previousStart = rawStart
      previousEnd = end
    }
    return { factType: 'schedule', subjectId: `${action.personId}:${action.worldDate}`,
      value: { personId: action.personId, worldDate: action.worldDate, generatedAt: action.generatedAt, items: action.items },
      visibility: 'private', eventTitle: '', eventDescription: '',
      scheduleProjection: { personId: action.personId, worldDate: action.worldDate, generatedAt: action.generatedAt, items: action.items } }
  }

  if (action.type === 'memory_summary') {
    const sourceIds = action.sourceMemoryIds
    if (typeof action.personId !== 'string' || !action.personId || !Array.isArray(sourceIds)
      || sourceIds.length < 1 || sourceIds.length > 30 || sourceIds.some(id => typeof id !== 'string' || !id)
      || new Set(sourceIds).size !== sourceIds.length || typeof action.summaryId !== 'string' || !action.summaryId
      || typeof action.content !== 'string' || !action.content.trim() || action.content.length > 4000
      || !Number.isFinite(action.importance) || action.importance < 1 || action.importance > 10) {
      throw new WorldStateError('记忆摘要参数无效', 400)
    }
    const member = await db.select().from(worldPersons).where(and(
      eq(worldPersons.worldId, worldId), eq(worldPersons.personId, action.personId),
    )).get()
    const sourceRows = await db.select().from(memories).where(inArray(memories.id, sourceIds)).all()
    const allowedBucket = (id: string | null) => id === timelineId || (id === null && timeline.parentTimelineId === null)
    if (!member || sourceRows.length !== sourceIds.length || sourceRows.some(row => row.personId !== action.personId
      || row.summarized || row.type === 'summary' || !allowedBucket(row.timelineId))) {
      throw new WorldStateError('待压缩记忆已变化或不属于该宇宙', 409)
    }
    const latest = sourceIds.map(id => sourceRows.find(row => row.id === id)!).at(-1)!
    if (action.createdAt !== latest.createdAt || action.simTime !== (latest.simTime ?? latest.createdAt)) {
      throw new WorldStateError('摘要时间水位与来源记忆不一致', 409)
    }
    return { factType: 'memory_summary', subjectId: action.personId,
      value: { personId: action.personId, sourceMemoryIds: sourceIds, summaryId: action.summaryId,
        content: action.content, importance: action.importance, simTime: action.simTime, createdAt: action.createdAt },
      visibility: 'private', eventTitle: '居民记忆摘要已更新', eventDescription: '居民的私有记忆已压缩并保留来源。',
      memorySummary: { personId: action.personId, sourceMemoryIds: sourceIds, summaryId: action.summaryId,
        content: action.content, importance: action.importance, simTime: action.simTime, createdAt: action.createdAt } }
  }

  if (action.type === 'memory_correct' || action.type === 'memory_forget') {
    const memory = await db.select().from(memories).where(and(
      eq(memories.id, action.memoryId), eq(memories.personId, action.personId),
    )).get()
    const before = action.before
    if (!memory || memory.timelineId !== timelineId || !before || before.type !== memory.type
      || before.content !== memory.content || before.importance !== memory.importance
      || before.simTime !== memory.simTime || before.createdAt !== memory.createdAt
      || before.summarized !== memory.summarized) {
      throw new WorldStateError('居民记忆已变化或不属于这个宇宙', 409)
    }
    const member = await db.select().from(worldPersons).where(and(
      eq(worldPersons.worldId, worldId), eq(worldPersons.personId, action.personId),
    )).get()
    if (!member) throw new WorldStateError('居民不属于这个世界', 404)
    if (memory.summarized && memory.type !== 'summary') {
      throw new WorldStateError('已被摘要的来源记忆不能单独修改或遗忘', 409)
    }
    if (action.type === 'memory_correct') {
      const content = typeof action.after?.content === 'string' ? action.after.content.trim() : ''
      const importance = action.after?.importance
      if (!content || content.length > 4000 || !Number.isFinite(importance) || importance < 1 || importance > 10) {
        throw new WorldStateError('记忆校正内容无效', 400)
      }
      return { factType: 'memory_maintenance', subjectId: memory.id,
        value: { operation: 'correct', memoryId: memory.id, personId: memory.personId, before,
          after: { content, importance } }, visibility: 'private',
        eventTitle: '居民记忆被校正', eventDescription: '构造者校正了一条居民记忆。', eventKind: 'injected',
        memoryMaintenance: { operation: 'correct', memoryId: memory.id, personId: memory.personId, before,
          after: { content, importance } } }
    }
    return { factType: 'memory_maintenance', subjectId: memory.id,
      value: { operation: 'forget', memoryId: memory.id, personId: memory.personId, before }, visibility: 'private',
      eventTitle: '居民遗忘了一条记忆', eventDescription: '构造者让居民遗忘了一条记忆。', eventKind: 'injected',
      memoryMaintenance: { operation: 'forget', memoryId: memory.id, personId: memory.personId, before } }
  }

  if (action.type === 'inform') {
    if (typeof action.recipientId !== 'string' || !action.recipientId) throw new WorldStateError('接收者无效', 400)
    const member = await db.select().from(worldPersons)
      .where(and(eq(worldPersons.worldId, worldId), eq(worldPersons.personId, action.recipientId))).get()
    if (!member) throw new WorldStateError('接收者不在这个世界', 404)
    const topic = typeof action.topic === 'string' ? action.topic.trim() : ''
    const content = typeof action.content === 'string' ? action.content.trim() : ''
    if (action.sourceFactId != null && typeof action.sourceFactId !== 'string') throw new WorldStateError('事实来源无效', 400)
    if (!topic || !content || topic.length > 80 || content.length > 500) throw new WorldStateError('消息内容无效', 400)
    let certainty: 'fact' | 'rumor' = 'rumor'
    if (action.sourceFactId) {
      const state = await readWorldState(db, worldId, timelineId)
      const source = state.facts.find(f => f.id === action.sourceFactId)
      if (!source) throw new WorldStateError('事实来源不在此宇宙', 400)
      const sourceValue = JSON.parse(source.valueJson) as Record<string, unknown>
      if (source.factType === 'knowledge') {
        // Relaying a private message preserves its epistemic status; a rumor cannot
        // become verified merely because another command cites its fact ID.
        certainty = sourceValue.certainty === 'fact' ? 'fact' : 'rumor'
      } else if (source.visibility === 'world' && ['environment', 'location', 'resident_state'].includes(source.factType)) {
        certainty = 'fact'
      } else {
        throw new WorldStateError('该记录不能作为已证实消息的来源', 400)
      }
    }
    return {
      factType: 'knowledge', subjectId: `${action.recipientId}:${topic}`,
      value: { recipientId: action.recipientId, topic, content, certainty, sourceFactId: action.sourceFactId ?? null },
      visibility: 'private', eventTitle: '一条消息被转告',
      eventDescription: '一位居民获得一条消息；内容只对获知者可见。',
    }
  }
  if (action.type === 'conversation') {
    if (typeof action.dialogueId !== 'string' || !action.dialogueId || typeof action.requestId !== 'string'
      || !action.requestId || action.requestId.length > 80 || !Array.isArray(action.turns)
      || !action.turns.length || action.turns.length > 16
      || action.turns.some(turn => !turn || typeof turn.id !== 'string' || !turn.id || typeof turn.personId !== 'string' || !turn.personId)
      || new Set(action.turns.map(turn => turn.id)).size !== action.turns.length) {
      throw new WorldStateError('交谈记录参数无效', 400)
    }
    const dialogue = await db.select().from(dialogues).where(and(
      eq(dialogues.id, action.dialogueId), eq(dialogues.timelineId, timelineId), eq(dialogues.kind, 'scene'),
    )).get()
    if (!dialogue?.visitorId) throw new WorldStateError('在场交谈不存在', 404)
    if (action.sceneProjection) {
      let projectedParticipants: string[] = []
      try { projectedParticipants = JSON.parse(dialogue.participantIdsJson) as string[] } catch { /* invalid projection */ }
      const supplied = action.sceneProjection
      if (!supplied || typeof supplied.location !== 'string' || !Array.isArray(supplied.participantIds)
        || supplied.participantIds.some(id => typeof id !== 'string') || typeof supplied.simTime !== 'string'
        || !Number.isSafeInteger(supplied.turnLimit) || dialogue.status !== 'scene' || dialogue.kind !== 'scene'
        || supplied.location !== dialogue.location || JSON.stringify(supplied.participantIds) !== JSON.stringify(projectedParticipants)
        || supplied.simTime !== dialogue.simStart || supplied.simTime !== dialogue.simEnd
        || supplied.turnLimit !== dialogue.turnLimit) {
        throw new WorldStateError('在场交谈元数据与交谈记录不一致', 400)
      }
    }
    let participantIds: string[]
    try { participantIds = JSON.parse(dialogue.participantIdsJson) as string[] } catch { participantIds = [] }
    if (!action.turns.every(turn => participantIds.includes(turn.personId))) throw new WorldStateError('交谈发言者不属于这场对话', 400)
    const visitorId = dialogue.visitorId
    const privateEffects = action.privateEffects ?? { memories: [], messages: [] }
    const memoryEffects = privateEffects.memories
    const messageEffects = privateEffects.messages
    if (!Array.isArray(memoryEffects) || memoryEffects.length > 6
      || memoryEffects.some(memory => !memory || typeof memory.id !== 'string' || !memory.id.trim()
        || !participantIds.includes(memory.personId) || memory.personId === visitorId
        || (memory.type !== 'thought' && memory.type !== 'relationship') || typeof memory.content !== 'string'
        || !memory.content.trim() || memory.content.length > 4000 || !Number.isFinite(memory.importance)
        || memory.importance < 1 || memory.importance > 10 || memory.simTime !== timeline.simNow
        || typeof memory.createdAt !== 'string' || !Number.isFinite(Date.parse(memory.createdAt)))
      || new Set(memoryEffects.map(memory => memory.id)).size !== memoryEffects.length) {
      throw new WorldStateError('交谈私有记忆必须属于参与交谈的居民', 400)
    }
    if (!Array.isArray(messageEffects) || messageEffects.length > 3
      || messageEffects.some(message => !message || typeof message.id !== 'string' || !message.id.trim()
        || !participantIds.includes(message.senderPersonId) || message.senderPersonId === visitorId
        || message.recipientPersonId !== visitorId || message.location !== dialogue.location
        || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 4000
        || message.simTime !== timeline.simNow || typeof message.createdAt !== 'string'
        || !Number.isFinite(Date.parse(message.createdAt)))
      || new Set(messageEffects.map(message => message.id)).size !== messageEffects.length) {
      throw new WorldStateError('交谈留言必须由在场居民留给当前来访者', 400)
    }
    const actualParticipants = [...new Set(action.turns.map(turn => turn.personId))].sort()
    const acceptedCommitments = action.acceptedCommitments ?? []
    if (!Array.isArray(acceptedCommitments) || acceptedCommitments.length > 3
      || acceptedCommitments.some(item => !item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 160
        || typeof item.personId !== 'string' || !item.personId || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100
        || (item.kind !== 'meeting' && item.kind !== 'help') || typeof item.location !== 'string' || !hasLocation(item.location)
        || typeof item.dueSim !== 'string' || !Number.isFinite(Date.parse(item.dueSim))
        || Date.parse(item.dueSim) <= Date.parse(timeline.simNow)
        || Date.parse(item.dueSim) - Date.parse(timeline.simNow) > 7 * 24 * 60 * 60_000)
      || new Set(acceptedCommitments.map(item => item.id)).size !== acceptedCommitments.length
      || new Set(acceptedCommitments.map(item => item.personId)).size !== acceptedCommitments.length) {
      throw new WorldStateError('居民接受邀请的约定参数无效', 400)
    }
    if (acceptedCommitments.length) {
      if (!action.turns.some(turn => turn.personId === dialogue.visitorId)) throw new WorldStateError('邀请来源交谈缺少来访者发言', 400)
      const residents = acceptedCommitments.map(item => item.personId)
      if (residents.some(id => id === dialogue.visitorId || !participantIds.includes(id))) {
        throw new WorldStateError('接受邀请的居民不属于来源交谈', 400)
      }
      const [members, open, existingIds] = await Promise.all([
        db.select().from(worldPersons).where(and(eq(worldPersons.worldId, worldId), inArray(worldPersons.personId, residents))).all(),
        db.select().from(commitments).where(and(eq(commitments.timelineId, timelineId),
          inArray(commitments.personId, residents), inArray(commitments.status, ['proposed', 'accepted']))).all(),
        db.select({ id: commitments.id }).from(commitments).where(inArray(commitments.id, acceptedCommitments.map(item => item.id))).all(),
      ])
      if (members.length !== residents.length || existingIds.length
        || residents.some(id => open.filter(item => item.personId === id).length >= 3)) {
        throw new WorldStateError('居民已有过多未完成的约定，或邀请已发生变化', 409)
      }
    }
    const people = actualParticipants.length
      ? await db.select().from(persons).where(inArray(persons.id, actualParticipants)).all()
      : []
    const names = new Map(people.map(person => [person.id, person.name]))
    const place = dialogue.location
    return {
      factType: 'conversation', subjectId: dialogue.id,
      value: { dialogueId: dialogue.id, requestId: action.requestId, turns: action.turns,
        participants: actualParticipants, turnCount: action.turns.length,
        ...(acceptedCommitments.length ? { acceptedCommitmentIds: acceptedCommitments.map(item => item.id) } : {}) },
      visibility: 'world', eventTitle: `${actualParticipants.map(id => names.get(id) ?? '某人').join(' 与 ')} 在${place}交谈`,
      eventDescription: `一次在场交谈已记录（${action.turns.length} 句）；完整发言见交谈记录。`,
      eventKind: 'dialogue', dialogueId: dialogue.id,
      acceptedCommitments: acceptedCommitments.map(item => ({ ...item, visitorId: dialogue.visitorId!, sourceDialogueId: dialogue.id })),
    }
  }
  if (action.type === 'dialogue_start') {
    if (typeof action.dialogueId !== 'string' || !action.dialogueId || !Array.isArray(action.participantIds)
      || action.participantIds.length < 2 || action.participantIds.length > 3
      || action.participantIds.some(id => typeof id !== 'string' || !id)
      || new Set(action.participantIds).size !== action.participantIds.length
      || typeof action.location !== 'string' || !hasLocation(action.location)
      || !Number.isSafeInteger(action.turnLimit) || action.turnLimit < 1 || action.turnLimit > 24) {
      throw new WorldStateError('居民交谈发起参数无效', 400)
    }
    const members = await db.select().from(worldPersons).where(and(
      eq(worldPersons.worldId, worldId), inArray(worldPersons.personId, action.participantIds),
    )).all()
    const states = await db.select().from(personStates).where(and(
      eq(personStates.timelineId, timelineId), inArray(personStates.personId, action.participantIds),
    )).all()
    if (members.length !== action.participantIds.length || states.length !== action.participantIds.length) {
      throw new WorldStateError('交谈参与者不属于这个宇宙', 404)
    }
    if (states.some(state => state.location !== action.location || state.currentDialogueId)) {
      throw new WorldStateError('居民没有同时在场或正忙于其他交谈', 409)
    }
    const people = await db.select().from(persons).where(inArray(persons.id, action.participantIds)).all()
    return {
      factType: 'conversation', subjectId: action.dialogueId,
      value: { dialogueId: action.dialogueId, participants: action.participantIds, location: action.location, status: 'ongoing' },
      visibility: 'world', eventTitle: `${people.map(person => person.name).join(' 与 ')} 在${action.location}开始交谈`,
      eventDescription: '居民之间开始了一场交谈。', eventKind: 'dialogue', dialogueId: action.dialogueId,
      dialogueStart: { dialogueId: action.dialogueId, participantIds: action.participantIds, location: action.location, turnLimit: action.turnLimit },
    }
  }
  if (action.type === 'scene_open') {
    if (typeof action.dialogueId !== 'string' || !action.dialogueId || typeof action.visitorId !== 'string'
      || !action.visitorId || !Array.isArray(action.participantIds) || action.participantIds.length < 2
      || action.participantIds.length > 3 || action.participantIds.some(id => typeof id !== 'string' || !id)
      || new Set(action.participantIds).size !== action.participantIds.length || !action.participantIds.includes(action.visitorId)
      || typeof action.location !== 'string' || !hasLocation(action.location)
      || !Number.isSafeInteger(action.turnLimit) || action.turnLimit < 1 || action.turnLimit > 100) {
      throw new WorldStateError('场景交谈发起参数无效', 400)
    }
    const [members, states] = await Promise.all([
      db.select().from(worldPersons).where(and(eq(worldPersons.worldId, worldId), inArray(worldPersons.personId, action.participantIds))).all(),
      db.select().from(personStates).where(and(eq(personStates.timelineId, timelineId), inArray(personStates.personId, action.participantIds))).all(),
    ])
    if (members.length !== action.participantIds.length || states.length !== action.participantIds.length) {
      throw new WorldStateError('场景交谈参与者不属于这个宇宙', 404)
    }
    if (states.some(state => state.location !== action.location || state.currentDialogueId)) {
      throw new WorldStateError('场景交谈参与者没有同时在场或正忙于其他交谈', 409)
    }
    return { factType: 'conversation', subjectId: action.dialogueId,
      value: { dialogueId: action.dialogueId, visitorId: action.visitorId, participants: action.participantIds,
        location: action.location, status: 'scene', kind: 'scene', turnLimit: action.turnLimit },
      visibility: 'world', eventTitle: '', eventDescription: '',
      sceneOpen: { dialogueId: action.dialogueId, visitorId: action.visitorId,
        participantIds: action.participantIds, location: action.location, turnLimit: action.turnLimit } }
  }
  if (action.type === 'dialogue_turn') {
    if (typeof action.dialogueId !== 'string' || !action.dialogueId || typeof action.speakerId !== 'string'
      || !Number.isSafeInteger(action.turnIndex) || action.turnIndex < 0 || typeof action.utterance !== 'string'
      || !action.utterance.trim() || action.utterance.length > 2000 || typeof action.thought !== 'string'
      || !action.thought.trim() || action.thought.length > 2000 || typeof action.shouldEnd !== 'boolean'
      || (action.memory && (typeof action.memory.content !== 'string' || !action.memory.content.trim()
        || action.memory.content.length > 2000 || !Number.isFinite(action.memory.importance)
        || action.memory.importance < 1 || action.memory.importance > 10))) {
      throw new WorldStateError('居民发言记录无效', 400)
    }
    const dialogue = await db.select().from(dialogues).where(and(
      eq(dialogues.id, action.dialogueId), eq(dialogues.timelineId, timelineId), eq(dialogues.status, 'ongoing'),
    )).get()
    if (!dialogue || dialogue.kind !== 'npc') throw new WorldStateError('居民交谈不存在或已结束', 404)
    let participantIds: string[]
    try { participantIds = JSON.parse(dialogue.participantIdsJson) as string[] } catch { participantIds = [] }
    if (participantIds.length < 2 || !participantIds.includes(action.speakerId)) throw new WorldStateError('发言者不属于这场交谈', 403)
    const turns = await db.select().from(dialogueTurns).where(eq(dialogueTurns.dialogueId, dialogue.id)).orderBy(dialogueTurns.turnIndex).all()
    if (turns.length !== action.turnIndex || turns.some((turn, index) => turn.turnIndex !== index)) {
      throw new WorldStateError('交谈轮次已变化，请稍后重试', 409)
    }
    if (participantIds[action.turnIndex % participantIds.length] !== action.speakerId) throw new WorldStateError('当前轮到其他居民发言', 409)
    const states = await db.select().from(personStates).where(and(
      eq(personStates.timelineId, timelineId), inArray(personStates.personId, participantIds),
    )).all()
    if (states.length !== participantIds.length || states.some(state => state.currentDialogueId !== dialogue.id)) {
      throw new WorldStateError('交谈参与者状态已变化', 409)
    }
    const people = await db.select().from(persons).where(inArray(persons.id, participantIds)).all()
    const names = new Map(people.map(person => [person.id, person.name]))
    const counts = new Map<string, number>()
    for (const turn of turns) counts.set(turn.personId, (counts.get(turn.personId) ?? 0) + 1)
    counts.set(action.speakerId, (counts.get(action.speakerId) ?? 0) + 1)
    const closes = action.turnIndex + 1 >= dialogue.turnLimit
      || (action.shouldEnd && participantIds.every(id => (counts.get(id) ?? 0) >= 2))
    const speakerName = names.get(action.speakerId) ?? '某人'
    return {
      factType: 'conversation', subjectId: dialogue.id,
      value: { dialogueId: dialogue.id, turnIndex: action.turnIndex, speakerId: action.speakerId,
        utterance: action.utterance, participants: participantIds, ended: closes },
      visibility: 'world', eventTitle: `${speakerName}在${dialogue.location}说话`,
      eventDescription: action.utterance, eventKind: 'dialogue', dialogueId: dialogue.id,
      dialogueTurn: { dialogueId: dialogue.id, speakerId: action.speakerId, turnIndex: action.turnIndex, participantIds, closes },
    }
  }
  if (action.type === 'resident_state') {
    const member = await db.select().from(worldPersons).where(and(
      eq(worldPersons.worldId, worldId), eq(worldPersons.personId, action.personId),
    )).get()
    const state = await db.select().from(personStates).where(and(
      eq(personStates.personId, action.personId), eq(personStates.timelineId, timelineId),
    )).get()
    const person = await db.select().from(persons).where(eq(persons.id, action.personId)).get()
    if (!member || !state || !person) throw new WorldStateError('居民状态不存在', 404)
    if (!['schedule', 'beat', 'injection', 'agent_act', 'agent_state', 'agent_memory'].includes(action.cause)) throw new WorldStateError('居民状态变更来源无效', 400)
    if (!action.patch || typeof action.patch !== 'object' || Array.isArray(action.patch)) throw new WorldStateError('居民状态变更无效', 400)
    const keys = Object.keys(action.patch)
    if (keys.some(key => !['location', 'activity', 'mood', 'goal', 'lastBeatSimTime'].includes(key))) {
      throw new WorldStateError('居民状态变更字段无效', 400)
    }
    if (action.patch.location != null && !hasLocation(action.patch.location)) throw new WorldStateError('目的地不属于这个世界', 400)
    for (const [label, value] of Object.entries(action.patch)) {
      if (label === 'lastBeatSimTime') {
        if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || value > (action.advanceTo ?? timeline.simNow)) throw new WorldStateError('节拍时间无效', 400)
      } else if (typeof value !== 'string' || !value.trim() || value.length > (label === 'activity' ? 120 : 200)) {
        throw new WorldStateError('居民状态文本无效', 400)
      }
    }
    const resultSimTime = action.advanceTo ?? timeline.simNow
    if (!Number.isFinite(Date.parse(action.windowStart)) || action.windowStart > resultSimTime) throw new WorldStateError('状态变更时间窗口无效', 400)
    if (action.patch.location && action.patch.location !== state.location) {
      await assertUniqueLocationAtTime(action.personId, action.patch.location, resultSimTime)
    }
    if (action.advanceTo != null) {
      const nextTime = Date.parse(action.advanceTo)
      const currentTime = Date.parse(timeline.simNow)
      if (action.cause !== 'agent_act' || !Number.isFinite(nextTime) || nextTime < currentTime
        || nextTime - currentTime > 24 * 60 * 60_000) throw new WorldStateError('居民模拟时间推进无效', 400)
    }
    if (!Array.isArray(action.events) || action.events.length > 3
      || action.events.some(event => !event || !Number.isFinite(Date.parse(event.simTime)) || event.simTime < action.windowStart
        || event.simTime > resultSimTime || typeof event.title !== 'string' || !event.title.trim() || event.title.length > 60
        || typeof event.description !== 'string' || !event.description.trim() || event.description.length > 2000)) {
      throw new WorldStateError('居民经历记录无效', 400)
    }
    if (!Array.isArray(action.memories) || action.memories.length > 2
      || action.memories.some(memory => !memory || !['thought', 'timeline', 'relationship', 'world'].includes(memory.type)
        || typeof memory.content !== 'string' || !memory.content.trim() || memory.content.length > 2000
        || !Number.isFinite(memory.importance) || memory.importance < 1 || memory.importance > 10)) {
      throw new WorldStateError('居民记忆记录无效', 400)
    }
    const changes = Object.fromEntries(keys.map(key => [key, action.patch[key as keyof typeof action.patch]]))
    const after = { ...state, ...action.patch, simTime: resultSimTime }
    const changed = keys.some(key => state[key as keyof typeof state] !== action.patch[key as keyof typeof action.patch])
    if (!changed && !action.events.length && !action.memories.length) throw new WorldStateError('状态没有变化', 409)
    return {
      factType: action.patch.location != null && state.location !== action.patch.location ? 'location' : 'resident_state',
      subjectId: action.personId,
      value: { cause: action.cause, windowStart: action.windowStart, ...(action.advanceTo ? { advanceTo: resultSimTime } : {}),
        before: { location: state.location, activity: state.activity, mood: state.mood, goal: state.goal },
        after: { location: after.location, activity: after.activity, mood: after.mood, goal: after.goal },
        changes, eventCount: action.events.length, memoryCount: action.memories.length },
      visibility: action.cause === 'agent_memory' ? 'private' : 'world',
      eventTitle: `${person.name}的${action.cause === 'schedule' ? '日程' : '生活'}状态发生变化`,
      eventDescription: action.events.length
        ? `${person.name}在${action.events.length}段已记录经历后，状态出现了可追溯变化。`
        : `${person.name}的结构化状态已更新。`,
      statePersonId: action.personId, statePatch: action.patch, storyEvents: action.events, stateMemories: action.memories,
      resultSimTime,
    }
  }
  if (action.type === 'commitment') {
    if (typeof action.commitmentId !== 'string' || typeof action.next !== 'string') throw new WorldStateError('约定参数无效', 400)
    const item = await db.select().from(commitments).where(and(
      eq(commitments.id, action.commitmentId), eq(commitments.worldId, worldId), eq(commitments.timelineId, timelineId),
    )).get()
    if (!item) throw new WorldStateError('约定不存在', 404)
    const transitions: Record<string, string[]> = {
      proposed: ['accepted', 'declined', 'expired'], accepted: ['fulfilled', 'missed'], missed: ['explained'],
    }
    if (!transitions[item.status]?.includes(action.next)) throw new WorldStateError('约定状态已改变，请刷新', 409)
    if (['accepted', 'fulfilled'].includes(action.next) && timeline.simNow >= item.dueSim) throw new WorldStateError('约定已经到期', 409)
    if (['missed', 'expired'].includes(action.next) && timeline.simNow < item.dueSim) throw new WorldStateError('约定尚未到期', 409)
    if (action.next === 'explained' && !action.explanation?.trim()) throw new WorldStateError('需要说明失约原因', 400)
    if (action.next === 'fulfilled') {
      const actorState = await db.select().from(personStates).where(and(eq(personStates.personId, item.personId), eq(personStates.timelineId, timelineId))).get()
      if (!actorState || actorState.location !== item.location || actorState.currentDialogueId) throw new WorldStateError('对方不在约定地点或正在交谈', 409)
      if (item.kind === 'meeting' && Date.parse(item.dueSim) - Date.parse(timeline.simNow) > 30 * 60_000) throw new WorldStateError('还没到见面时间', 409)
    }
    const actor = await db.select().from(persons).where(eq(persons.id, item.personId)).get()
    const visitor = await db.select().from(persons).where(eq(persons.id, item.visitorId)).get()
    const labels: Record<string, string> = { accepted: '已经约好', declined: '婉拒', fulfilled: '如约完成', missed: '未能赴约', expired: '邀请已过期', explained: '已解释失约' }
    const text = `${visitor?.name ?? '来访者'}与${actor?.name ?? '对方'}的「${item.title}」：${labels[action.next]}。${action.explanation ? `说明：${action.explanation.slice(0, 500)}` : ''}`
    return { factType: 'commitment', subjectId: item.id,
      value: { commitmentId: item.id, from: item.status, to: action.next, location: item.location, dueSim: item.dueSim },
      visibility: 'private', eventTitle: `${item.title} · ${labels[action.next]}`, eventDescription: text,
      eventId: `commitment:${item.id}:${action.next}`,
      commitment: { id: item.id, prior: item.status, next: action.next, personId: item.personId, visitorId: item.visitorId,
        dialogueId: item.sourceDialogueId, mood: action.next === 'fulfilled' ? '因对方守约而感到被重视' : action.next === 'missed' ? '约定落空，有些失落' : null, memoryText: text },
    }
  }
  if (action.type === 'commitment_proposal') {
    const title = typeof action.title === 'string' ? action.title.trim() : ''
    const dueMs = typeof action.dueSim === 'string' ? Date.parse(action.dueSim) : NaN
    if (!action.commitmentId || action.commitmentId.length > 160 || !title || title.length > 100
      || (action.kind !== 'meeting' && action.kind !== 'help') || typeof action.location !== 'string' || !hasLocation(action.location)
      || !Number.isFinite(dueMs) || dueMs <= Date.parse(timeline.simNow) || dueMs - Date.parse(timeline.simNow) > 7 * 24 * 60 * 60_000) {
      throw new WorldStateError('约定提议参数无效', 400)
    }
    const [resident, visitor, dialogue, members, open] = await Promise.all([
      db.select().from(persons).where(eq(persons.id, action.personId)).get(),
      db.select().from(persons).where(eq(persons.id, action.visitorId)).get(),
      db.select().from(dialogues).where(and(eq(dialogues.id, action.sourceDialogueId), eq(dialogues.timelineId, timelineId))).get(),
      db.select().from(worldPersons).where(and(eq(worldPersons.worldId, worldId), inArray(worldPersons.personId, [action.personId, action.visitorId]))).all(),
      db.select().from(commitments).where(and(eq(commitments.timelineId, timelineId), eq(commitments.personId, action.personId),
        inArray(commitments.status, ['proposed', 'accepted']))).all(),
    ])
    if (!resident || !visitor || !visitor.isUser || members.length !== 2 || !dialogue || dialogue.kind !== 'scene'
      || dialogue.visitorId !== visitor.id) throw new WorldStateError('约定当事人或来源交谈无效', 403)
    let participantIds: string[]
    try { participantIds = JSON.parse(dialogue.participantIdsJson) as string[] } catch { participantIds = [] }
    if (!participantIds.includes(resident.id) || !participantIds.includes(visitor.id)) throw new WorldStateError('约定当事人不属于来源交谈', 400)
    if (open.length >= 3 || open.some(item => item.visitorId === visitor.id && item.title === title)) {
      throw new WorldStateError('这位居民已经有太多未完成的约定', 409)
    }
    return {
      factType: 'commitment', subjectId: action.commitmentId,
      value: { commitmentId: action.commitmentId, from: null, to: 'proposed', title, kind: action.kind,
        location: action.location, dueSim: action.dueSim, personId: action.personId, visitorId: action.visitorId,
        sourceDialogueId: action.sourceDialogueId },
      visibility: 'private', eventTitle: `${resident.name}提出了一项邀请`,
      eventDescription: '一位居民提出一项邀请；具体内容仅对当事人可见。', eventKind: 'dialogue',
      dialogueId: dialogue.id,
      commitmentProposal: { id: action.commitmentId, personId: action.personId, visitorId: action.visitorId,
        sourceDialogueId: action.sourceDialogueId, title, kind: action.kind, location: action.location, dueSim: action.dueSim },
    }
  }
  throw new WorldStateError('尚不支持这种世界行动', 400)
}
