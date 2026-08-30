import { and, eq, gt } from 'drizzle-orm'
import type { Db } from '../db/client'
import { events, persons, personStates, schedules, timelines, worldPersons, worlds } from '../db/schema'
import { retrieveForPrompt, type Memory } from './memory'
import type { PersonModel } from './types'

type World = typeof worlds.$inferSelect
type Timeline = typeof timelines.$inferSelect
type Person = typeof persons.$inferSelect
type PersonState = typeof personStates.$inferSelect
type Schedule = typeof schedules.$inferSelect
type Event = typeof events.$inferSelect

export interface LocationDef {
  name: string
  description: string
}

/** 日程项（schedules.itemsJson 元素）；kind='sleep' 标记睡眠段 */
export interface ScheduleItem {
  start: string // HH:MM（与世界时钟一致）
  end: string
  location: string
  activity: string
  kind?: string
}

/** 引擎每拍对一个（世界 × 时间线）的一次性装载，tick 内所有 step 共享 */
export interface WorldSnapshot {
  world: World
  locations: LocationDef[]
  timeline: Timeline
  persons: Person[]
  models: Map<string, PersonModel>
  states: Map<string, PersonState> // personId → 该时间线的状态
  schedules: Map<string, Schedule> // personId → 当日日程
  worldDate: string // simNow 的日期部分（YYYY-MM-DD）
}

/** 单个决策点的完整上下文（perceive 的产出） */
export interface EngineContext {
  snapshot: WorldSnapshot
  person: Person
  model: PersonModel
  state: PersonState
  others: { person: Person; publicProfile: string; relationMemories: string[] }[]
  memories: Memory[]
  unperceivedEvents: Event[] // kind='injected' 且 simTime > lastBeatSimTime
  sameLocationAwake: Person[] // 同地点、清醒、空闲（相遇候选）
  scheduleItems: ScheduleItem[] | null
}

export function parseLocations(world: World): LocationDef[] {
  try {
    const v = JSON.parse(world.locationsJson || '[]') as unknown
    if (!Array.isArray(v)) return []
    return v
      .map((x) => ({ name: String((x as LocationDef)?.name ?? '').trim(), description: String((x as LocationDef)?.description ?? '').trim() }))
      .filter((x) => x.name)
  } catch {
    return []
  }
}

export function parseScheduleItems(schedule: Schedule | null | undefined): ScheduleItem[] | null {
  if (!schedule) return null
  try {
    const v = JSON.parse(schedule.itemsJson || '[]') as unknown
    if (!Array.isArray(v)) return null
    const items = v
      .map((x) => {
        const it = x as Partial<ScheduleItem>
        return {
          start: String(it.start ?? ''),
          end: String(it.end ?? ''),
          location: String(it.location ?? ''),
          activity: String(it.activity ?? ''),
          ...(it.kind ? { kind: String(it.kind) } : {}),
        }
      })
      .filter((it) => it.start && it.end && it.location)
    return items.length ? items : null
  } catch {
    return null
  }
}

/** 世界日 = simNow 的日期部分（引擎统一以世界时钟的 ISO 文本比较时间） */
export function worldDateOf(simNow: string): string {
  return simNow.slice(0, 10)
}

function hhmmToMin(hhmm: string): number {
  const h = Number(hhmm.slice(0, 2))
  const m = Number(hhmm.slice(3, 5))
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}

const DAY_MIN = 24 * 60

/** hhmm 是否落在日程项内（支持跨夜项，如 23:00-07:00） */
export function itemContains(item: ScheduleItem, hhmm: string): boolean {
  const s = hhmmToMin(item.start)
  let e = hhmmToMin(item.end)
  if (e <= s) e += DAY_MIN
  let now = hhmmToMin(hhmm)
  if (now < s) now += DAY_MIN
  return s <= now && now < e
}

/** 当前时刻对应的日程项（无则 null） */
export function currentScheduleItem(items: ScheduleItem[] | null, simNow: string): ScheduleItem | null {
  if (!items) return null
  const hhmm = simNow.slice(11, 16)
  return items.find((it) => itemContains(it, hhmm)) ?? null
}

