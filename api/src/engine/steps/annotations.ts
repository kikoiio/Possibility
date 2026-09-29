import { nameKeys } from '../../agent/memory'
import type { Memory } from '../../agent/memory'

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

function parseJsonArray(json: string | null): string[] {
  if (!json) return []
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
  } catch {
    return []
  }
}

/**
 * S2 摘要标注合并（F5）：压缩 act 侧的确定性合并，无 LLM。
 * mentions 取并集（首现序去重）；topics 取并集按出现频次降序（首现序决胜）截断前 3；
 * location 取批次内出现次数最多者（并列取较新源）。无标注的源不参与合并；
 * 全部源无标注时返回空标注（与 S1 旧数据回退路径兼容）。
 * sources 按批次顺序（写入时间升序）传入，"较新"即靠后。
 */
export function mergeMemoryAnnotations(sources: Pick<Memory,
  'mentionedPersonIdsJson' | 'locationName' | 'topicsJson'>[]): MemoryAnnotations {
  const mentions: string[] = []
  const seenMentions = new Set<string>()
  const topicCounts = new Map<string, number>()
  const locationStats = new Map<string, { count: number; lastSeen: number }>()
  sources.forEach((m, index) => {
    for (const id of parseJsonArray(m.mentionedPersonIdsJson)) {
      if (!seenMentions.has(id)) { seenMentions.add(id); mentions.push(id) }
    }
    for (const topic of parseJsonArray(m.topicsJson)) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1)
    if (m.locationName) {
      const stat = locationStats.get(m.locationName) ?? { count: 0, lastSeen: -1 }
      locationStats.set(m.locationName, { count: stat.count + 1, lastSeen: index })
    }
  })
  const topics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([topic]) => topic)
    .slice(0, 3)
  let location: string | null = null
  for (const [name, stat] of locationStats) {
    const best = location !== null ? locationStats.get(location)! : null
    if (!best || stat.count > best.count || (stat.count === best.count && stat.lastSeen > best.lastSeen)) location = name
  }
  return { mentions: mentions.slice(0, 20), location, topics }
}
