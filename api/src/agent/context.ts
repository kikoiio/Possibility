import { and, asc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { persons, personStates, timelines, worldPersons, worlds } from '../db/schema'
import { visibleMemories, type Memory } from './memory'
import type { AgentMode, PersonModel } from './types'
import { readPinnedWorldModel } from '../world-state/model'
import { readWorldState } from '../world-state/query'
import { visibleKnowledgeForPerson, type VisibleKnowledgeFact } from './knowledge'
import { residentTimeline, type ResidentTimeline } from './resident-context'
import { buildResidentEvidence, type ResidentEvidence } from './resident-evidence'

type Person = typeof persons.$inferSelect
type World = typeof worlds.$inferSelect
type Timeline = typeof timelines.$inferSelect
type PersonState = typeof personStates.$inferSelect

export interface ResidentPromptContext {
  person: Person
  model: PersonModel
  world: World
  timeline: ResidentTimeline // 居民提示边界只暴露非秘密的最小时间线元数据
  mainTimelineId: string
  isMain: boolean
  memories: Memory[] // 已按隔离规则查询好
  knownFacts: VisibleKnowledgeFact[]
  evidence?: ResidentEvidence[]
  state: PersonState
  mode: AgentMode
}

/** Internal compatibility name; prompt construction uses the resident-safe contract. */
export type AgentContextData = ResidentPromptContext

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
): Promise<ResidentPromptContext | null> {
  const person = await db
    .select()
    .from(persons)
    .where(and(eq(persons.id, opts.personId), eq(persons.userId, opts.userId)))
    .get()
  if (!person) return null

  // 显式时间线决定所属世界；仅省略时间线时才沿用最早加入世界的旧默认值。
  // 共享人物不能因为加入顺序而被强制带回另一个世界。
  let world: World
  let selectedTimeline: Timeline | null = null
  if (opts.timelineId !== null) {
    const scoped = await db
      .select({ world: worlds, timeline: timelines })
      .from(timelines)
      .innerJoin(worlds, eq(timelines.worldId, worlds.id))
      .innerJoin(worldPersons, eq(worldPersons.worldId, worlds.id))
      .where(and(eq(timelines.id, opts.timelineId), eq(worlds.userId, opts.userId), eq(worldPersons.personId, person.id)))
      .get()
    if (!scoped) return null
    world = scoped.world
    selectedTimeline = scoped.timeline
  } else {
    const wp = await db
      .select({ world: worlds })
      .from(worldPersons)
      .innerJoin(worlds, eq(worldPersons.worldId, worlds.id))
      .where(and(eq(worldPersons.personId, person.id), eq(worlds.userId, opts.userId)))
      .orderBy(asc(worldPersons.joinedAt))
      .limit(1)
      .get()
    if (!wp) return null
    world = wp.world
  }

  const mainTimeline = await db
    .select()
    .from(timelines)
    .where(and(eq(timelines.worldId, world.id), isNull(timelines.parentTimelineId)))
    .get()
  if (!mainTimeline) return null

  const timeline = selectedTimeline ?? mainTimeline

  const state = await db
    .select()
    .from(personStates)
    .where(and(eq(personStates.personId, person.id), eq(personStates.timelineId, timeline.id)))
    .get()
  if (!state) return null

  // 记忆可见性统一走 memory.ts（D7：祖先链规则，替代阶段一的 null∪本分叉）
  const mems = await visibleMemories(db, person.id, timeline)
  const pinned = await readPinnedWorldModel(db, world.id, timeline.id)
  const recorded = pinned?.residents.find(resident => resident.id === person.id)
  const structured = await readWorldState(db, world.id, timeline.id)
  const knownFacts = visibleKnowledgeForPerson(structured.current, person.id)
  const evidence = await buildResidentEvidence(db, { timelineId: timeline.id, personId: person.id, knownFacts })

  return {
    person: recorded ? { ...person, name: recorded.name } : person,
    model: (recorded?.model ?? JSON.parse(person.modelJson)) as PersonModel,
    world: pinned ? { ...world, name: pinned.name, description: pinned.description } : world,
    timeline: residentTimeline(timeline),
    mainTimelineId: mainTimeline.id,
    isMain: timeline.id === mainTimeline.id,
    memories: mems,
    knownFacts,
    evidence,
    state,
    mode: opts.mode,
  }
}
