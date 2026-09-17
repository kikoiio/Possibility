/**
 * 在场交谈（scene）的纯规划函数。
 * scene 在数据模型上就是一段对话：含用户在场身份在内的多方对话，
 * 一次说完即收尾（status='ended'），因此事件流可复用对话的展开阅读，
 * 章节也能把这场相遇连同对话内容一起织进小说。
 */

/** 对话标题：与引擎对话收尾标题同一风格（「A 与 B、C 在餐厅交谈」） */
export function sceneDialogueTitle(personaName: string, responderNames: string[], location: string): string {
  return `${personaName} 与 ${responderNames.join('、')} 在${location}交谈`
}

export interface SceneTranscriptTurn {
  name: string
  utterance: string
}

/** 章节回顾用的对话摘录上限（超出截断，避免事件行过长撑爆章节提示词） */
export const SCENE_TRANSCRIPT_MAX = 800

/** 对话摘录：每句「名字：「话」」全角空格拼接；空输入返回空串 */
export function sceneTranscript(turns: SceneTranscriptTurn[]): string {
  const text = turns
    .map((t) => ({ name: t.name.trim(), utterance: t.utterance.trim() }))
    .filter((t) => t.name && t.utterance)
    .map((t) => `${t.name}：「${t.utterance}」`)
    .join('　')
  if (text.length <= SCENE_TRANSCRIPT_MAX) return text
  return `${text.slice(0, SCENE_TRANSCRIPT_MAX)}…`
}
