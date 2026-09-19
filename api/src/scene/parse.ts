import { normalizeDialogueJson } from '../engine/steps/dialogue'
import { parseInvitation, type Invitation } from '../life/service'

export interface SceneOutput {
  utterance: string
  thought: string
  shouldEnd: boolean
  memory: { content: string; importance: number } | null
  /** 想托付给来访者的事（邀约/提醒/口信）；没有则为 null */
  word: string | null
  commitment: Invitation | null
}

const WORD_MAX = 200

/** 解析 scene 回应 JSON（纯函数，供单测）：复用对话格式 + 可选 word 留言字段 */
export function parseSceneOutput(raw: unknown): SceneOutput {
  const base = normalizeDialogueJson(raw)
  const wordRaw = (raw as Record<string, unknown> | null)?.word
  const commitment = parseInvitation((raw as Record<string, unknown> | null)?.commitment)
  if (typeof wordRaw !== 'string') return { ...base, word: null, commitment }
  const word = wordRaw.trim().slice(0, WORD_MAX)
  return { ...base, word: word || null, commitment }
}
