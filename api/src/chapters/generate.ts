import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import { chapters, events, persons, timelines, worlds, worldPersons } from '../db/schema'
import { complete, configFromEnv, type ChatMessage } from '../llm/client'
import { budgetFromEnv, touchWorldActivity } from '../engine/budget'
import { BudgetRefusal, gateWorld, worldReservation } from '../engine/guard'
import type { Env } from '../index'
import type { ForkScenario } from '../agent/types'

type World = typeof worlds.$inferSelect
type Timeline = typeof timelines.$inferSelect
type Event = typeof events.$inferSelect

export interface ChapterDto {
  id: string
  timelineId: string
  title: string
  content: string
  fromSim: string
  toSim: string
  eventCount: number
  createdAt: string
}

const SYSTEM = `你是「可能性」的驻场叙事者，为一座自主运转的架空小世界撰写章节回顾。
用户会给你一份按时间排列的事件清单，你要把它写成一章小说化的回顾。

只输出一个 JSON 对象（不要任何其他文字，不要代码块）：
{
  "title": "本章标题（不超过 14 字，有韵味，不剧透结局）",
  "content": "正文"
}

正文要求：
- 800-1400 字，第三人称限知视角，文风沉静、有画面感，像一部长篇小说的其中一章。
- 只使用事件清单里的事实，不得编造新的事件、对话或反转；清单之间的空白可以用过渡、氛围与心理描写黏合。
- 对话场景（kind=dialogue）可把对话内容自然织入叙述，标注说话人。
- 人物名单中标注「（在场身份）」的人物是现实世界客人的化身：凡 TA 参与的事件（标题或对话摘录中出现其名字）必须写入正文，且给予与重要性相称的篇幅——这是客人亲历的时刻，不得略过。
- 时间推进要体现：从本章开头到结尾，人物的位置与心境有合理的变化。
- 章末留一个轻轻悬着的钩子（一个未解的细节、一个欲言又止的瞬间），不要总结陈词。
- 全部用中文；不要小标题、不要列表、不要"本章"等元话语。`

export interface ChapterInput {
  worldName: string
  worldDescription: string
  timelineLabel: string
  roster: string
  eventLines: string[]
}

/** 组装章节提示（纯函数，供单测） */
export function buildChapterPrompt(input: ChapterInput): ChatMessage[] {
  const user = [
    `世界：${input.worldName}——${input.worldDescription}`,
    `时间线：${input.timelineLabel}`,
    `人物：${input.roster}`,
    '',
    `事件清单（${input.eventLines.length} 条，按虚拟时间排列）：`,
    ...input.eventLines.map((l) => `- ${l}`),
  ].join('\n')
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ]
}

/** 宽松解析章节 JSON（纯函数，供单测） */
export function normalizeChapter(raw: unknown): { title: string; content: string } {
  const r = (raw ?? {}) as Record<string, unknown>
  const content = String(r.content ?? '').trim()
  if (!content) throw new Error('章节正文为空')
  const title = String(r.title ?? '').trim().slice(0, 30) || '无题'
  return { title, content }
}

function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('返回中未找到 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

function fmtEventLine(e: Event, nameOf: Map<string, string>): string {
  const who = e.actorPersonId ? (nameOf.get(e.actorPersonId) ?? '某人') : null
  const head = e.kind === 'dialogue' ? '一段对话' : e.kind === 'injected' ? '一件外来事件' : null
  const subject = who ?? head ?? '一件事'
  const time = e.simTime.slice(5, 16).replace('T', ' ')
  const desc = e.description?.trim()
  return desc ? `[${time}] ${subject}：${e.title}——${desc}` : `[${time}] ${subject}：${e.title}`
}

function timelineLabelOf(timeline: Timeline): string {
  if (timeline.parentTimelineId === null) return '主线'
  try {
    const s = JSON.parse(timeline.forkScenarioJson || 'null') as ForkScenario | null
    if (s?.whatIf) return `what-if 分叉：「${s.whatIf}」`
  } catch {
    // 忽略损坏场景
  }
  return 'what-if 分叉'
}

const MAX_CHAPTER_EVENTS = 48
const MIN_CHAPTER_EVENTS = 3
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000 // 无上一章时回顾最近 1 虚拟日

/** 人物名单：在场身份（用户的化身）显式标注，叙事者据此优先织入其参与的事件（纯函数，供单测） */
export function rosterLine(persons: { name: string; isUser: boolean }[]): string {
  const line = persons.map((p) => (p.isUser ? `${p.name}（在场身份）` : p.name)).join('、')
  return line || '（无人）'
}

/**
 * 生成章节：取「上一章之后（或最近 1 虚拟日）」的事件 → 一次 LLM 调用写成小说化回顾。
 * 每次 fetch 前原子预留预算（purpose=chapter）；解析失败重试 1 次。
 */
export async function generateChapter(
  env: Env,
  db: Db,
  world: World,
  timeline: Timeline,
): Promise<ChapterDto> {
  const cfg = budgetFromEnv(env)
  const gate = await gateWorld(db, world.id, cfg)
  if (!gate.ok) {
    const err = new Error(gate.error) as Error & { status?: number }
    err.status = gate.status
    throw err
  }
  await touchWorldActivity(db, world.id)

  // 覆盖区间：上一章 toSim 之后；没有则最近 1 虚拟日
  const prev = await db
    .select()
    .from(chapters)
    .where(eq(chapters.timelineId, timeline.id))
    .orderBy(asc(chapters.toSim))
    .all()
  const last = prev[prev.length - 1] ?? null
  const since = last
    ? gt(events.simTime, last.toSim)
    : gt(events.simTime, new Date(Date.parse(timeline.simNow) - DEFAULT_WINDOW_MS).toISOString())

  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.timelineId, timeline.id), since))
    .orderBy(asc(events.simTime))
    .limit(MAX_CHAPTER_EVENTS)
    .all()

  if (rows.length < MIN_CHAPTER_EVENTS) {
    const err = new Error('这段时间还很安静——等世界再运转一会儿，凑满几件事再来写这一章。') as Error & {
      status?: number
    }
    err.status = 400
    throw err
  }

  const wpRows = await db.select().from(worldPersons).where(eq(worldPersons.worldId, world.id)).all()
  const personList = wpRows.length
    ? await db.select().from(persons).where(inArray(persons.id, wpRows.map((r) => r.personId))).all()
    : []
  const nameOf = new Map(personList.map((p) => [p.id, p.name]))
  const roster = rosterLine(personList)

  const messages = buildChapterPrompt({
    worldName: world.name,
    worldDescription: world.description,
    timelineLabel: timelineLabelOf(timeline),
    roster,
    eventLines: rows.map((e) => fmtEventLine(e, nameOf)),
  })

  const config = configFromEnv(env, worldReservation(db, world.id, cfg, {
    timelineId: timeline.id, personId: null, purpose: 'chapter',
  }))
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await complete(config, messages, { maxTokens: 8000 })
      const { title, content } = normalizeChapter(extractJson(raw))
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const dto: ChapterDto = {
        id,
        timelineId: timeline.id,
        title,
        content,
        fromSim: rows[0].simTime,
        toSim: rows[rows.length - 1].simTime,
        eventCount: rows.length,
        createdAt: now,
      }
      await db.insert(chapters).values({ ...dto, worldId: world.id })
      return dto
    } catch (e) {
      if (e instanceof BudgetRefusal) throw e
      lastError = e
    }
  }
  throw lastError instanceof Error ? lastError : new Error('章节生成失败')
}
