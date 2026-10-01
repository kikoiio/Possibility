import { and, eq, inArray } from 'drizzle-orm'
import { serialize, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import { complete } from '../llm/client'
import { resolveLlmConfig } from '../llm/resolve'
import { budgetFromEnv } from '../engine/budget'
import { userReservation } from '../engine/guard'
import type { Db } from '../db/client'
import { persons } from '../db/schema'
import type { Env } from '../index'
import { draftWorld, type WorldDraft } from '../worlds/draft'
import { generateWorld, WorldGeneratorError } from '../voxel/generate'
import { buildWorldGeneratorMessages } from '../voxel/prompts'
import { libraryManifest } from '../voxel/library-manifest'

export interface VoxelSceneDraftResult {
  world: WorldDraft
  document: SerializedVoxelDocument
  explanation: string
  warnings: string[]
}

/**
 * 把世界骨架翻译成体素生成器的场景描述。
 * 绑定指令是硬约束：每个世界地点必须绑到独立物体（事件蒸馏/在场覆盖层靠它锚定）。
 */
export function buildVoxelSceneDescription(world: WorldDraft, prompt: string): string {
  const spots = world.locations.map(l => `地点「${l.name}」(${l.description})`).join(';')
  return [
    `世界「${world.name}」:${world.description}`,
    `创建者的一句话:${prompt}`,
    `世界包含 ${world.locations.length} 个地点:${spots}。`,
    '每个地点必须由 ops 中一个独立的 place-object 建筑或标志物承载,并登记进 locations(name 与上文逐字一致,objectId 指向承载它的物体);严禁多个地点绑定同一物体。',
    '地点之间留出可行走的道路与庭院;不要逐格铺满植被;主建筑加锁。',
  ].join('\n')
}

/**
 * 体素场景草稿(S1):骨架(draftWorld) → 体素生成(generateWorld) → 地点绑定覆盖校验。
 * LLM 调用走用户 BYOK 链(resolveLlmConfig:世界覆盖 > 用户配置 > 平台兜底);
 * 两段各记一次创建类预算(骨架一次、生成按 attempt 各一次)。
 */
export async function createVoxelSceneDraft(
  env: Env,
  db: Db,
  userId: string,
  request: { requestId: string; prompt: string; personIds: string[] },
  deps: { draftWorldFn?: typeof draftWorld; generateWorldFn?: typeof generateWorld } = {},
): Promise<VoxelSceneDraftResult> {
  const selected = [...new Set(request.personIds)]
  if (selected.length < 1 || selected.length > 6) throw new Error('需要选择 1-6 位居民')
  const owned = await db.select({ id: persons.id }).from(persons).where(and(eq(persons.userId, userId), inArray(persons.id, selected))).all()
  if (owned.length !== selected.length) throw new Error('包含不属于你的居民')

  const world = await (deps.draftWorldFn ?? draftWorld)(env, db, userId, request.prompt)
  const assets = libraryManifest() ?? undefined
  const { config } = await resolveLlmConfig(db, env, { userId }, userReservation(db, userId, budgetFromEnv(env), 'scene'))
  const doc = await (deps.generateWorldFn ?? generateWorld)(buildVoxelSceneDescription(world, request.prompt), 'mist-manor', {
    id: `draft-${request.requestId}`,
    complete: (messages) => complete(config, messages, {
      maxTokens: 16000,
      requestId: request.requestId,
      responseFormat: { type: 'json_object' },
      thinking: { type: 'disabled' },
    }),
    assets,
    // 弱模型修可行走性(净空/连通)偏慢,多给一次机会;确定性归一已兜住机械错误,这里只兜语义错误
    maxAttempts: 4,
    buildMessages: assets ? (desc, theme) => buildWorldGeneratorMessages(desc, theme, assets) : undefined,
  })
  const bound = new Set(doc.locations.map(l => l.name))
  const missing = world.locations.filter(l => !bound.has(l.name))
  if (missing.length > 0) throw new WorldGeneratorError(`有地点没有绑定到场景物体:${missing.map(l => l.name).join('、')}`)
  return {
    world,
    document: JSON.parse(serialize(doc)) as SerializedVoxelDocument,
    explanation: `「${world.name}」已经成形:可以拖一拖、让 AI 改一改,或者直接让这里开始生活。`,
    warnings: [],
  }
}
