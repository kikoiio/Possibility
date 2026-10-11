import { and, eq, inArray } from 'drizzle-orm'
import { serialize, type SceneAction, type SceneRedactedSummary, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import { complete } from '../llm/client'
import { resolveLlmConfig } from '../llm/resolve'
import { budgetFromEnv } from '../engine/budget'
import { userReservation, type Reservation } from '../engine/guard'
import type { Db } from '../db/client'
import { persons } from '../db/schema'
import type { Env } from '../index'
import { draftWorld, type WorldDraft } from '../worlds/draft'
import { generateWorld, WorldGeneratorError } from '../voxel/generate'
import { buildWorldGeneratorMessages } from '../voxel/prompts'
import { libraryManifest } from '../voxel/library-manifest'
import { buildFallbackScene, fallbackContentHash } from './fallback'

export interface VoxelSceneDraftResult {
  world: WorldDraft
  document: SerializedVoxelDocument
  explanation: string
  warnings: string[]
  callsUsed: number
  source?: 'generated' | 'fallback'
  fallback?: boolean
  contentHash?: string
  actions?: SceneAction[]
  summary?: SceneRedactedSummary
}

export interface VoxelSceneDraftError extends Error {
  callsUsed: number
}

/**
 * 把世界骨架翻译成体素生成器的场景描述。
 * 绑定指令是硬约束：每个世界地点必须绑到独立物体（事件蒸馏/在场覆盖层靠它锚定）。
 */
export function buildVoxelSceneDescription(world: WorldDraft, prompt: string, residentNames: string[] = []): string {
  const spots = world.locations.map(l => `地点「${l.name}」(${l.description})`).join(';')
  return [
    `世界「${world.name}」:${world.description}`,
    ...(residentNames.length ? [`这里已经绑定的居民:${residentNames.join('、')}`] : []),
    `创建者的一句话:${prompt}`,
    `世界包含 ${world.locations.length} 个地点:${spots}。`,
    '每个地点必须由 ops 中一个独立的 place-object 或 assetPlacements 中带独立 id 的摆放承载，并登记进 locations(name 与上文逐字一致,objectId 指向该物体或摆放 id);严禁多个地点绑定同一物体。',
    '咖啡馆、车站、住宅等主要建筑必须在实际几何中可辨认，不能只在地点名或说明里声称存在，也不能用灯、长椅、树或其他装饰替代建筑。库中没有对应建筑时，用允许的方块构造其形状并保留独立承载物。',
    '保留创建者明确要求的道路材质、走向、层数和禁止项；道路要在画面中连续可辨认，并连接主要建筑的可站立入口。先给道路留出净空，再把建筑放在道路两侧，不要用连续围栏或墙把入口围死。',
    '地点之间留出可行走的道路与庭院;不要逐格铺满植被;主建筑加锁。',
  ].join('\n')
}

export interface FixedWorldVoxelSceneDraft {
  worldId: string
  document: SerializedVoxelDocument
  explanation: string
  warnings: string[]
  callsUsed: number
  source?: 'generated' | 'fallback'
  fallback?: boolean
  contentHash?: string
  actions?: SceneAction[]
  summary?: SceneRedactedSummary
}

function draftSummary(input: {
  source: 'generated' | 'fallback'
  serialized: string
  callsUsed: number
  fallback?: boolean
  summary?: string
}): SceneRedactedSummary {
  return {
    redacted: true,
    source: input.source,
    providerCalls: input.callsUsed,
    contentHash: fallbackContentHash(input.serialized),
    fallback: input.fallback ?? false,
    persisted: false,
    summary: input.summary,
    nextStep: input.fallback ? 'enter' : 'recheck',
  }
}

function fallbackForWorld(
  world: { id?: string; name?: string; description?: string; locations: Array<{ name: string; description?: string }> },
  residents: Array<{ id: string; name?: string }>,
): ReturnType<typeof buildFallbackScene> {
  return buildFallbackScene({
    world: { id: world.id, name: world.name, description: world.description, locations: world.locations },
    residents: residents.map((resident) => ({ personId: resident.id, name: resident.name })),
  })
}

/** Generate a scene for an existing world without drafting or persisting a new world skeleton. */
export async function createFixedWorldVoxelSceneDraft(
  env: Env,
  db: Db,
  userId: string,
  request: {
    requestId: string
    prompt: string
    world: { id: string } & WorldDraft
    residents: { id: string; name: string }[]
  },
  deps: { generateWorldFn?: typeof generateWorld; allowFallback?: boolean } = {},
): Promise<FixedWorldVoxelSceneDraft> {
  if (!request.requestId || !request.prompt.trim()) throw new Error('请提供场景描述和请求标识')
  if (request.world.locations.length === 0 || request.residents.length === 0) throw new Error('原世界资料不完整，无法补建场景')
  const residentIds = [...new Set(request.residents.map(person => person.id))]
  const owned = await db.select({ id: persons.id }).from(persons)
    .where(and(eq(persons.userId, userId), inArray(persons.id, residentIds))).all()
  if (owned.length !== residentIds.length) throw new Error('原世界包含不属于当前账号的居民')

  let sceneReceipt: Pick<Reservation, 'calls'> | undefined
  try {
    const reserve = userReservation(db, userId, budgetFromEnv(env), 'scene')
    sceneReceipt = reserve
    const { config } = await resolveLlmConfig(db, env, { userId, worldId: request.world.id }, reserve)
    const assets = libraryManifest() ?? undefined
    let doc
    try {
      doc = await (deps.generateWorldFn ?? generateWorld)(
        buildVoxelSceneDescription(request.world, request.prompt, request.residents.map(person => person.name)),
        'mist-manor',
        {
        id: `repair-${request.world.id}-${request.requestId}`,
        complete: messages => complete(config, messages, {
          maxTokens: 16000,
          requestId: request.requestId,
          responseFormat: { type: 'json_object' },
          thinking: { type: 'disabled' },
        }),
        assets,
        maxAttempts: 4,
        requiredLocationNames: request.world.locations.map(location => location.name),
        buildMessages: assets ? (description, theme) => buildWorldGeneratorMessages(description, theme, assets) : undefined,
        },
      )
    } catch (error) {
      const allowFallback = deps.allowFallback ?? !deps.generateWorldFn
      const fallback = allowFallback ? fallbackForWorld(request.world, request.residents) : null
      if (!fallback?.ok) throw error
      const serialized = JSON.stringify(fallback.document)
      return {
        worldId: request.world.id,
        document: fallback.document,
        explanation: fallback.explanation,
        warnings: [...fallback.warnings, `生成失败后已使用确定性保底场景：${error instanceof Error ? error.message : '未知错误'}`],
        callsUsed: sceneReceipt.calls,
        source: 'fallback', fallback: true, contentHash: fallback.contentHash,
        actions: ['enter', 'repair'],
        summary: draftSummary({ source: 'fallback', serialized, callsUsed: sceneReceipt.calls, fallback: true, summary: fallback.explanation }),
      }
    }
    const expected = request.world.locations.map(location => location.name)
    const actual = doc.locations.map(location => location.name)
    if (actual.length !== expected.length || new Set(actual).size !== actual.length
      || expected.some(location => !actual.includes(location))) {
      throw new WorldGeneratorError('生成场景的地点与原世界不匹配', [], [], 'binding')
    }
    return {
      worldId: request.world.id,
      document: JSON.parse(serialize(doc)) as SerializedVoxelDocument,
      explanation: `「${request.world.name}」的场景已经成形，可以继续调整后保存到原世界。`,
      warnings: [],
      callsUsed: sceneReceipt.calls,
      source: 'generated',
      contentHash: fallbackContentHash(JSON.stringify(JSON.parse(serialize(doc)))),
      actions: ['recheck', 'enter'],
      summary: draftSummary({ source: 'generated', serialized: serialize(doc), callsUsed: sceneReceipt.calls, summary: '场景生成完成，请在保存前完成最终兼容检查。' }),
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    Object.assign(failure, { callsUsed: sceneReceipt?.calls ?? 0 })
    throw failure
  }
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
  deps: { draftWorldFn?: typeof draftWorld; generateWorldFn?: typeof generateWorld; allowFallback?: boolean } = {},
): Promise<VoxelSceneDraftResult> {
  const selected = [...new Set(request.personIds)]
  if (selected.length < 1 || selected.length > 6) throw new Error('需要选择 1-6 位居民')
  const owned = await db.select({ id: persons.id }).from(persons).where(and(eq(persons.userId, userId), inArray(persons.id, selected))).all()
  if (owned.length !== selected.length) throw new Error('包含不属于你的居民')

  let skeletonReceipt: Pick<Reservation, 'calls'> | undefined
  let sceneReceipt: Pick<Reservation, 'calls'> | undefined
  const callsUsed = () => (skeletonReceipt?.calls ?? 0) + (sceneReceipt?.calls ?? 0)
  try {
    const world = await (deps.draftWorldFn ?? draftWorld)(env, db, userId, request.prompt, receipt => { skeletonReceipt = receipt })
    const assets = libraryManifest() ?? undefined
    const reserve = userReservation(db, userId, budgetFromEnv(env), 'scene')
    sceneReceipt = reserve
    const { config } = await resolveLlmConfig(db, env, { userId }, reserve)
    let doc
    try {
      doc = await (deps.generateWorldFn ?? generateWorld)(buildVoxelSceneDescription(world, request.prompt), 'mist-manor', {
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
        requiredLocationNames: world.locations.map(location => location.name),
        buildMessages: assets ? (desc, theme) => buildWorldGeneratorMessages(desc, theme, assets) : undefined,
      })
    } catch (error) {
      const allowFallback = deps.allowFallback ?? !deps.generateWorldFn
      const fallback = allowFallback ? fallbackForWorld({ ...world, id: `draft-${request.requestId}` }, selected.map(id => ({ id }))) : null
      if (!fallback?.ok) throw error
      const serialized = JSON.stringify(fallback.document)
      return {
        world,
        document: fallback.document,
        explanation: fallback.explanation,
        warnings: [...fallback.warnings, `生成失败后已使用确定性保底场景：${error instanceof Error ? error.message : '未知错误'}`],
        callsUsed: callsUsed(),
        source: 'fallback', fallback: true, contentHash: fallback.contentHash,
        actions: ['enter', 'repair'],
        summary: draftSummary({ source: 'fallback', serialized, callsUsed: callsUsed(), fallback: true, summary: fallback.explanation }),
      }
    }
    const bound = new Set(doc.locations.map(l => l.name))
    const missing = world.locations.filter(l => !bound.has(l.name))
    if (missing.length > 0) throw new WorldGeneratorError(`有地点没有绑定到场景物体:${missing.map(l => l.name).join('、')}`, [], [], 'binding')
    return {
      world,
      document: JSON.parse(serialize(doc)) as SerializedVoxelDocument,
      explanation: `「${world.name}」已经成形:可以拖一拖、让 AI 改一改,或者直接让这里开始生活。`,
      warnings: [],
      callsUsed: callsUsed(),
      source: 'generated',
      contentHash: fallbackContentHash(serialize(doc)),
      actions: ['recheck', 'enter'],
      summary: draftSummary({ source: 'generated', serialized: serialize(doc), callsUsed: callsUsed(), summary: '场景生成完成，请在保存前完成最终兼容检查。' }),
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    Object.assign(failure, { callsUsed: callsUsed() })
    throw failure
  }
}
