import { and, asc, desc, eq, gte, inArray, isNull, ne, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import { dialogues, dialogueTurns, events, memories, persons, personStates, schedules, timelines, worldPersons, worlds } from '../db/schema'
import { parseLocations, parseScheduleItems, worldDateOf, type LocationDef, type ScheduleItem } from '../agent/engine-context'

type World = typeof worlds.$inferSelect

/** 世界快照（M4/M5 共用只读查询）：世界视图首屏一次性装载 */
export interface WorldSnapshotDto {
  world: {
    id: string
    name: string
    description: string
    status: string
    pauseReason: string | null
    isDemo: boolean
    callsToday: number
    locations: LocationDef[]
  }
  timelines: {
    id: string
    parentTimelineId: string | null
    status: string
    simNow: string
    createdAt: string
    forkScenario: unknown | null
  }[]
  currentTimelineId: string
  simNow: string
  locationBoard: { location: string; persons: { id: string; name: string; activity: string }[] }[]
  events: WorldEventDto[]
}

export interface WorldEventDto {
  id: string
  simTime: string
  title: string
  description: string
  kind: string
  actorPersonId: string | null
  actorName: string | null
  dialogueId: string | null
  dialoguePreview: { personName: string; utterance: string }[] | null
}

export async function worldSnapshot(db: Db, worldId: string, timelineId?: string): Promise<WorldSnapshotDto | null> {
  const world = await db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  if (!world) return null

  const tls = await db.select().from(timelines).where(eq(timelines.worldId, worldId)).orderBy(asc(timelines.createdAt)).all()
  if (!tls.length) return null
  const current = (timelineId && tls.find((t) => t.id === timelineId)) || tls.find((t) => t.parentTimelineId === null) || tls[0]

  const wpRows = await db.select().from(worldPersons).where(eq(worldPersons.worldId, worldId)).all()
  const personIds = wpRows.map((r) => r.personId)
  const personList = personIds.length
    ? await db.select().from(persons).where(inArray(persons.id, personIds)).all()
    : []
  const nameOf = new Map(personList.map((p) => [p.id, p.name]))

  const stateRows = await db.select().from(personStates).where(eq(personStates.timelineId, current.id)).all()

  const locations = parseLocations(world)
  const locationBoard = locations.map((loc) => ({
    location: loc.name,
    persons: stateRows
      .filter((s) => s.location === loc.name)
      .map((s) => ({ id: s.personId, name: nameOf.get(s.personId) ?? '某人', activity: s.activity })),
  }))
  // 状态地点不在世界地点列表里的（LLM 自由移动）归入「他处」
  const known = new Set(locations.map((l) => l.name))
  const elsewhere = stateRows.filter((s) => !known.has(s.location))
  if (elsewhere.length) {
    locationBoard.push({
      location: '他处',
      persons: elsewhere.map((s) => ({ id: s.personId, name: nameOf.get(s.personId) ?? '某人', activity: s.activity })),
    })
  }

  // 近 1 世界日事件（对话事件带前两句预览）
  const since = new Date(Date.parse(current.simNow) - 24 * 60 * 60 * 1000).toISOString()
  const eventRows = await db
    .select()
    .from(events)
    .where(and(eq(events.timelineId, current.id), gte(events.simTime, since)))
    .orderBy(asc(events.simTime))
    .all()

  const dialogueIds = [...new Set(eventRows.map((e) => e.dialogueId).filter(Boolean))] as string[]
  const previewMap = new Map<string, { personName: string; utterance: string }[]>()
  for (const did of dialogueIds) {
    const turns = await db
      .select()
      .from(dialogueTurns)
      .where(eq(dialogueTurns.dialogueId, did))
      .orderBy(asc(dialogueTurns.turnIndex))
      .limit(2)
      .all()
    previewMap.set(
      did,
      turns.map((t) => ({ personName: nameOf.get(t.personId) ?? '某人', utterance: t.utterance })),
    )
  }

  return {
    world: {
      id: world.id,
      name: world.name,
      description: world.description,
      status: world.status,
      pauseReason: world.pauseReason,
      isDemo: world.isDemo,
      callsToday: world.callsToday,
      locations,
    },
    timelines: tls.map((t) => ({
      id: t.id,
      parentTimelineId: t.parentTimelineId,
      status: t.status,
      simNow: t.simNow,
      createdAt: t.createdAt,
      forkScenario: t.forkScenarioJson ? (JSON.parse(t.forkScenarioJson) as unknown) : null,
    })),
    currentTimelineId: current.id,
    simNow: current.simNow,
    locationBoard,
    events: eventRows.map((e) => ({
      id: e.id,
      simTime: e.simTime,
      title: e.title,
      description: e.description,
      kind: e.kind,
      actorPersonId: e.actorPersonId,
      actorName: e.actorPersonId ? (nameOf.get(e.actorPersonId) ?? null) : null,
      dialogueId: e.dialogueId,
      dialoguePreview: e.dialogueId ? (previewMap.get(e.dialogueId) ?? []) : null,
    })),
  }
}

/** 人物详情（世界视图抽屉）：状态/想法流/当日日程/近期记忆 */
export interface PersonFocusDto {
  person: { id: string; name: string }
  state: {
    simTime: string
    location: string
    activity: string
    mood: string
    goal: string
    currentDialogueId: string | null
  } | null
  thoughts: { id: string; simTime: string | null; content: string; createdAt: string }[]
  schedule: ScheduleItem[] | null
  memories: { id: string; type: string; content: string; simTime: string | null; importance: number }[]
}

export async function personFocus(db: Db, worldId: string, personId: string, timelineId: string): Promise<PersonFocusDto | null> {
  const member = await db
    .select()
    .from(worldPersons)
    .where(and(eq(worldPersons.worldId, worldId), eq(worldPersons.personId, personId)))
    .get()
  if (!member) return null
  const person = await db.select().from(persons).where(eq(persons.id, personId)).get()
  if (!person) return null
  const timeline = await db
    .select()
    .from(timelines)
    .where(and(eq(timelines.id, timelineId), eq(timelines.worldId, worldId)))
    .get()
  if (!timeline) return null

  const state = await db
    .select()
    .from(personStates)
    .where(and(eq(personStates.personId, personId), eq(personStates.timelineId, timelineId)))
    .get()

  // 记忆桶：主线 = NULL ∪ 主线 id；分叉 = 自身（与 memory.ts 的桶约定一致）
  const isMain = timeline.parentTimelineId === null
  const bucket = isMain
    ? or(isNull(memories.timelineId), eq(memories.timelineId, timelineId))
    : eq(memories.timelineId, timelineId)

  const thoughts = await db
    .select()
    .from(memories)
    .where(and(eq(memories.personId, personId), bucket, eq(memories.type, 'thought')))
    .orderBy(desc(memories.createdAt))
    .limit(50)
    .all()

  const recentMemories = await db
    .select()
    .from(memories)
    .where(and(eq(memories.personId, personId), bucket, ne(memories.type, 'thought')))
    .orderBy(desc(memories.createdAt))
    .limit(20)
    .all()

  const worldDate = worldDateOf(timeline.simNow)
  const scheduleRow = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.personId, personId), eq(schedules.timelineId, timelineId), eq(schedules.worldDate, worldDate)))
    .get()

  return {
    person: { id: person.id, name: person.name },
    state: state
      ? {
          simTime: state.simTime,
          location: state.location,
          activity: state.activity,
          mood: state.mood,
          goal: state.goal,
          currentDialogueId: state.currentDialogueId,
        }
      : null,
    thoughts: thoughts.map((t) => ({ id: t.id, simTime: t.simTime, content: t.content, createdAt: t.createdAt })),
    schedule: parseScheduleItems(scheduleRow),
    memories: recentMemories.map((m) => ({ id: m.id, type: m.type, content: m.content, simTime: m.simTime, importance: m.importance })),
  }
}

