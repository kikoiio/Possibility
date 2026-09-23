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
  visitorInvitationResponse: { decision: 'accepted'; invitation: Invitation } | { decision: 'declined' } | null
}

const WORD_MAX = 200
const EXPLICIT_INVITATION_CUE = /(?:邀请|约你|要不要(?:和我|跟我|一起|陪我|帮我)|愿不愿意|能不能(?:陪我|帮我|跟我|和我)|可不可以(?:陪我|帮我|跟我|和我)|有空(?:吗|没有).{0,20}(?:一起|陪|帮)|(?:和我一起|跟我一起|陪我|帮我).{0,24}(?:吧|好吗|可以吗|行吗|怎么样)|would you like to|can you (?:join|help) me|are you free to)/i

/** Only an explicit in-world request can authorize a durable accepted promise. */
export function containsExplicitInvitationRequest(text: string): boolean {
  return EXPLICIT_INVITATION_CUE.test(text)
}

/** 解析 scene 回应 JSON（纯函数，供单测）：复用对话格式 + 可选 word 留言字段 */
export function parseSceneOutput(raw: unknown): SceneOutput {
  const base = normalizeDialogueJson(raw)
  const wordRaw = (raw as Record<string, unknown> | null)?.word
  const commitment = parseInvitation((raw as Record<string, unknown> | null)?.commitment)
  const responseRaw = (raw as Record<string, unknown> | null)?.visitorInvitationResponse
  const response = responseRaw && typeof responseRaw === 'object'
    ? responseRaw as Record<string, unknown> : null
  const visitorInvitationResponse = response?.decision === 'declined'
    ? { decision: 'declined' as const }
    : response?.decision === 'accepted'
      ? (() => {
        const invitation = parseInvitation(response.invitation)
        return invitation ? { decision: 'accepted' as const, invitation } : null
      })()
      : null
  if (typeof wordRaw !== 'string') return { ...base, word: null, commitment, visitorInvitationResponse }
  const word = wordRaw.trim().slice(0, WORD_MAX)
  return { ...base, word: word || null, commitment, visitorInvitationResponse }
}
