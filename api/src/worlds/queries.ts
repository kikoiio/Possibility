import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import { dialogues, dialogueTurns, events, persons, personStates, schedules, timelines, universeRevisions, voxelEventProjections, worldPersons, worlds } from '../db/schema'
import type { WorldEvent } from '@possibility/voxel-contract'
import { parseLocations, parseScheduleItems, worldDateOf, type LocationDef, type ScheduleItem } from '../agent/engine-context'
import { visibleMemories } from '../agent/memory'
import { ancestorCutoffs, readForkSnapshot, selectVisibleEvents } from '../agent/visibility'
import { hydrateTimelines } from '../life/snapshot-store'
import { readPinnedWorldModel } from '../world-state/model'
import { readWorldState } from '../world-state/query'
import { readPublicUniverseEvidence, type PublicUniverseEvidence } from '../world-state/evidence-status'
import { effectiveTimeZone } from './time-zone'

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
    timeZone: string
    locations: LocationDef[]
  }
  timelines: {
    id: string
    parentTimelineId: string | null
    status: string
    simNow: string
    createdAt: string
    forkScenario: unknown | null
    timeZone: string
  }[]
  currentTimelineId: string
  simNow: string
  stateVersion: number
  worldModelVersion: number | null
  evidenceStatus: 'structured' | 'legacy'
  evidence: PublicUniverseEvidence
  currentFacts: { id: string; version: number; simTime: string; factType: string; subjectId: string; value: unknown; sourceCommandId: string }[]
  locationBoard: { location: string; persons: { id: string; name: string; activity: string }[] }[]
  events: WorldEventDto[]
  /** S4 世界模拟:体素视口事件(蒸馏投影,仅本线行;无体素文档/未蒸馏 = []) */
  voxelEvents: WorldEvent[]
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
  location: string | null
  dialoguePreview: { personName: string; utterance: string }[] | null
}

export async function worldSnapshot(db: Db, worldId: string, timelineId?: string): Promise<WorldSnapshotDto | null> {
  const world = await db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  if (!world) return null

  const tls = await hydrateTimelines(db,
    await db.select().from(timelines).where(eq(timelines.worldId, worldId)).orderBy(asc(timelines.createdAt)).all())
  if (!tls.length) return null
  // 显式指定的时间线必须属于本世界；不能悄悄回落主线。
  const current = timelineId !== undefined
    ? tls.find((t) => t.id === timelineId)
    : tls.find((t) => t.parentTimelineId === null) || tls[0]
  if (!current) return null
  const revision = await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, current.id)).get()
  const pinned = revision ? await readPinnedWorldModel(db, worldId, current.id) : null
  const structuredState = await readWorldState(db, worldId, current.id)

  const wpRows = await db.select().from(worldPersons).where(eq(worldPersons.worldId, worldId)).all()
  const personIds = wpRows.map((r) => r.personId)
  const personList = personIds.length
    ? await db.select().from(persons).where(inArray(persons.id, personIds)).all()
    : []
  const nameOf = new Map(personList.map((p) => [p.id, pinned?.residents.find(r => r.id === p.id)?.name ?? p.name]))

  const stateRows = await db.select().from(personStates).where(eq(personStates.timelineId, current.id)).all()

  const locations = pinned?.locations ?? parseLocations(world)
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
  const eventTimelineIds = new Set([current.id])
  if (!readForkSnapshot(current)) {
    for (const cutoff of ancestorCutoffs(current, tls)) eventTimelineIds.add(cutoff.timelineId)
  }
  const eventCandidates = await db
    .select()
    .from(events)
    .where(inArray(events.timelineId, [...eventTimelineIds]))
    .orderBy(asc(events.simTime))
    .all()
  const visibleEvents = selectVisibleEvents(eventCandidates, current, tls).events
  const eventRows = visibleEvents.filter((event) => event.simTime >= since && event.simTime <= current.simNow)

  const dialogueIds = [...new Set(eventRows.map((e) => e.dialogueId).filter(Boolean))] as string[]
  const previewMap = new Map<string, { personName: string; utterance: string }[]>()
  const dialogueRows = dialogueIds.length
    ? await db.select({ id: dialogues.id, location: dialogues.location }).from(dialogues).where(inArray(dialogues.id, dialogueIds)).all()
    : []
  const dialogueLocationMap = new Map(dialogueRows.map((dialogue) => [dialogue.id, dialogue.location]))
  const checkpoint = readForkSnapshot(current)
  for (const did of dialogueIds) {
    const inherited = eventRows.some(event => event.dialogueId === did && event.timelineId !== current.id)
    if (inherited) {
      const included = checkpoint?.dialogues?.some(dialogue => dialogue.id === did) ?? false
      const turns = included
        ? (checkpoint?.dialogueTurns ?? []).filter(turn => turn.dialogueId === did).sort((a, b) => a.turnIndex - b.turnIndex).slice(0, 2)
        : []
      previewMap.set(did, turns.map(turn => ({ personName: nameOf.get(turn.personId) ?? '某人', utterance: turn.utterance })))
      continue
    }
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

  // S4 世界模拟:本线体素事件投影(派生数据;坏行跳过不致命)
  const projectionRows = await db.select({ payloadJson: voxelEventProjections.payloadJson })
    .from(voxelEventProjections).where(eq(voxelEventProjections.timelineId, current.id)).all()
  const voxelEvents = projectionRows.flatMap((row) => {
    try {
      const payload = JSON.parse(row.payloadJson) as { event?: WorldEvent }
      return payload?.event ? [payload.event] : []
    } catch { return [] }
  }).sort((a, b) => a.timeWindow.start.localeCompare(b.timeWindow.start) || a.id.localeCompare(b.id))

  return {
    world: {
      id: world.id,
      name: pinned?.name ?? world.name,
      description: pinned?.description ?? world.description,
      status: world.status,
      pauseReason: world.pauseReason,
      isDemo: world.isDemo,
      callsToday: world.callsToday,
      timeZone: effectiveTimeZone(world.timeZone),
      locations,
    },
    timelines: tls.map((t) => ({
      id: t.id,
      parentTimelineId: t.parentTimelineId,
      status: t.status,
      simNow: t.simNow,
      createdAt: t.createdAt,
      forkScenario: t.forkScenarioJson ? (JSON.parse(t.forkScenarioJson) as unknown) : null,
      timeZone: effectiveTimeZone(world.timeZone),
    })),
    currentTimelineId: current.id,
    simNow: current.simNow,
    stateVersion: revision?.version ?? 0,
    worldModelVersion: revision?.worldModelVersion ?? null,
    evidenceStatus: structuredState.evidenceStatus,
    evidence: structuredState.evidence,
    currentFacts: structuredState.current.filter(f => f.visibility === 'world').map(f => ({ id: f.id, version: f.version,
      simTime: f.simTime, factType: f.factType, subjectId: f.subjectId, value: f.value, sourceCommandId: f.sourceCommandId })),
    locationBoard,
    voxelEvents,
    events: eventRows.map((e) => ({
      id: e.id,
      simTime: e.simTime,
      title: e.title,
      description: e.description,
      kind: e.kind,
      actorPersonId: e.actorPersonId,
      actorName: e.actorPersonId ? (nameOf.get(e.actorPersonId) ?? null) : null,
      dialogueId: e.dialogueId,
      location: e.dialogueId ? (dialogueLocationMap.get(e.dialogueId) ?? null) : null,
      dialoguePreview: e.dialogueId ? (previewMap.get(e.dialogueId) ?? []) : null,
    })),
  }
}

