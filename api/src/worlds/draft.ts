import { complete, configFromEnv } from '../llm/client'
import type { Env } from '../index'
import { extractJson } from '../agent/engine-prompt'
import type { LocationDef } from '../agent/engine-context'

export interface WorldDraft {
  name: string
  description: string
  locations: LocationDef[]
}

const SYSTEM = `你是世界创建助手，为一款「多个人物自主生活的小世界」文字体验工作。
用户会给一句话描述，你要生成一个世界骨架。
只输出一个 JSON 对象（不要任何其他文字，不要代码块）：
{
  "name": "世界名称（简短）",
  "description": "世界背景，三四句话：时代、地点、氛围、住在这里的人们",
  "locations": [{"name": "地点名", "description": "一句话描述"}]
}
要求：
- 地点 5-8 个，覆盖居住/工作/社交/户外等不同功能，方便人物日常活动与相遇。
- 世界要适合 3-6 个人物的长期生活：有日常、有关系的可能、有一点可生长的悬念。
- 描述里不出现"用户""玩家"等词；世界是自足运转的。
- 用中文。`

function normalizeDraft(raw: unknown): WorldDraft {
  const r = (raw ?? {}) as Record<string, unknown>
  const name = String(r.name ?? '').trim()
  const description = String(r.description ?? '').trim()
  if (!name || !description) throw new Error('骨架缺少名称或描述')
  const locsRaw = Array.isArray(r.locations) ? r.locations : []
  const locations: LocationDef[] = locsRaw
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>
      return { name: String(o.name ?? '').trim(), description: String(o.description ?? '').trim() }
    })
    .filter((l) => l.name)
  if (locations.length < 5 || locations.length > 8) throw new Error(`地点数 ${locations.length} 不在 5-8`)
  return { name, description, locations }
}

/** Quick World 骨架生成（不落库）；解析失败重试一次 */
export async function draftWorld(env: Env, prompt: string): Promise<WorldDraft> {
  const config = configFromEnv(env)
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await complete(
        config,
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt },
        ],
        { maxTokens: 8000 },
      )
      return normalizeDraft(extractJson(raw))
    } catch (e) {
      lastError = e
    }
  }
  throw lastError instanceof Error ? lastError : new Error('世界骨架生成失败')
}
