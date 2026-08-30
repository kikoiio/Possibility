import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { dialogues, dialogueTurns, events, memories, personStates } from '../../db/schema'
import { configFromEnv, complete } from '../../llm/client'
import type { Env } from '../../index'
import { buildEngineContext, type EngineContext, type WorldSnapshot } from '../../agent/engine-context'
import { buildDialoguePrompt, extractJson, type PromptPair } from '../../agent/engine-prompt'
import { clampImportance } from '../../agent/memory'
import type { AgentStep, DecideOpts, DecideResult, StepExecutor } from './types'

type Dialogue = typeof dialogues.$inferSelect
type Turn = typeof dialogueTurns.$inferSelect

export interface DialogueInput {
  step: AgentStep
  snapshot: WorldSnapshot
  ctx: EngineContext // 发言者视角
  dialogue: Dialogue
  turns: Turn[]
  speakerId: string
  turnIndex: number
  isLastTurn: boolean
  prompt: PromptPair
}

export interface DialogueOutput {
  utterance: string
  thought: string
  shouldEnd: boolean
  memory: { content: string; importance: number } | null
  failed: boolean
}

export function normalizeDialogueJson(raw: unknown): Omit<DialogueOutput, 'failed'> {
  const r = (raw ?? {}) as Record<string, unknown>
  const utterance = String(r.utterance ?? '').trim()
  if (!utterance) throw new Error('utterance 为空')
  const thought = String(r.thought ?? '').trim()
  if (!thought) throw new Error('thought 为空')
  let memory: DialogueOutput['memory'] = null
  if (r.memory && typeof r.memory === 'object') {
    const m = r.memory as Record<string, unknown>
    const content = String(m.content ?? '').trim()
    if (content) memory = { content, importance: clampImportance(m.importance) }
  }
  return { utterance, thought, shouldEnd: r.shouldEnd === true, memory }
}

