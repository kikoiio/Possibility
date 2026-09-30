import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { persons, personStates, worldPersons, worlds, timelines } from '../db/schema'

/**
 * 世界级 fork 预览（S2/F2）：以世界为上下文起草五字段场景的 prompt 与 brief 组装。
 * 只做组装，不做 LLM 调用——便于单测；调用方在 worlds/routes.ts。
 */

/** 世界观视角的设定师 prompt：startTime 恒为当前时刻，changedVariable 只改一件事 */
export const WORLD_PREVIEW_SYSTEM = `你是「可能性设定师」。用户要为一个多人生活的世界创建 what-if 平行宇宙。
根据世界背景、居民近况与用户的 what-if，给出明确的分叉场景设定。
只输出一个 JSON 对象（不要任何其他文字，不要代码块）：
{
  "whatIf": "用户的原话",
  "startTime": "分叉起始时间，ISO 8601，必须是给定的当前时刻，不得早于或晚于它",
  "changedVariable": "被改变的那一个条件，一句话",
  "participants": ["涉及的人物，从居民名单中选"],
  "invariants": ["保持不变的条件"]
}
要求：changedVariable 只改一件事；participants 只从给出的居民中选，不确定就留空；invariants 2-4 条；用中文。`

/** 居民摘要上限：brief 中至多列出的人数 */
const MAX_RESIDENTS_IN_BRIEF = 12

type WorldRow = typeof worlds.$inferSelect
type TimelineRow = typeof timelines.$inferSelect

/** 组装世界级 fork 预览的用户 brief：世界观 + 居民近况 + 用户 what-if */
export async function buildWorldForkBrief(
  db: Db,
  world: WorldRow,
  source: TimelineRow,
  whatIf: string,
): Promise<string> {
  const residents = await db
    .select({
      name: persons.name,
      location: personStates.location,
      activity: personStates.activity,
      mood: personStates.mood,
      goal: personStates.goal,
    })
    .from(worldPersons)
    .innerJoin(persons, eq(persons.id, worldPersons.personId))
    .leftJoin(
      personStates,
      and(eq(personStates.personId, worldPersons.personId), eq(personStates.timelineId, source.id)),
    )
    .where(eq(worldPersons.worldId, world.id))
    .limit(MAX_RESIDENTS_IN_BRIEF)

  const residentLines = residents.length
    ? residents
        .map((r) => `- ${r.name}：${r.location ?? '位置未知'}；${r.activity ?? '忙着自己的事'}；情绪 ${r.mood ?? '平静'}；目标 ${r.goal ?? '无'}`)
        .join('\n')
    : '（世界暂无居民）'

  return [
    `世界：${world.name}——${world.description}`,
    `当前时刻：${source.simNow}`,
    `居民近况：`,
    residentLines,
    '',
    `用户的 what-if：「${whatIf}」`,
  ].join('\n')
}
