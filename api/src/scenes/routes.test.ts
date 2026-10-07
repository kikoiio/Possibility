import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyEdits, createEmptyWorld, serialize, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import { scenesRoutes } from './routes'
import * as voxelDraft from './voxel-draft'
import { BudgetRefusal } from '../engine/guard'
import { LlmContractError } from '../llm/contracts'
import { WorldGeneratorError } from '../voxel/generate'
import { CONTENT_ISSUE_COPY } from './error-copy'
import { createWorldFixture } from '../test/world-fixture'
import { persons, timelines, users, worldPersons, worldSceneRevisions, worldScenes, worlds } from '../db/schema'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../test/db'
import { seedDemoWorld } from '../dev/seed-demo'
import type { SceneWriteProof } from './compatibility/write-proof'
import { buildTestPolicyActivationSql } from '../../scripts/prepare-scene-compatibility-fixture'
import validatedSeedBundle from '../demo/mist-manor-voxel-spaces.validated.json'
import originalSeedBundle from '../demo/mist-manor-voxel-spaces.json'

/** 合法体素信封:平地 + 可选摆放 op */
function voxelEnvelope(...ops: Parameters<typeof applyEdits>[1]): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'voxel-route')
  const doc = applyEdits(base, [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
    ...ops,
  ]).document
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

function repairEnvelope(names: string[], shift = 0): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'repair-route')
  const doc = applyEdits(base, [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
    ...names.map((_, i) => ({ kind: 'place-object' as const, objectId: `spot-${i}`, objectType: 'stone-lantern' as const, anchor: { x: 2 + i * 4 + shift, y: 1, z: 2 }, rotation: 0 as const })),
  ]).document
  return JSON.parse(serialize({ ...doc, locations: names.map((name, i) => ({ name, objectId: `spot-${i}` })) })) as SerializedVoxelDocument
}

