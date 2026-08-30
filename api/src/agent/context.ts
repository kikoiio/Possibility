import { and, asc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { persons, personStates, timelines, worldPersons, worlds } from '../db/schema'
import { visibleMemories, type Memory } from './memory'
import type { AgentMode, PersonModel } from './types'

type Person = typeof persons.$inferSelect
type World = typeof worlds.$inferSelect
type Timeline = typeof timelines.$inferSelect
type PersonState = typeof personStates.$inferSelect

export interface AgentContextData {
  person: Person
  model: PersonModel
  world: World
  timeline: Timeline // 当前所在时间线（主线也有对应行）
  mainTimelineId: string
  isMain: boolean
  memories: Memory[] // 已按隔离规则查询好
  state: PersonState
  mode: AgentMode
}

/**
 * 按 timelineId 组装自主体上下文。
 * 记忆隔离规则（阶段二 D7）：祖先链 ∪ 自身，限分叉点之前；实现见 memory.ts。
 */
export async function buildAgentContext(
  db: Db,
  opts: {
    userId: string
    personId: string
    timelineId: string | null // null = 主线
    mode: AgentMode
  },
): Promise<AgentContextData | null> {
  const person = await db
    .select()
    .from(persons)
    .where(and(eq(persons.id, opts.personId), eq(persons.userId, opts.userId)))
    .get()
  if (!person) return null

  // 默认世界 = 经 world_persons 找到的最早加入的世界（阶段二 F1：人物可属多世界）
  const wp = await db
    .select({ world: worlds })
    .from(worldPersons)
    .innerJoin(worlds, eq(worldPersons.worldId, worlds.id))
    .where(eq(worldPersons.personId, person.id))
    .orderBy(asc(worldPersons.joinedAt))
    .limit(1)
    .get()
  if (!wp) return null
  const world = wp.world

  const mainTimeline = await db
    .select()
    .from(timelines)
    .where(and(eq(timelines.worldId, world.id), isNull(timelines.parentTimelineId)))
    .get()
  if (!mainTimeline) return null

  let timeline = mainTimeline
  if (opts.timelineId && opts.timelineId !== mainTimeline.id) {
    const fork = await db
      .select()
      .from(timelines)
      .where(and(eq(timelines.id, opts.timelineId), eq(timelines.worldId, world.id)))
      .get()
    if (!fork) return null
    timeline = fork
  }

  const state = await db
    .select()
    .from(personStates)
    .where(and(eq(personStates.personId, person.id), eq(personStates.timelineId, timeline.id)))
    .get()
  if (!state) return null

  // 记忆可见性统一走 memory.ts（D7：祖先链规则，替代阶段一的 null∪本分叉）
  const mems = await visibleMemories(db, person.id, timeline)

  return {
    person,
    model: JSON.parse(person.modelJson) as PersonModel,
    world,
    timeline,
    mainTimelineId: mainTimeline.id,
    isMain: timeline.id === mainTimeline.id,
    memories: mems,
    state,
    mode: opts.mode,
  }
}
