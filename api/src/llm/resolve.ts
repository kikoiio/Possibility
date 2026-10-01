/** BYOK 配置解析链(F5):逐字段合并 世界覆盖 > 用户全局配置 > env 平台兜底。
 * 用户/世界提供了某字段即锁定来源,fail-closed——调用失败不回落 env(F8)。
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { userLlmConfigs, worlds } from '../db/schema'
import type { LlmConfig, ReceiptReservation } from './client'

export type LlmConfigSource = 'world' | 'user' | 'env'

export interface LlmResolution {
  config: LlmConfig
  /** 三个字段中最高优先级的来源,用于错误文案(「用户 Key」「世界覆盖」)。 */
  source: LlmConfigSource
}

interface PartialLlmFields {
  baseUrl?: string | null
  apiKey?: string | null
  model?: string | null
}

function parseWorldOverride(raw: string | null): PartialLlmFields {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as PartialLlmFields
    return {
      baseUrl: typeof value.baseUrl === 'string' && value.baseUrl ? value.baseUrl : null,
      apiKey: typeof value.apiKey === 'string' && value.apiKey ? value.apiKey : null,
      model: typeof value.model === 'string' && value.model ? value.model : null,
    }
  } catch {
    return {} // 坏 JSON 按无覆盖,不阻断世界
  }
}

export async function resolveLlmConfig(
  db: Db,
  env: {
    LLM_BASE_URL: string
    LLM_API_KEY: string
    LLM_MODEL: string
    LLM_PROVIDER?: { fetch(request: Request): Promise<Response> }
  },
  opts: { userId: string; worldId?: string },
  reserve?: ReceiptReservation,
): Promise<LlmResolution> {
  const userRow = await db.select().from(userLlmConfigs).where(eq(userLlmConfigs.userId, opts.userId)).get()
  const worldOverride = opts.worldId
    ? parseWorldOverride((await db.select({ llmConfigJson: worlds.llmConfigJson }).from(worlds)
        .where(eq(worlds.id, opts.worldId)).get())?.llmConfigJson ?? null)
    : {}

  const pick = (world: string | null | undefined, user: string | null | undefined, fallback: string) =>
    world ?? user ?? fallback
  const config: LlmConfig = {
    baseUrl: pick(worldOverride.baseUrl, userRow?.baseUrl, env.LLM_BASE_URL).replace(/\/+$/, ''),
    apiKey: pick(worldOverride.apiKey, userRow?.apiKey, env.LLM_API_KEY),
    model: pick(worldOverride.model, userRow?.model, env.LLM_MODEL),
    provider: env.LLM_PROVIDER,
    reserve,
  }
  const source: LlmConfigSource = worldOverride.baseUrl || worldOverride.apiKey || worldOverride.model
    ? 'world'
    : userRow?.baseUrl || userRow?.apiKey || userRow?.model
      ? 'user'
      : 'env'
  return { config, source }
}

/** 用户/世界来源的失败文案(F8):不静默回落,指向设置页。 */
export function byokFailureHint(source: LlmConfigSource): string | null {
  if (source === 'world') return '世界 LLM 覆盖配置可能已失效,请在该世界的设置中检查 API Key/端点'
  if (source === 'user') return '全局 LLM 配置可能已失效,请在设置页检查 API Key/端点'
  return null
}