describe('scene HTTP routes', () => {
  const fixtures: Awaited<ReturnType<typeof createWorldFixture>>[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    fixtures.splice(0).forEach(f => f.close())
  })

  it('POST /scene-drafts/voxel returns classified errors with request ids and user-safe content copy', async () => {
    expect(Object.keys(CONTENT_ISSUE_COPY)).toHaveLength(14)
    const f = await createWorldFixture(); fixtures.push(f)
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const send = () => scenesRoutes.request('/scene-drafts/voxel', {
      method: 'POST', headers,
      body: JSON.stringify({ requestId: 'draft-error-1', prompt: '海边小镇', personIds: ['p1'] }),
    }, f.env)

    vi.spyOn(voxelDraft, 'createVoxelSceneDraft').mockRejectedValueOnce(new BudgetRefusal('调用额度已用完', 429))
    const budget = await send()
    expect(budget.status).toBe(429)
    expect(await budget.json()).toMatchObject({ kind: 'budget', callsUsed: 0, requestId: 'draft-error-1', error: '调用额度已用完' })

    const configError = Object.assign(new LlmContractError('provider_http_error', 'LLM 请求失败（401）：secret'), { callsUsed: 1 })
    vi.spyOn(voxelDraft, 'createVoxelSceneDraft').mockRejectedValueOnce(configError)
    const config = await send()
    expect(config.status).toBe(502)
    expect(await config.json()).toMatchObject({ kind: 'config', callsUsed: 1, requestId: 'draft-error-1', error: expect.stringContaining('设置') })

    const generatorError = Object.assign(new WorldGeneratorError('internal validator detail', [
      { code: 'out-of-bounds', message: 'raw detail out of bounds' },
      { code: 'unknown-block', message: 'raw detail unknown block' },
      { code: 'floating-object', message: 'raw detail floating' },
      { code: 'object-overlap', message: 'raw detail overlap' },
      { code: 'location-unbound', message: 'raw detail location' },
      { code: 'locked-violation', message: 'raw detail locked' },
      { code: 'walk-clearance', message: 'raw clearance detail' },
      { code: 'walk-connectivity', message: 'raw detail connectivity' },
      { code: 'walk-lighting', message: 'raw detail lighting' },
      { code: 'walk-stairs', message: 'raw detail stairs' },
      { code: 'walk-gap', message: 'raw detail gap' },
      { code: 'invalid-meta', message: 'raw detail metadata' },
      { code: 'unknown-asset', message: 'raw detail unknown asset' },
      { code: 'asset-overlap', message: 'raw detail asset overlap' },
      { code: 'unrecognized-test-code', message: 'raw unknown detail' },
    ], [], 'validation'), { callsUsed: 7 })
    vi.spyOn(voxelDraft, 'createVoxelSceneDraft').mockRejectedValueOnce(generatorError)
    const content = await send()
    expect(content.status).toBe(502)
    const contentBody = await content.json() as { kind: string; requestId: string; error: string; callsUsed: number; failureStage: string; normalizationFixes: string[]; issues: Array<{ code: string; summary: string; suggestion: string }> }
    expect(contentBody).toMatchObject({ kind: 'content', callsUsed: 7, failureStage: 'validation', normalizationFixes: [], requestId: 'draft-error-1' })
    expect(contentBody.error).not.toContain('internal validator')
    expect(contentBody.issues).toHaveLength(12)
    expect(contentBody.issues[6]).toMatchObject({ code: 'walk-clearance', summary: expect.stringContaining('走不过去'), suggestion: expect.stringContaining('通道') })
    expect(contentBody.issues.every(issue => issue.summary.length > 0 && issue.suggestion.length > 0)).toBe(true)
    expect(JSON.stringify(contentBody)).not.toContain('raw clearance detail')
    expect(JSON.stringify(contentBody)).not.toContain('raw unknown detail')

    const systemError = Object.assign(new Error('sensitive internal failure'), { callsUsed: 2 })
    vi.spyOn(voxelDraft, 'createVoxelSceneDraft').mockRejectedValueOnce(systemError)
    const system = await send()
    expect(system.status).toBe(400)
    const systemBody = await system.json() as { kind: string; requestId: string; callsUsed: number; error: string }
    expect(systemBody).toMatchObject({ kind: 'system', callsUsed: 2, requestId: 'draft-error-1', error: expect.stringContaining('重试') })
    expect(JSON.stringify(systemBody)).not.toContain('sensitive internal failure')
  })

  it('requires authentication and hides worlds not owned by the caller', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    const unauth = await scenesRoutes.request('/worlds/home-world/scene', {}, f.env)
    expect(unauth.status).toBe(401)
    const foreign = await scenesRoutes.request('/worlds/other-world/scene', { headers: { Authorization: 'Bearer owner-token' } }, f.env)
    expect(foreign.status).toBe(404)
  })

  it('GET /scene/revisions returns an empty or ordered list only to the world owner', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    const owner = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const before = await scenesRoutes.request('/worlds/home-world/scene/revisions', { headers: owner }, f.env)
    expect(before.status).toBe(200)
    expect(await before.json()).toEqual({ revisions: [] })
    expect(await f.db.select().from(worldSceneRevisions)).toHaveLength(0)

    const first = await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', {
      method: 'POST', headers: owner,
      body: JSON.stringify({ requestId: 'history-v1', expectedVersion: 0, document: voxelEnvelope() }),
    }, f.env)
    expect(first.status).toBe(200)
    const second = await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', {
      method: 'POST', headers: owner,
      body: JSON.stringify({ requestId: 'history-v2', expectedVersion: 1, document: voxelEnvelope() }),
    }, f.env)
    expect(second.status).toBe(200)

    const history = await scenesRoutes.request('/worlds/home-world/scene/revisions', { headers: owner }, f.env)
    expect(history.status).toBe(200)
    expect(await history.json()).toMatchObject({ revisions: [
      { version: 2, parentVersion: 1, kind: 'voxel-edit' },
      { version: 1, parentVersion: null, kind: 'voxel-edit' },
    ] })
    expect(await f.db.select().from(worldSceneRevisions)).toHaveLength(2)

    const unauthenticated = await scenesRoutes.request('/worlds/home-world/scene/revisions', {}, f.env)
    expect(unauthenticated.status).toBe(401)
    const foreign = await scenesRoutes.request('/worlds/other-world/scene/revisions', { headers: owner }, f.env)
    expect(foreign.status).toBe(404)
  })

  it('repairs a missing scene on the original world and keeps context, residents, and timeline intact', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    await f.db.insert(persons).values({ id: 'resident-1', userId: 'owner', name: '阿梨', modelJson: '{}', createdAt: '2026-09-21T08:00:00.000Z' })
    await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident-1', joinedAt: '2026-09-21T08:00:00.000Z' })
    const originalWorld = await f.db.select().from(worlds).where(eq(worlds.id, 'home-world')).get()
    const originalTimelines = await f.db.select().from(timelines).all()
    const originalBindings = await f.db.select().from(worldPersons).all()
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }

    const contextResponse = await scenesRoutes.request('/worlds/home-world/scene/repair-context', { headers }, f.env)
    expect(contextResponse.status).toBe(200)
    expect(await contextResponse.json()).toMatchObject({
      world: { id: 'home-world', name: 'Home world', locations: [{ name: 'Cafe' }, { name: 'Library' }] },
      residents: [{ id: 'resident-1', name: '阿梨' }], sceneStatus: 'missing',
    })

    const envelope = repairEnvelope(['Cafe', 'Library'])
    const saveRequest = () => scenesRoutes.request('/worlds/home-world/scene/voxel-revision', {
      method: 'POST', headers,
      body: JSON.stringify({ requestId: 'repair-save-1', expectedVersion: 0, repair: true, document: envelope }),
    }, f.env)
    const saved = await saveRequest()
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ version: 1, document: { locations: [{ name: 'Cafe' }, { name: 'Library' }] } })

    const replay = await saveRequest()
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ version: 1 })
    expect(await f.db.select().from(worldScenes)).toHaveLength(1)
    expect(await f.db.select().from(worldSceneRevisions)).toMatchObject([{ worldId: 'home-world', version: 1, kind: 'scene-repair' }])
    expect(await f.db.select().from(worlds)).toHaveLength(2)
    expect(await f.db.select().from(worlds).where(eq(worlds.id, 'home-world')).get()).toEqual(originalWorld)
    expect(await f.db.select().from(timelines)).toEqual(originalTimelines)
    expect(await f.db.select().from(worldPersons)).toEqual(originalBindings)

    const changedReplay = await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', {
      method: 'POST', headers,
      body: JSON.stringify({ requestId: 'repair-save-1', expectedVersion: 0, repair: true, document: repairEnvelope(['Cafe', 'Library'], 1) }),
    }, f.env)
    expect(changedReplay.status).toBe(409)

    const readyContext = await scenesRoutes.request('/worlds/home-world/scene/repair-context', { headers }, f.env)
    expect(readyContext.status).toBe(409)
    expect(await readyContext.json()).toMatchObject({ errorCode: 'scene_exists' })
  })

  it('rejects repair for an owned world with invalid resident bindings or locations outside its original set', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const noResidents = await scenesRoutes.request('/worlds/home-world/scene/repair-context', { headers }, f.env)
    expect(noResidents.status).toBe(409)
    expect(await noResidents.json()).toMatchObject({ errorCode: 'world_structure_invalid' })

    await f.db.insert(persons).values({ id: 'resident-1', userId: 'owner', name: '阿梨', modelJson: '{}', createdAt: '2026-09-21T08:00:00.000Z' })
    await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident-1', joinedAt: '2026-09-21T08:00:00.000Z' })
    const mismatch = await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', {
      method: 'POST', headers,
      body: JSON.stringify({ requestId: 'repair-mismatch', expectedVersion: 0, repair: true, document: repairEnvelope(['Cafe', 'Elsewhere']) }),
    }, f.env)
    expect(mismatch.status).toBe(422)
    expect(await mismatch.json()).toMatchObject({ errorCode: 'repair_location_mismatch' })
    expect(await f.db.select().from(worldScenes)).toHaveLength(0)
  })

  it('protects repair context by ownership and reports a missing main timeline without changing the world', async () => {
    const f = await createWorldFixture({ writable: false }); fixtures.push(f)
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    expect((await scenesRoutes.request('/worlds/home-world/scene/repair-context', {}, f.env)).status).toBe(401)
    expect((await scenesRoutes.request('/worlds/other-world/scene/repair-context', { headers }, f.env)).status).toBe(404)

    const original = await f.db.select().from(worlds).where(eq(worlds.id, 'home-world')).get()
    const originalTimelines = await f.db.select().from(timelines).all()
    await f.db.delete(timelines).where(eq(timelines.id, 'home-main'))
    const invalid = await scenesRoutes.request('/worlds/home-world/scene/repair-context', { headers }, f.env)
    expect(invalid.status).toBe(409)
    expect(await invalid.json()).toMatchObject({ errorCode: 'world_structure_invalid' })
    expect(await f.db.select().from(worlds).where(eq(worlds.id, 'home-world')).get()).toEqual(original)
    expect(await f.db.select().from(timelines)).toEqual(originalTimelines.filter(timeline => timeline.id !== 'home-main'))
    expect(await f.db.select().from(worldScenes)).toHaveLength(0)
  })

  it('allows only one concurrent first-scene repair to commit', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    await f.db.insert(persons).values({ id: 'resident-1', userId: 'owner', name: '阿梨', modelJson: '{}', createdAt: '2026-09-21T08:00:00.000Z' })
    await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident-1', joinedAt: '2026-09-21T08:00:00.000Z' })
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const submit = (requestId: string) => scenesRoutes.request('/worlds/home-world/scene/voxel-revision', {
      method: 'POST', headers,
      body: JSON.stringify({ requestId, expectedVersion: 0, repair: true, document: repairEnvelope(['Cafe', 'Library']) }),
    }, f.env)
    const outcomes = await Promise.all([submit('repair-race-a'), submit('repair-race-b')])
    expect(outcomes.map(response => response.status).sort()).toEqual([200, 409])
    expect(await f.db.select().from(worldScenes)).toHaveLength(1)
    expect(await f.db.select().from(worldSceneRevisions)).toHaveLength(1)
  })
  it('reads explicit missing status and stores accepted revisions only', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const read = await scenesRoutes.request('/worlds/home-world/scene', { headers }, f.env)
    expect(await read.json()).toEqual({ status: 'missing' })
    const save = await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', { method: 'POST', headers, body: JSON.stringify({ requestId: 'req-1', expectedVersion: 0, document: voxelEnvelope() }) }, f.env)
    expect(save.status).toBe(200); expect(await save.json()).toMatchObject({ version: 1 })
    const current = await scenesRoutes.request('/worlds/home-world/scene', { headers }, f.env)
    expect(await current.json()).toMatchObject({ status: 'ready', version: 1 })
  })

  it('S2b voxel-revision: commits voxel envelopes, backfills placement ids, idempotent replay', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    // 未认证被拒(鉴权正则覆盖新端点)
    const unauth = await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, f.env)
    expect(unauth.status).toBe(401)

    // 摆放无 id 的信封 → 提交后持久化 id(ensureAssetPlacementIds 在路由生效)
    const envelope = voxelEnvelope({ kind: 'place-asset', assetId: 'veg-tree-a', anchor: { x: 4, y: 1, z: 4 }, rotation: 0 })
    delete envelope.assetPlacements![0].id
    const save = await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', { method: 'POST', headers, body: JSON.stringify({ requestId: 'vr-1', expectedVersion: 0, document: envelope }) }, f.env)
    expect(save.status).toBe(200)
    const saved = await save.json() as { version: number; document: SerializedVoxelDocument }
    expect(saved.version).toBe(1)
    expect(saved.document.assetPlacements![0].id).toMatch(/^ast-/)

    // requestId 幂等重放同版本
    const replay = await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', { method: 'POST', headers, body: JSON.stringify({ requestId: 'vr-1', expectedVersion: 0, document: saved.document }) }, f.env)
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as { version: number }).version).toBe(1)

    // 后续修订版本递增
    const second = await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', { method: 'POST', headers, body: JSON.stringify({ requestId: 'vr-2', expectedVersion: 1, document: saved.document }) }, f.env)
    expect(second.status).toBe(200)
    expect(((await second.json()) as { version: number }).version).toBe(2)
  })

  it('S2b voxel-revision: 409 on version conflict, 422 on non-envelope and validation failures', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const envelope = voxelEnvelope()
    await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', { method: 'POST', headers, body: JSON.stringify({ requestId: 'vc-1', expectedVersion: 0, document: envelope }) }, f.env)

    // 期望版本落后 → 409
    const conflict = await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', { method: 'POST', headers, body: JSON.stringify({ requestId: 'vc-2', expectedVersion: 0, document: envelope }) }, f.env)
    expect(conflict.status).toBe(409)

    // 非体素信封 → 422
    const notEnvelope = await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', { method: 'POST', headers, body: JSON.stringify({ requestId: 'vc-3', expectedVersion: 1, document: { hello: 'world' } }) }, f.env)
    expect(notEnvelope.status).toBe(422)

    // 悬空摆放(清单严格校验:asset-overlap) → 422 带 issues
    const floating = voxelEnvelope({ kind: 'place-asset', assetId: 'bld-hut-a', anchor: { x: 4, y: 9, z: 4 }, rotation: 0 })
    const rejected = await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', { method: 'POST', headers, body: JSON.stringify({ requestId: 'vc-4', expectedVersion: 1, document: floating }) }, f.env)
    expect(rejected.status).toBe(422)
    const body = await rejected.json() as { issues: Array<{ code: string }> }
    expect(body.issues.some((i) => i.code === 'asset-overlap')).toBe(true)
  })
})

