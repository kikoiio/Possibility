/** 核心迷你回放(S4/F6):把 (anchorVersion, V] 区间命令的核心域效果应用到锚点负载。
 * 只应用不重校验——命令入库时已校验,锚点是可信捕获;全量回放(reduceProjection)
 * 才有诊断义务。动作语义与 projector.ts 的应用侧保持一致,由对照测试防漂移。
 */
import type { worldCommands } from '../db/schema'
import type { AnchorCorePayload } from './anchors'

type Command = typeof worldCommands.$inferSelect

export interface CoreReplayResult extends AnchorCorePayload {
  simTime: string
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function parseAction(command: Command): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(command.payloadJson) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function applyCoreCommands(core: AnchorCorePayload, commands: Command[], fromSimTime: string): CoreReplayResult {
  const states = clone(core.states)
  const schedules = clone(core.schedules)
  const commitments = clone(core.commitments)
  let simTime = fromSimTime
  // 对话的进行中状态影响人物核心字段(currentDialogueId/lastBeatSimTime),跟踪最小 scratch
  const dialogues = new Map<string, { participantIds: string[]; turnLimit: number; turnCount: number; counts: Map<string, number>; visitorId: string | null }>()
  const stateIndex = (personId: string) => states.findIndex((state) => state.personId === personId)
  for (const command of commands) {
    const action = parseAction(command)
    if (!action || typeof action.type !== 'string') continue
    if (action.type === 'clock_advance') {
      if (typeof action.to === 'string' && Date.parse(action.to) > Date.parse(simTime)) simTime = action.to
      continue
    }
    if (action.type === 'enter' || action.type === 'move') {
      const personId = typeof action.personId === 'string' ? action.personId : ''
      const to = typeof action.to === 'string' ? action.to : ''
      const index = stateIndex(personId)
      if (!personId || !to) continue
      if (action.type === 'enter' && index < 0) {
        states.push({ personId, timelineId: command.timelineId, simTime, location: to,
          activity: '刚来到这里', mood: '平静', goal: '探索这个世界', updatedRealAt: command.createdAt,
          currentDialogueId: null, lastBeatSimTime: simTime })
      } else if (action.type === 'move' && index >= 0) {
        states[index] = { ...states[index], location: to, simTime, updatedRealAt: command.createdAt }
      }
      continue
    }
    if (action.type === 'resident_state') {
      const personId = typeof action.personId === 'string' ? action.personId : ''
      const patch = action.patch && typeof action.patch === 'object' && !Array.isArray(action.patch)
        ? action.patch as Record<string, unknown> : null
      const index = stateIndex(personId)
      if (index < 0 || !patch) continue
      const allowed = ['location', 'activity', 'mood', 'goal', 'lastBeatSimTime'] as const
      const clean = Object.fromEntries(Object.entries(patch)
        .filter(([key, value]) => (allowed as readonly string[]).includes(key) && typeof value === 'string'))
      const advanceTo = typeof action.advanceTo === 'string' && action.advanceTo ? action.advanceTo : simTime
      states[index] = { ...states[index], ...clean, simTime: advanceTo, updatedRealAt: command.createdAt }
      if (Date.parse(advanceTo) > Date.parse(simTime)) simTime = advanceTo
      continue
    }
    if (action.type === 'simulation_checkpoint') {
      const personId = typeof action.personId === 'string' ? action.personId : ''
      const lastBeatSimTime = typeof action.lastBeatSimTime === 'string' ? action.lastBeatSimTime : ''
      const index = stateIndex(personId)
      if (index >= 0 && lastBeatSimTime) {
        states[index] = { ...states[index], lastBeatSimTime, updatedRealAt: command.createdAt }
      }
      continue
    }
    if (action.type === 'schedule_set') {
      const personId = typeof action.personId === 'string' ? action.personId : ''
      const worldDate = typeof action.worldDate === 'string' ? action.worldDate : ''
      const generatedAt = typeof action.generatedAt === 'string' ? action.generatedAt : ''
      const items = Array.isArray(action.items) ? action.items : null
      if (!personId || !worldDate || !generatedAt || !items) continue
      if (schedules.some((s) => s.personId === personId && s.worldDate === worldDate)) continue
      schedules.push({ personId, timelineId: command.timelineId, worldDate, itemsJson: JSON.stringify(items), generatedAt })
      continue
    }
    if (action.type === 'commitment_proposal') {
      const id = typeof action.commitmentId === 'string' ? action.commitmentId : ''
      const personId = typeof action.personId === 'string' ? action.personId : ''
      const visitorId = typeof action.visitorId === 'string' ? action.visitorId : ''
      const sourceDialogueId = typeof action.sourceDialogueId === 'string' ? action.sourceDialogueId : ''
      const title = typeof action.title === 'string' ? action.title : ''
      const kind = action.kind === 'meeting' || action.kind === 'help' ? action.kind : null
      const location = typeof action.location === 'string' ? action.location : ''
      const dueSim = typeof action.dueSim === 'string' ? action.dueSim : ''
      if (!id || !personId || !visitorId || !title || !kind || !location || !dueSim) continue
      if (commitments.some((item) => item.id === id)) continue
      commitments.push({ id, worldId: command.worldId, timelineId: command.timelineId, personId, visitorId,
        sourceDialogueId, title, kind, location, dueSim, status: 'proposed', createdSim: simTime,
        updatedSim: simTime, createdAt: command.createdAt })
      continue
    }
    if (action.type === 'conversation') {
      const accepted = Array.isArray(action.acceptedCommitments) ? action.acceptedCommitments : []
      const dialogueId = typeof action.dialogueId === 'string' ? action.dialogueId : ''
      for (const item of accepted) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const row = item as Record<string, unknown>
        if (typeof row.id !== 'string' || typeof row.personId !== 'string' || typeof row.title !== 'string'
          || (row.kind !== 'meeting' && row.kind !== 'help') || typeof row.location !== 'string'
          || typeof row.dueSim !== 'string') continue
        if (commitments.some((existing) => existing.id === row.id)) continue
        commitments.push({ id: row.id, worldId: command.worldId, timelineId: command.timelineId,
          personId: row.personId, visitorId: dialogues.get(dialogueId)?.visitorId ?? '', sourceDialogueId: dialogueId, title: row.title,
          kind: row.kind, location: row.location, dueSim: row.dueSim, status: 'accepted',
          createdSim: simTime, updatedSim: simTime, createdAt: command.createdAt })
      }
      continue
    }
    if (action.type === 'commitment') {
      const id = typeof action.commitmentId === 'string' ? action.commitmentId : ''
      const next = typeof action.next === 'string' ? action.next : ''
      const index = commitments.findIndex((item) => item.id === id)
      if (index >= 0 && next) {
        commitments[index] = { ...commitments[index], status: next, updatedSim: simTime }
      }
      continue
    }
    if (action.type === 'dialogue_start' || action.type === 'scene_open') {
      const dialogueId = typeof action.dialogueId === 'string' ? action.dialogueId : ''
      const participantIds = Array.isArray(action.participantIds)
        ? action.participantIds.filter((id): id is string => typeof id === 'string') : []
      const turnLimit = Number.isSafeInteger(action.turnLimit) ? Number(action.turnLimit) : 0
      const visitorId = action.type === 'scene_open' && typeof action.visitorId === 'string' ? action.visitorId : null
      if (!dialogueId || participantIds.length < 2 || !turnLimit) continue
      dialogues.set(dialogueId, { participantIds, turnLimit, turnCount: 0, counts: new Map(), visitorId })
      if (action.type === 'scene_open') continue
      for (const personId of participantIds) {
        const index = stateIndex(personId)
        if (index >= 0) states[index] = { ...states[index], currentDialogueId: dialogueId, updatedRealAt: command.createdAt }
      }
      continue
    }
    if (action.type === 'dialogue_turn') {
      const dialogueId = typeof action.dialogueId === 'string' ? action.dialogueId : ''
      const speakerId = typeof action.speakerId === 'string' ? action.speakerId : ''
      const dialogue = dialogues.get(dialogueId)
      if (!dialogue) continue
      dialogue.turnCount += 1
      dialogue.counts.set(speakerId, (dialogue.counts.get(speakerId) ?? 0) + 1)
      // 关闭语义与 projector 一致:轮数达上限,或 shouldEnd 且每人至少两句
      const closes = dialogue.turnCount >= dialogue.turnLimit
        || (action.shouldEnd === true && dialogue.participantIds.every((id) => (dialogue.counts.get(id) ?? 0) >= 2))
      if (closes) {
        for (const personId of dialogue.participantIds) {
          const index = stateIndex(personId)
          if (index >= 0) {
            states[index] = { ...states[index], currentDialogueId: null, lastBeatSimTime: simTime, updatedRealAt: command.createdAt }
          }
        }
        dialogues.delete(dialogueId)
      }
      continue
    }
    if (action.type === 'dialogue_recovery') {
      const personId = typeof action.personId === 'string' ? action.personId : ''
      const dialogueId = typeof action.dialogueId === 'string' ? action.dialogueId : ''
      const index = stateIndex(personId)
      if (index >= 0 && dialogueId && states[index].currentDialogueId === dialogueId) {
        states[index] = { ...states[index], currentDialogueId: null, updatedRealAt: command.createdAt }
      }
      continue
    }
    // 其余动作类型(记忆/知识/环境/干预/scene 等)不触碰核心三域,跳过
  }
  return { version: 1, states, schedules, commitments, simTime }
}
