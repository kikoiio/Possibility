/** 人物模型与自主体共享类型（对齐 plan.md 核心数据结构） */

export type Provenance = 'known' | 'inferred' // 确知 / 推断

export interface ModelItem {
  text: string
  provenance: Provenance
}

export interface PersonModel {
  identity: ModelItem[] // 生平、身份、价值观、偏好
  behavior: ModelItem[] // 面对情境如何判断、反应
  speech: ModelItem[] // 语气、口头禅、交流节奏
  skills: ModelItem[] // 专业能力、爱好
  memories: ModelItem[] // 创建时从描述中提取的源记忆
  relationships: ModelItem[] // 与用户及他人的关系
  boundaries: ModelItem[] // TA 不应声称的事（行为护栏）
  unknowns: string[] // 明确不知道的（信息空白）
}

export interface InitialState {
  location: string
  activity: string
  mood: string
  goal: string
}

export interface ForkScenario {
  whatIf: string
  startTime: string
  changedVariable: string
  participants: string[]
  invariants: string[]
}

export type AgentMode = 'chat' | 'catchup' | 'simulate'

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'event'; id: string; simTime: string; title: string; description: string }
  | {
      type: 'state'
      state: { simTime: string; location: string; activity: string; mood: string; goal: string }
    }
  | { type: 'memory'; id: string; content: string }
  | { type: 'done'; llmCalls?: number }