/** 对话逐句展开（含每句内心想法与说话人姓名） */
export interface DialogueDetailDto {
  dialogue: {
    id: string
    timelineId: string
    location: string
    status: string
    turnLimit: number
    simStart: string
    simEnd: string | null
    participants: { id: string; name: string }[]
  }
  turns: { turnIndex: number; personId: string; personName: string; utterance: string; thought: string; simTime: string }[]
}

export async function dialogueDetail(db: Db, dialogueId: string): Promise<DialogueDetailDto | null> {
  const dialogue = await db.select().from(dialogues).where(eq(dialogues.id, dialogueId)).get()
  if (!dialogue) return null
  let participantIds: string[] = []
  try {
    participantIds = (JSON.parse(dialogue.participantIdsJson) as string[]).map(String)
  } catch {
    participantIds = []
  }
  const personList = participantIds.length
    ? await db.select().from(persons).where(inArray(persons.id, participantIds)).all()
    : []
  const nameOf = new Map(personList.map((p) => [p.id, p.name]))

  const turns = await db
    .select()
    .from(dialogueTurns)
    .where(eq(dialogueTurns.dialogueId, dialogueId))
    .orderBy(asc(dialogueTurns.turnIndex))
    .all()

  return {
    dialogue: {
      id: dialogue.id,
      timelineId: dialogue.timelineId,
      location: dialogue.location,
      status: dialogue.status,
      turnLimit: dialogue.turnLimit,
      simStart: dialogue.simStart,
      simEnd: dialogue.simEnd,
      participants: participantIds.map((id) => ({ id, name: nameOf.get(id) ?? '某人' })),
    },
    turns: turns.map((t) => ({
      turnIndex: t.turnIndex,
      personId: t.personId,
      personName: nameOf.get(t.personId) ?? '某人',
      utterance: t.utterance,
      thought: t.thought,
      simTime: t.simTime,
    })),
  }
}

/** 仅供世界路由复用：按 id 取世界 */
export async function getWorld(db: Db, worldId: string): Promise<World | null> {
  const w = await db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  return w ?? null
}