/** A1 B55/P27：演示 seed 只用 validated 副本，按实际世界绑定复验，不再覆盖既有场景 */
describe('A1 demo initialization', () => {
  const SEED_NOW = '2026-10-05T00:00:00.000Z'
  async function seedDocumentHash(documentJson: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ document: JSON.parse(documentJson), version: 1 })))
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }

  it('策略激活下 seed 新初始化成功：首版为 validated 副本并携带 initial 证明', async () => {
    const fixture = createTestDb()
    try {
      await fixture.db.insert(users).values({ id: 'admin', username: 'admin', passwordHash: 'x', createdAt: SEED_NOW })
      fixture.sqlite.exec(await buildTestPolicyActivationSql())
      const result = await seedDemoWorld(fixture.db)
      expect(result.created).toBe(true)

      const pointer = await fixture.db.select().from(worldScenes).where(eq(worldScenes.worldId, result.worldId)).get()
      expect(pointer?.currentVersion).toBe(1)
      const revisions = await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, result.worldId)).all()
      expect(revisions).toHaveLength(1)
      const row = revisions[0]!
      // 首版文档即 validated 副本（不是原始失败 fixture），哈希与文档一致
      expect(JSON.parse(row.documentJson)).toEqual(JSON.parse(JSON.stringify(validatedSeedBundle)))
      expect(row.documentJson).not.toBe(JSON.stringify(originalSeedBundle))
      expect(row.contentHash).toBe(await seedDocumentHash(row.documentJson))
      const proof = JSON.parse(row.validationJson!) as SceneWriteProof
      expect(proof.mode).toBe('initial')
      // 证明绑定覆盖真实落库的演示世界成员与地点（6 人物 + 7 地点）
      expect(proof.bindings.personIds).toHaveLength(6)
      expect(proof.bindings.locations).toEqual(['大厅', '书房', '后山散步道', '图书室', '温室花房', '门房小屋', '餐厅'].sort())
      expect(row.commitGuard).toBe(true)
    } finally { fixture.close() }
  })

  it('既有非体素场景不再被种子覆盖', async () => {
    const fixture = createTestDb()
    try {
      await fixture.db.insert(users).values({ id: 'admin', username: 'admin', passwordHash: 'x', createdAt: SEED_NOW })
      // 预置旧演示世界（非体素旧场景 + 时间线），在策略激活前写入（旧历史允许无证明）
      const worldId = 'legacy-demo-world'
      await fixture.db.insert(worlds).values({
        id: worldId, userId: 'admin', name: '雾影庄', description: 'd', locationsJson: '[]',
        status: 'running', isDemo: true, callsToday: 0, createdAt: SEED_NOW,
      })
      await fixture.db.insert(timelines).values({
        id: 'legacy-demo-main', worldId, parentTimelineId: null, forkScenarioJson: null,
        simNow: SEED_NOW, createdAt: SEED_NOW, status: 'active', ancestorIdsJson: '[]',
      })
      await fixture.db.insert(worldSceneRevisions).values({
        id: 'legacy-rev-1', worldId, version: 1, parentVersion: null, requestId: 'legacy-init',
        contentHash: 'legacy-hash', documentJson: '{"format":"legacy-2d"}', summary: '旧场景', kind: 'legacy', createdAt: SEED_NOW,
      })
      await fixture.db.insert(worldScenes).values({ worldId, currentVersion: 1, themeId: 'legacy', updatedAt: SEED_NOW })
      fixture.sqlite.exec(await buildTestPolicyActivationSql())

      const result = await seedDemoWorld(fixture.db)
      expect(result.created).toBe(false)
      // 旧场景原样保留：无新修订、文档不变（旧覆盖分支在策略激活下必然 proof_required ABORT）
      const revisions = await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, worldId)).all()
      expect(revisions).toHaveLength(1)
      expect(revisions[0]!.documentJson).toBe('{"format":"legacy-2d"}')
      expect((await fixture.db.select().from(worldScenes).where(eq(worldScenes.worldId, worldId)).get())?.currentVersion).toBe(1)
    } finally { fixture.close() }
  })
})
