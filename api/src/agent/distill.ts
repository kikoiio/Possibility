import { complete, configFromEnv, type ChatMessage } from '../llm/client'
import type { Env } from '../index'
import type { InitialState, ModelItem, PersonModel } from './types'

export interface DistillResult {
  name: string
  model: PersonModel
  worldName: string
  worldDescription: string
  initialState: InitialState
}

const SYSTEM = `你是人物卡创建助手，为一款虚构平行世界文字体验工作。
用户会给你一段描述，你要根据描述**创建**一张分层人物卡。

创建规则：
- 描述里出现的人名**逐字**作为人物卡的姓名（name 字段），不增字、不减字、不改字；描述里的城市、经历、关系等事实原样进入人物卡，不得改名、不得泛化（如"杭州"不得写成"某城市"）。
- 描述没说的方面可以补充发挥，这类条目 provenance 标 "inferred"；描述明确说的标 "known"。
- 只输出一个 JSON 对象（不要输出任何其他文字，不要使用代码块）。

JSON 结构：
{
  "name": "人物名字",
  "model": {
    "identity": [{"text": "...", "provenance": "known 或 inferred"}],
    "behavior": [同上],
    "speech": [同上],
    "skills": [同上],
    "memories": [同上],
    "relationships": [同上],
    "boundaries": [同上],
    "unknowns": ["...", "..."]
  },
  "worldName": "世界名称（简短）",
  "worldDescription": "世界背景，两三句话",
  "initialState": {"location": "...", "activity": "...", "mood": "...", "goal": "..."}
}

各层含义：
- identity：生平、身份、价值观、偏好
- behavior：面对情境如何判断与反应
- speech：语气、口头禅、交流节奏
- skills：专业能力、爱好
- memories：从描述中提取的重要经历（源记忆）
- relationships：与用户及他人的关系
- boundaries：TA 不应声称知道或做到的事（行为护栏）
- unknowns：描述中缺失、但对扮演此人重要的信息（信息空白）

要求：
- 描述中明确给出的信息（人名、年龄、地点、职业等）必须原样使用，不得改名、不得泛化成"某城市"、不得标注"待定"。
- provenance：描述里明确说的标 "known"（确知），合理推测的标 "inferred"（推断）。
- unknowns 至少 2 条（除非描述极其详尽）。
- 每层 2-6 条，简明具体，避免空话。
- 世界背景适合这个人物的日常生活。
- initialState 是"此刻"：创建这个时间点 TA 最可能在哪、做什么、情绪如何、近期目标。
- 全部用中文（人名等专有名词除外）。`

function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('返回中未找到 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

function toItems(v: unknown): ModelItem[] {
  if (!Array.isArray(v)) return []
  const out: ModelItem[] = []
  for (const it of v) {
    if (typeof it === 'string' && it.trim()) {
      out.push({ text: it.trim(), provenance: 'inferred' })
    } else if (it && typeof it === 'object') {
      const text = String((it as { text?: unknown }).text ?? '').trim()
      if (!text) continue
      const provenance = (it as { provenance?: unknown }).provenance === 'known' ? 'known' : 'inferred'
      out.push({ text, provenance })
    }
  }
  return out
}

function toStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((s) => String(s ?? '').trim()).filter(Boolean)
}

/** 把任意输入归一化为合法 PersonModel（缺层补空数组） */
export function normalizeModel(v: unknown): PersonModel {
  const m = (v ?? {}) as Record<string, unknown>
  return {
    identity: toItems(m.identity),
    behavior: toItems(m.behavior),
    speech: toItems(m.speech),
    skills: toItems(m.skills),
    memories: toItems(m.memories),
    relationships: toItems(m.relationships),
    boundaries: toItems(m.boundaries),
    unknowns: toStrings(m.unknowns),
  }
}

function normalizeDistill(raw: unknown): DistillResult {
  const r = (raw ?? {}) as Record<string, unknown>
  const name = String(r.name ?? '').trim() || '未命名'
  const state = (r.initialState ?? {}) as Record<string, unknown>
  return {
    name,
    model: normalizeModel(r.model),
    worldName: String(r.worldName ?? '').trim() || `${name}的世界`,
    worldDescription: String(r.worldDescription ?? '').trim() || '一个普通的世界。',
    initialState: {
      location: String(state.location ?? '').trim() || '未知地点',
      activity: String(state.activity ?? '').trim() || '未知活动',
      mood: String(state.mood ?? '').trim() || '平静',
      goal: String(state.goal ?? '').trim() || '暂无',
    },
  }
}

/** 一次性蒸馏（非自主体回合，纯 JSON 输出）；解析失败重试 1 次 */
export async function distillPerson(env: Env, description: string): Promise<DistillResult> {
  const config = configFromEnv(env)
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: description },
  ]
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 推理模型会先消耗 reasoning tokens，预算要给足
      const raw = await complete(config, messages, { maxTokens: 16000 })
      return normalizeDistill(extractJson(raw))
    } catch (e) {
      lastError = e
    }
  }
  throw lastError instanceof Error ? lastError : new Error('创建人物失败')
}
