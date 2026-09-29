import { nameKeys } from '../../agent/memory'

/** S1 情境标注（契约 v2）：宽松解析,非法即丢弃,绝不阻断 memory 本体写入(D4) */
export interface MemoryAnnotations {
  mentions: string[] // 人物 ID(由名字映射;未知名称丢弃)
  location: string | null // 须为世界地点之一,否则 null
  topics: string[] // 1-3 个主题词
}

export const EMPTY_ANNOTATIONS: MemoryAnnotations = { mentions: [], location: null, topics: [] }

/**
 * 从 LLM 的 memory 对象宽松解析三字段。
 * people 为可提及人物清单(通常不含本人);locationNames 为世界地点清单。
 */
export function parseMemoryAnnotations(
  m: Record<string, unknown>,
  people: { id: string; name: string }[],
  locationNames: string[],
): MemoryAnnotations {
  const nameToId = new Map<string, string>()
  for (const p of people) for (const key of nameKeys(p.name)) if (key && !nameToId.has(key)) nameToId.set(key, p.id)
  const mentions = Array.isArray(m.mentions)
    ? [...new Set(m.mentions
        .filter((x): x is string => typeof x === 'string')
        .map((x) => nameToId.get(x.replace(/\s+/g, '')) ?? nameToId.get(x.replace(/\s+/g, '').slice(0, 2)))
        .filter((x): x is string => !!x))].slice(0, 20)
    : []
  const location = typeof m.location === 'string' && locationNames.includes(m.location) ? m.location : null
  const topics = Array.isArray(m.topics)
    ? m.topics.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim().slice(0, 50)).slice(0, 3)
    : []
  return { mentions, location, topics }
}
