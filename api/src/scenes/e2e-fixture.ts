import {
  applyEdits,
  createEmptyWorld,
  serialize,
  type EditOperation,
  type SerializedVoxelDocument,
} from '@possibility/voxel-contract'

const locations = [
  ['河畔住区', '安静的居民街巷'],
  ['街角咖啡馆', '邻里相遇的咖啡馆'],
  ['社区杂货铺', '日常采购的小店'],
  ['河边书屋', '临河阅读空间'],
  ['旧车站', '连接社区的站点'],
]

/** Deterministic model-provider substitute, injected only by the isolated s02-e2e Wrangler config. */
export async function s02SceneFixture(request: Request): Promise<Response> {
  const payload = await request.json() as { messages: { content: string }[] }
  const userMessage = JSON.parse(payload.messages.at(-1)?.content ?? '{}') as { selectedResidents?: { id: string }[]; description?: string }
  const residentId = userMessage.selectedResidents?.[0]?.id
  if (!residentId) return Response.json({ error: 'selectedResidents missing' }, { status: 400 })
  const buildings = ['home-small', 'cafe-corner', 'grocery-small', 'bookshop-small', 'station-stop']
  const positions = [{ x: 1, y: 1 }, { x: 7, y: 1 }, { x: 14, y: 1 }, { x: 1, y: 9 }, { x: 8, y: 9 }]
  const objects: Record<string, unknown>[] = buildings.map((assetId, index) => ({
    id: `fixture-place-${index}`,
    assetId,
    position: positions[index]!,
    binding: { kind: 'location', locationName: locations[index]![0] },
    label: locations[index]![0],
    purpose: locations[index]![1],
  }))
  objects.push({ id: 'fixture-resident', assetId: 'person-ada', position: { x: 15, y: 12 }, binding: { kind: 'person', personId: residentId }, label: 'Ada', purpose: null })
  const result = {
    world: { name: '河畔日常', description: userMessage.description ?? '一方临河生活的天地', locations: locations.map(([name, description]) => ({ name, description })) },
    scene: { schemaVersion: 1, themeId: 'contemporary-daily-life', size: { columns: 24, rows: 18 }, version: 0, terrain: [], paths: [], objects, lockedObjectIds: [], lockedAreas: [] },
    explanation: '已将住宅、咖啡馆、商店、书屋和车站安排在河畔。',
    warnings: [],
  }
  return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
}

// ── A1 场景兼容：受控体素 fixture 与确定性规划提供者 ──────────────
// 纯资料模块：仅供隔离 s02-e2e 启动与测试导入，不引入 Node fs/process API。

/** 环境变量取值：仅当 ENVIRONMENT=s02-e2e 且该值显式匹配时才注入测试提供者。 */
export const COMPATIBILITY_FIXTURE_MODE = 'compatibility-legacy'
/** 意图文本中的分支标记：命中时提供者返回受控非法 ops（仍走真实校验链）。 */
export const COMPATIBILITY_FIXTURE_INVALID_BRANCH = '[fixture-branch:invalid-candidate]'

const FIXTURE_SIZE = { width: 16, height: 16, depth: 16 }

const KEEPER_OP: EditOperation = {
  kind: 'place-object', objectType: 'stone-lantern', anchor: { x: 4, y: 1, z: 4 }, rotation: 0,
  objectId: 'fixture-keeper', label: '石灯',
}

function fixtureDocument(id: string, ops: EditOperation[]): SerializedVoxelDocument {
  const base = applyEdits(createEmptyWorld(FIXTURE_SIZE, 'mist-manor', id), [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
    ...ops,
  ]).document
  return JSON.parse(serialize(base)) as SerializedVoxelDocument
}

/** 受控修复后基底：草地 + 可靠支撑的石灯，完整校验 valid。 */
export function compatibilityFixtureRepairedBasis(): SerializedVoxelDocument {
  return fixtureDocument('a1-compat-repaired-basis', [KEEPER_OP])
}

/** 受控原始旧场景：装饰资产压在石灯上（asset-overlap），完整校验 invalid 且可修复。 */
export function compatibilityFixtureLegacyScene(): SerializedVoxelDocument {
  return fixtureDocument('a1-compat-legacy-scene', [
    KEEPER_OP,
    { kind: 'place-asset', assetId: 'veg-flower-a', anchor: { x: 4, y: 1, z: 4 }, rotation: 0, placementId: 'fixture-legacy-asset', seed: 1 },
  ])
}

/** 提供者合法分支：在基底空位放置有支撑的石灯，候选完整有效且确有变化。 */
export function compatibilityFixtureValidOps(): EditOperation[] {
  return [
    { kind: 'place-object', objectType: 'stone-lantern', anchor: { x: 10, y: 1, z: 10 }, rotation: 0, objectId: 'fixture-plan-lantern', label: '新石灯' },
  ]
}

/** 提供者受控非法分支：挖掉石灯脚下的支撑。操作级校验可通过，完整真实校验（悬空）必失败。 */
export function compatibilityFixtureInvalidOps(): EditOperation[] {
  return [{ kind: 'set-block', at: { x: 4, y: 0, z: 4 }, block: 'air' }]
}

export interface CompatibilityFixtureVoxelProvider {
  /** planEdits 的 complete 形状：返回模型层 {"ops":[...]} JSON,不伪造 API plan/save 成功载荷。 */
  complete(messages: ReadonlyArray<{ role: string; content: string | null }>): Promise<string>
  /** 模型层调用次数（旧无效场景被阻断时必须保持 0）。 */
  readonly calls: number
}

/**
 * 确定性 voxel ops 测试提供者：分支由意图文本标记决定,输出针对受控基底预检过的 ops。
 * 仅测试模式注入；生产规划仍走真实模型配置。
 */
export function createCompatibilityFixtureVoxelProvider(): CompatibilityFixtureVoxelProvider {
  let calls = 0
  return {
    get calls() { return calls },
    async complete(messages) {
      calls += 1
      const lastUser = [...messages].reverse().find(message => message.role === 'user')?.content ?? ''
      const ops = lastUser.includes(COMPATIBILITY_FIXTURE_INVALID_BRANCH)
        ? compatibilityFixtureInvalidOps()
        : compatibilityFixtureValidOps()
      return JSON.stringify({ ops })
    },
  }
}

/**
 * B68 注入闸门：仅 s02-e2e 环境且显式兼容 fixture 模式时返回测试 complete,否则返回 null。
 * 模式只取环境变量,绝不取 HTTP body;生产/其他环境即使设置了同名变量也不生效。
 */
export function compatibilityFixturePlannerComplete(
  env: { ENVIRONMENT?: string; SCENE_COMPATIBILITY_FIXTURE?: string },
): CompatibilityFixtureVoxelProvider['complete'] | null {
  if (env.ENVIRONMENT !== 's02-e2e') return null
  if (env.SCENE_COMPATIBILITY_FIXTURE !== COMPATIBILITY_FIXTURE_MODE) return null
  return createCompatibilityFixtureVoxelProvider().complete
}
