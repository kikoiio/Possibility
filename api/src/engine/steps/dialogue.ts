import { asc, eq } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { dialogues, dialogueTurns } from '../../db/schema'
import { completeContract } from '../../llm/client'
import { contractViolation, LLM_CONTRACT_VERSIONS, parseContractObject, requireBoolean, requireNumber,
  requireString } from '../../llm/contracts'
import type { Env } from '../../index'
import { buildEngineContext, type EngineContext, type WorldSnapshot } from '../../agent/engine-context'
import { buildDialoguePrompt, type PromptPair } from '../../agent/engine-prompt'
import { clampImportance } from '../../agent/memory'
import { parseMemoryAnnotations, type MemoryAnnotations } from './annotations'
import type { AgentStep, DecideOpts, DecideResult, StepExecutor } from './types'
import { llmConfigFor } from './types'
import { recordDialogueTurn } from '../../world-state/system'

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
  memory: ({ content: string; importance: number } & MemoryAnnotations) | null
  failed: boolean
}

export function normalizeDialogueJson(
  raw: unknown,
  version: string = LLM_CONTRACT_VERSIONS.dialogue,
  people: { id: string; name: string }[] = [],
  locationNames: string[] = [],
): Omit<DialogueOutput, 'failed'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return contractViolation(version, '输出必须是对象')
  const r = raw as Record<string, unknown>
  const utterance = requireString(r.utterance, 'utterance', version, 2000)
  const thought = requireString(r.thought, 'thought', version, 2000)
  let memory: DialogueOutput['memory'] = null
  if (r.memory && typeof r.memory === 'object') {
    if (Array.isArray(r.memory)) return contractViolation(version, 'memory 必须是对象或 null')
    const m = r.memory as Record<string, unknown>
    memory = { content: requireString(m.content, 'memory.content', version, 2000),
      importance: requireNumber(m.importance, 'memory.importance', version, 1, 10),
      ...parseMemoryAnnotations(m, people, locationNames) }
  } else if (r.memory !== undefined && r.memory !== null) {
    return contractViolation(version, 'memory 必须是对象或 null')
  }
  return { utterance, thought, shouldEnd: requireBoolean(r.shouldEnd, 'shouldEnd', version), memory }
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

  async decide(env: Env, input: DialogueInput, opts: DecideOpts): Promise<DecideResult<DialogueOutput>> {
    const config = llmConfigFor(env, opts.llm, opts.reserve)
    let llmCalls = 0
    const maxAttempts = Math.max(0, Math.min(2, opts?.maxCalls ?? 2))
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      llmCalls++
      try {
        const output = await completeContract(
          config,
          [
            { role: 'system', content: input.prompt.system },
            { role: 'user', content: input.prompt.user },
          ],
          { maxTokens: 4000, contractVersion: LLM_CONTRACT_VERSIONS.dialogue,
            parse: raw => normalizeDialogueJson(parseContractObject(raw, LLM_CONTRACT_VERSIONS.dialogue),
              LLM_CONTRACT_VERSIONS.dialogue,
              input.ctx.others.map((o) => ({ id: o.person.id, name: o.person.name })),
              input.snapshot.locations.map((l) => l.name)) },
        )
        return { value: { ...output, failed: false }, llmCalls: opts?.reserve?.calls ?? llmCalls }
      } catch {
        // 重试一次
      }
    }
    // D17/任务书：失败不阻塞对话，本轮以占位句跳过
    return {
      value: { utterance: '……（沉默）', thought: '（一时不知该说什么）', shouldEnd: false, memory: null, failed: true },
      llmCalls: opts?.reserve?.calls ?? llmCalls,
    }
  },

  async act(db: Db, env: Env, input: DialogueInput, output: DialogueOutput): Promise<string> {
    const simNow = input.snapshot.timeline.simNow
    const speaker = input.ctx.person

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

    await recordDialogueTurn(db, {
      worldId: input.step.worldId, timelineId: input.step.timelineId,
      sourceKey: `dialogue:${input.dialogue.id}:${input.turnIndex}`,
      engineTickLeaseToken: env.ENGINE_TICK_LEASE_TOKEN,
      action: { type: 'dialogue_turn', dialogueId: input.dialogue.id, speakerId: input.speakerId,
        turnIndex: input.turnIndex, utterance: output.utterance, thought: output.thought,
        memory: output.memory ? { content: output.memory.content, importance: clampImportance(output.memory.importance),
          mentions: output.memory.mentions, location: output.memory.location, topics: output.memory.topics } : null,
        shouldEnd: output.shouldEnd },
    })
    if (shouldClose) {
      const names = participantIds.map((id) => input.snapshot.persons.find((p) => p.id === id)?.name ?? '某人')
      return `dialogue 结束（${input.turnIndex + 1} 轮）：${names.join(' × ')}`
    }
    return `dialogue 第 ${input.turnIndex + 1} 轮：${speaker.name}${output.failed ? '（占位）' : ''}`
  },
}