/** 当前是否清醒：所在日程段 kind='sleep' 则为睡眠；无日程/无匹配项视为清醒 */
export function isAwake(scheduleItems: ScheduleItem[] | null, simNow: string): boolean {
  const current = currentScheduleItem(scheduleItems, simNow)
  if (!current) return true
  return current.kind !== 'sleep'
}

/** 装载一个（世界 × 时间线）的快照 */
export async function buildWorldSnapshot(db: Db, worldId: string, timelineId: string): Promise<WorldSnapshot | null> {
  const world = await db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  if (!world) return null
  const timeline = await db
    .select()
    .from(timelines)
    .where(and(eq(timelines.id, timelineId), eq(timelines.worldId, worldId)))
    .get()
  if (!timeline) return null

  const wpRows = await db.select().from(worldPersons).where(eq(worldPersons.worldId, worldId)).all()
  const personList: Person[] = []
  for (const wp of wpRows) {
    const p = await db.select().from(persons).where(eq(persons.id, wp.personId)).get()
    if (p) personList.push(p)
  }

  const models = new Map<string, PersonModel>()
  for (const p of personList) {
    try {
      models.set(p.id, JSON.parse(p.modelJson) as PersonModel)
    } catch {
      // 模型损坏的人物保留在 persons 清单中，但无模型——step 执行会失败并跳过
    }
  }

  const states = new Map<string, PersonState>()
  const stateRows = await db.select().from(personStates).where(eq(personStates.timelineId, timelineId)).all()
  for (const s of stateRows) states.set(s.personId, s)

  const worldDate = worldDateOf(timeline.simNow)
  const scheduleRows = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.timelineId, timelineId), eq(schedules.worldDate, worldDate)))
    .all()
  const scheduleMap = new Map<string, Schedule>()
  for (const s of scheduleRows) scheduleMap.set(s.personId, s)

  return { world, locations: parseLocations(world), timeline, persons: personList, models, states, schedules: scheduleMap, worldDate }
}

/** 为某个决策点装配人物级上下文（M3） */
export async function buildEngineContext(db: Db, personId: string, snapshot: WorldSnapshot): Promise<EngineContext | null> {
  const person = snapshot.persons.find((p) => p.id === personId)
  if (!person) return null
  const model = snapshot.models.get(personId)
  if (!model) return null
  const state = snapshot.states.get(personId)
  if (!state) return null

  const memories = await retrieveForPrompt(db, personId, snapshot.timeline)
  const others = snapshot.persons
    .filter((p) => p.id !== personId)
    .map((p) => {
      const m = snapshot.models.get(p.id)
      const publicProfile = (m?.identity ?? [])
        .filter((i) => i.provenance === 'known')
        .slice(0, 2)
        .map((i) => i.text)
        .join('；')
      const norm = p.name.replace(/\s+/g, '')
      const keys = norm.length > 2 ? [norm, norm.slice(0, 2)] : [norm]
      const relationMemories = memories
        .filter((mem) => mem.type === 'relationship' && keys.some((k) => mem.content.includes(k)))
        .slice(-5)
        .map((mem) => mem.content)
      return { person: p, publicProfile, relationMemories }
    })

  const lastBeat = state.lastBeatSimTime ?? ''
  const unperceivedEvents = lastBeat
    ? await db
        .select()
        .from(events)
        .where(and(eq(events.timelineId, snapshot.timeline.id), eq(events.kind, 'injected'), gt(events.simTime, lastBeat)))
        .all()
    : await db
        .select()
        .from(events)
        .where(and(eq(events.timelineId, snapshot.timeline.id), eq(events.kind, 'injected')))
        .all()

  const mySchedule = parseScheduleItems(snapshot.schedules.get(personId))
  const sameLocationAwake = snapshot.persons.filter((p) => {
    if (p.id === personId) return false
    const s = snapshot.states.get(p.id)
    if (!s || s.location !== state.location) return false
    if (s.currentDialogueId) return false
    return isAwake(parseScheduleItems(snapshot.schedules.get(p.id)), snapshot.timeline.simNow)
  })

  return { snapshot, person, model, state, others, memories, unperceivedEvents, sameLocationAwake, scheduleItems: mySchedule }
}