/** 人物详情（世界视图抽屉）：状态/想法流/当日日程/近期记忆 */
export interface PersonFocusDto {
  person: { id: string; name: string }
  evidence: PublicUniverseEvidence
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
  memories: { id: string; type: string; content: string; simTime: string | null; createdAt: string; importance: number; summarized: boolean }[]
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

  // Keep the drawer consistent with the memories residents can actually recall:
  // inherited checkpoint rows are visible, while post-fork ancestor rows are not.
  const visible = await visibleMemories(db, personId, timeline)
  const newestFirst = <T extends { createdAt: string; id: string }>(rows: T[]) =>
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const thoughts = newestFirst(visible.filter((memory) => memory.type === 'thought')).slice(0, 50)
  const recentMemories = newestFirst(visible.filter((memory) => memory.type !== 'thought')).slice(0, 20)

  const worldDate = worldDateOf(timeline.simNow)
  const scheduleRow = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.personId, personId), eq(schedules.timelineId, timelineId), eq(schedules.worldDate, worldDate)))
    .get()

  return {
    person: { id: person.id, name: person.name },
    evidence: await readPublicUniverseEvidence(db, timelineId),
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
    memories: recentMemories.map((m) => ({ id: m.id, type: m.type, content: m.content, simTime: m.simTime, createdAt: m.createdAt, importance: m.importance, summarized: m.summarized })),
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

export async function dialogueDetail(db: Db, dialogueId: string, timelineId?: string): Promise<DialogueDetailDto | null> {
  let dialogue: typeof dialogues.$inferSelect | undefined
  let turns: (typeof dialogueTurns.$inferSelect)[]
  if (timelineId !== undefined) {
    const currentRow = await db.select().from(timelines).where(eq(timelines.id, timelineId)).get()
    if (!currentRow) return null
    const current = (await hydrateTimelines(db, [currentRow]))[0]
    const checkpoint = readForkSnapshot(current)
    const isVisibleCheckpointDialogue = checkpoint?.events.some(event => event.dialogueId === dialogueId) ?? false
    if (isVisibleCheckpointDialogue) {
      dialogue = checkpoint?.dialogues?.find(item => item.id === dialogueId)
      if (!dialogue) return null // Older checkpoint: do not expose mutable ancestor turns as frozen history.
      turns = (checkpoint?.dialogueTurns ?? []).filter(turn => turn.dialogueId === dialogueId)
        .sort((a, b) => a.turnIndex - b.turnIndex)
    } else {
      dialogue = await db.select().from(dialogues).where(and(eq(dialogues.id, dialogueId), eq(dialogues.timelineId, timelineId))).get()
      if (!dialogue) return null
      turns = await db.select().from(dialogueTurns).where(eq(dialogueTurns.dialogueId, dialogueId))
        .orderBy(asc(dialogueTurns.turnIndex)).all()
    }
  } else {
    dialogue = await db.select().from(dialogues).where(eq(dialogues.id, dialogueId)).get()
    if (!dialogue) return null
    turns = await db.select().from(dialogueTurns).where(eq(dialogueTurns.dialogueId, dialogueId))
      .orderBy(asc(dialogueTurns.turnIndex)).all()
  }
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