/** 对话轮转（P1）：每拍推进一轮发言；满轮或话尽则收尾并沉淀记忆 */
export const dialogueExecutor: StepExecutor<DialogueInput, DialogueOutput> = {
  async perceive(db: Db, step: AgentStep, snapshot: WorldSnapshot): Promise<DialogueInput | null> {
    if (!step.dialogueId) return null
    const dialogue = await db.select().from(dialogues).where(eq(dialogues.id, step.dialogueId)).get()
    if (!dialogue || dialogue.status !== 'ongoing') return null

    const turns = await db
      .select()
      .from(dialogueTurns)
      .where(eq(dialogueTurns.dialogueId, dialogue.id))
      .orderBy(asc(dialogueTurns.turnIndex))
      .all()

    let participantIds: string[] = []
    try {
      participantIds = (JSON.parse(dialogue.participantIdsJson) as string[]).map(String)
    } catch {
      return null
    }
    if (!participantIds.length) return null

    const turnIndex = turns.length
    const speakerId = participantIds[turnIndex % participantIds.length]
    const ctx = await buildEngineContext(db, speakerId, snapshot)
    if (!ctx) return null

    const othersNames = participantIds
      .filter((id) => id !== speakerId)
      .map((id) => snapshot.persons.find((p) => p.id === id)?.name ?? '对方')
    const isLastTurn = turnIndex + 1 >= dialogue.turnLimit
    const prompt = buildDialoguePrompt(
      ctx,
      othersNames,
      turns.map((t) => ({
        personName: snapshot.persons.find((p) => p.id === t.personId)?.name ?? '某人',
        utterance: t.utterance,
      })),
      { isLastTurn, location: dialogue.location },
    )
    return { step, snapshot, ctx, dialogue, turns, speakerId, turnIndex, isLastTurn, prompt }
  },

  async decide(env: Env, input: DialogueInput, opts?: DecideOpts): Promise<DecideResult<DialogueOutput>> {
    const config = configFromEnv(env)
    let llmCalls = 0
    const maxAttempts = Math.max(1, Math.min(2, opts?.maxCalls ?? 2))
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      llmCalls++
      try {
        const raw = await complete(
          config,
          [
            { role: 'system', content: input.prompt.system },
            { role: 'user', content: input.prompt.user },
          ],
          { maxTokens: 4000 },
        )
        return { value: { ...normalizeDialogueJson(extractJson(raw)), failed: false }, llmCalls }
      } catch {
        // 重试一次
      }
    }
    // D17/任务书：失败不阻塞对话，本轮以占位句跳过
    return {
      value: { utterance: '……（沉默）', thought: '（一时不知该说什么）', shouldEnd: false, memory: null, failed: true },
      llmCalls,
    }
  },

  async act(db: Db, _env: Env, input: DialogueInput, output: DialogueOutput): Promise<string> {
    const simNow = input.snapshot.timeline.simNow
    const now = new Date().toISOString()
    const speaker = input.ctx.person

    await db.insert(dialogueTurns).values({
      id: crypto.randomUUID(),
      dialogueId: input.dialogue.id,
      turnIndex: input.turnIndex,
      personId: input.speakerId,
      utterance: output.utterance,
      thought: output.thought,
      simTime: simNow,
      createdAt: now,
    })
    // 想法同步入记忆流（F6）
    await db.insert(memories).values({
      id: crypto.randomUUID(),
      personId: input.speakerId,
      timelineId: input.step.timelineId,
      type: 'thought',
      content: output.thought,
      simTime: simNow,
      createdAt: now,
      importance: 5,
    })
    if (output.memory) {
      await db.insert(memories).values({
        id: crypto.randomUUID(),
        personId: input.speakerId,
        timelineId: input.step.timelineId,
        type: 'relationship',
        content: output.memory.content,
        simTime: simNow,
        createdAt: now,
        importance: clampImportance(output.memory.importance),
      })
    }

    // 结束条件：满轮，或话尽且每位参与者都已发言 ≥2 轮
    const counts = new Map<string, number>()
    for (const t of input.turns) counts.set(t.personId, (counts.get(t.personId) ?? 0) + 1)
    counts.set(input.speakerId, (counts.get(input.speakerId) ?? 0) + 1)
    let participantIds: string[] = []
    try {
      participantIds = (JSON.parse(input.dialogue.participantIdsJson) as string[]).map(String)
    } catch {
      participantIds = [input.speakerId]
    }
    const everyoneSpokeTwice = participantIds.every((id) => (counts.get(id) ?? 0) >= 2)
    const shouldClose = input.isLastTurn || (output.shouldEnd && everyoneSpokeTwice)

    if (shouldClose) {
      await db
        .update(dialogues)
        .set({ status: 'ended', simEnd: simNow })
        .where(eq(dialogues.id, input.dialogue.id))
      // 解除对话占用（仅当占用标记仍指向本对话——人物可能已被重启后的新对话占用），
      // 并把节拍水位推进到对话结束（对话覆盖了这段时间）
      for (const pid of participantIds) {
        await db
          .update(personStates)
          .set({ lastBeatSimTime: simNow, updatedRealAt: now })
          .where(and(eq(personStates.personId, pid), eq(personStates.timelineId, input.step.timelineId)))
        await db
          .update(personStates)
          .set({ currentDialogueId: null })
          .where(
            and(
              eq(personStates.personId, pid),
              eq(personStates.timelineId, input.step.timelineId),
              eq(personStates.currentDialogueId, input.dialogue.id),
            ),
          )
      }
      const names = participantIds.map((id) => input.snapshot.persons.find((p) => p.id === id)?.name ?? '某人')
      await db
        .update(events)
        .set({ title: `${names.join(' 与 ')} 在${input.dialogue.location}交谈` })
        .where(eq(events.dialogueId, input.dialogue.id))
      return `dialogue 结束（${input.turnIndex + 1} 轮）：${names.join(' × ')}`
    }
    return `dialogue 第 ${input.turnIndex + 1} 轮：${speaker.name}${output.failed ? '（占位）' : ''}`
  },
}
