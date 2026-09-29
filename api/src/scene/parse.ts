import { normalizeDialogueJson } from '../engine/steps/dialogue'
import type { MemoryAnnotations } from '../engine/steps/annotations'
import { contractViolation, LLM_CONTRACT_VERSIONS } from '../llm/contracts'
import { parseInvitation, type Invitation } from '../life/service'

export interface SceneOutput {
  utterance: string
  thought: string
  shouldEnd: boolean
  memory: ({ content: string; importance: number } & MemoryAnnotations) | null
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
export function parseSceneOutput(raw: unknown, people: { id: string; name: string }[] = [], locationNames: string[] = []): SceneOutput {
  const version = LLM_CONTRACT_VERSIONS.sceneResponse
  const base = normalizeDialogueJson(raw, version, people, locationNames)
  const record = raw as Record<string, unknown>
  const wordRaw = record.word
  const commitmentRaw = record.commitment
  const commitment = parseInvitation(commitmentRaw)
  if (commitmentRaw != null && !commitment) return contractViolation(version, 'commitment 结构或业务范围非法')
  const responseRaw = record.visitorInvitationResponse
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
  if (responseRaw != null && !visitorInvitationResponse) {
    return contractViolation(version, 'visitorInvitationResponse 结构或业务范围非法')
  }
  if (wordRaw != null && typeof wordRaw !== 'string') return contractViolation(version, 'word 必须是字符串或 null')
  const word = typeof wordRaw === 'string' ? wordRaw.trim() : ''
  if (word.length > WORD_MAX) return contractViolation(version, `word 不能超过 ${WORD_MAX} 字`)
  return { ...base, word: word || null, commitment, visitorInvitationResponse }
}
