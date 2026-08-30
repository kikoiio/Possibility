import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { events, memories, personStates } from '../db/schema'
import type { ToolDef } from '../llm/client'
import { clampImportance } from './memory'
import type { AgentEvent, AgentMode } from './types'

const ACT_TOOL: ToolDef = {
  name: 'act',
  description: '记录你实际采取的一个行动、经历的一件事，会成为时间线事件流中的一条。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '一句话标题，10 字以内' },
      description: { type: 'string', description: '这件事的具体经过，第一人称，两三句话' },
      simTime: { type: 'string', description: '事件发生的虚拟时间，ISO 8601 格式（如 2026-03-05T14:30:00Z）' },
    },
    required: ['title', 'description'],
  },
}

const UPDATE_STATE_TOOL: ToolDef = {
  name: 'update_state',
  description: '更新你当前的状态。地点/活动/情绪/近期目标发生变化时调用；只需给变化的字段。',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string', description: '当前所在地点' },
      activity: { type: 'string', description: '当前正在做的事' },
      mood: { type: 'string', description: '当前情绪' },
      goal: { type: 'string', description: '近期目标' },
    },
  },
}

const REMEMBER_TOOL: ToolDef = {
  name: 'remember',
  description: '把值得长期记住的信息沉淀为记忆：用户的计划与偏好、你们关系的变化、重要的约定等。',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '要记住的事，一句话说清' },
      type: {
        type: 'string',
        enum: ['timeline', 'relationship', 'world'],
        description: 'timeline=发生的事；relationship=与用户或他人的关系；world=世界背景',
      },
      importance: {
        type: 'integer',
        description: '这条记忆的重要程度，1-10（1=日常琐事，10=刻骨铭心）。拿不准就给 5',
      },
    },
    required: ['content'],
  },
}

/** 按模式裁剪工具集：chat 全量；catchup/simulate 只有 act + update_state */
export function toolsFor(mode: AgentMode): ToolDef[] {
  switch (mode) {
    case 'chat':
      return [REMEMBER_TOOL, UPDATE_STATE_TOOL, ACT_TOOL]
    case 'catchup':
    case 'simulate':
      return [ACT_TOOL, UPDATE_STATE_TOOL]
  }
}

/** 一次自主体运行期内的可变状态（虚拟时钟、行动额度、当前状态缓存） */
export interface ToolRunState {
  db: Db
  personId: string
  timelineId: string
  isMain: boolean
  mode: AgentMode
  clock: number // 虚拟时钟（ms 时间戳），随 act 推进
  windowEnd: number | null // catchup 模式的窗口右端（真实 now）
  acts: number
  maxActs: number
  current: { location: string; activity: string; mood: string; goal: string }
}

/** 推进虚拟时钟：优先用模型给的时间，否则按模式步进；单调不减、不超过窗口右端 */
function nextSimTime(run: ToolRunState, provided?: unknown): string {
  let t = typeof provided === 'string' ? Date.parse(provided) : NaN
  if (Number.isNaN(t) || t <= run.clock) {
    const step =
      run.mode === 'catchup' && run.windowEnd
        ? Math.max(Math.floor((run.windowEnd - run.clock) / 8), 60_000)
        : run.mode === 'simulate'
          ? 86_400_000
          : 0
    t = run.clock + step
  }
  if (run.windowEnd && t > run.windowEnd) t = run.windowEnd
  run.clock = t
  return new Date(t).toISOString()
}

export async function executeTool(
  run: ToolRunState,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown; events: AgentEvent[] }> {
  const out: AgentEvent[] = []

  if (name === 'act') {
    if (run.acts >= run.maxActs) {
      return {
        result: { error: `行动次数已达上限（${run.maxActs}），请停止行动并用 update_state 收尾` },
        events: out,
      }
    }
    run.acts++
    const title = String(args.title ?? '').trim().slice(0, 60) || '一个行动'
    const description = String(args.description ?? '').trim()
    const simTime = nextSimTime(run, args.simTime)
    const id = crypto.randomUUID()
    await run.db.insert(events).values({ id, timelineId: run.timelineId, simTime, title, description })
    out.push({ type: 'event', id, simTime, title, description })
    return { result: { ok: true, simTime }, events: out }
  }

  if (name === 'update_state') {
    const patch: Partial<ToolRunState['current']> = {}
    for (const k of ['location', 'activity', 'mood', 'goal'] as const) {
      const v = args[k]
      if (typeof v === 'string' && v.trim()) patch[k] = v.trim()
    }
    Object.assign(run.current, patch)
    const simTime = new Date(run.clock).toISOString()
    await run.db
      .update(personStates)
      .set({ ...patch, simTime, updatedRealAt: new Date().toISOString() })
      .where(and(eq(personStates.personId, run.personId), eq(personStates.timelineId, run.timelineId)))
    out.push({ type: 'state', state: { simTime, ...run.current } })
    return { result: { ok: true }, events: out }
  }

  if (name === 'remember') {
    const content = String(args.content ?? '').trim()
    if (!content) return { result: { error: 'content 不能为空' }, events: out }
    const type = ['timeline', 'relationship', 'world'].includes(String(args.type))
      ? String(args.type)
      : 'timeline'
    const id = crypto.randomUUID()
    await run.db.insert(memories).values({
      id,
      personId: run.personId,
      timelineId: run.isMain ? null : run.timelineId, // 永远写当前所在时间线的桶
      type,
      content,
      simTime: new Date(run.clock).toISOString(),
      createdAt: new Date().toISOString(),
      importance: clampImportance(args.importance),
    })
    out.push({ type: 'memory', id, content })
    return { result: { ok: true }, events: out }
  }

  return { result: { error: `未知工具：${name}` }, events: out }
}
