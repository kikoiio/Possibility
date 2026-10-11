import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyEdits, createEmptyWorld, deserialize, ensureAssetPlacementIds, serialize } from '@possibility/voxel-contract'
import { demoBaselines, worldSceneRevisions } from '../db/schema'
import * as llmClient from '../llm/client'
import * as llmResolution from '../llm/resolve'
import { BudgetRefusal } from '../engine/guard'
import { LlmContractError } from '../llm/contracts'
import { createWorldFixture } from '../test/world-fixture'
import { EditPlannerError } from './edit-planner'
import { commitScene, commitTimelineScene } from '../scenes/repository'
import { scenesRoutes } from '../scenes/routes'
import {
  COMPATIBILITY_FIXTURE_INVALID_BRANCH,
  compatibilityFixtureLegacyScene,
  compatibilityFixtureRepairedBasis,
  compatibilityFixtureValidOps,
} from '../scenes/e2e-fixture'
import { voxelRoutes } from './routes'

const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
const document = serialize(applyEdits(createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'edit-plan-route'), [
  { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
]).document)
const requestBody = (overrides: Record<string, unknown> = {}) => ({
  worldId: 'home-world', requestId: 'plan-route-request-1', intent: '在庭院里加一盏灯', document, ...overrides,
})

type Fixture = Awaited<ReturnType<typeof createWorldFixture>>

/** A1(B52):规划路由核对权威场景,夹具先以同一文档种下首版。 */
async function seedScene(fixture: Fixture) {
  await commitScene(fixture.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'seed-scene', document: JSON.parse(document), summary: 'seed', kind: 'initial' })
}

async function revisionCount(fixture: Fixture) {
  return (await fixture.db.select().from(worldSceneRevisions)).length
}

describe('voxel AI edit-plan route', () => {
  const fixtures: Awaited<ReturnType<typeof createWorldFixture>>[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    fixtures.splice(0).forEach(fixture => fixture.close())
  })

  it('requires authentication and a target world', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    const unauthenticated = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody()),
    }, fixture.env)
    expect(unauthenticated.status).toBe(401)

    const missingWorld = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers, body: JSON.stringify(requestBody({ worldId: '' })),
    }, fixture.env)
    expect(missingWorld.status).toBe(400)
    expect(await missingWorld.json()).toMatchObject({ kind: 'input', retryable: false })
  })

  it('rejects inaccessible worlds and read-only baselines before resolving model or budget', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    await fixture.db.insert(demoBaselines).values({
      id: 'home-baseline', worldId: 'home-world', sceneVersion: 1, contentHash: 'test-hash',
      status: 'active', createdAt: '2026-09-28T00:00:00.000Z',
    })
    const resolve = vi.spyOn(llmResolution, 'resolveLlmConfig')
    const complete = vi.spyOn(llmClient, 'complete')

    const inaccessible = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers, body: JSON.stringify(requestBody({ worldId: 'other-world' })),
    }, fixture.env)
    expect(inaccessible.status).toBe(404)
    expect(await inaccessible.json()).toMatchObject({ kind: 'permission', retryable: false })

    const readOnly = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers, body: JSON.stringify(requestBody()),
    }, fixture.env)
    expect(readOnly.status).toBe(403)
    expect(await readOnly.json()).toMatchObject({ kind: 'permission', retryable: false })
    expect(resolve).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(await revisionCount(fixture)).toBe(0)
  })

  it('runs the authorized planner and returns its validated preview operations without writing a scene', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    await seedScene(fixture)
    vi.spyOn(llmResolution, 'resolveLlmConfig').mockResolvedValue({
      config: { baseUrl: 'https://llm.test', apiKey: 'test-key', model: 'test-model' },
      source: 'env', apiKeySource: 'platform_fallback', verificationValid: false,
    })
    const complete = vi.spyOn(llmClient, 'complete').mockResolvedValue(JSON.stringify({
      ops: [{ kind: 'set-block', at: { x: 2, y: 1, z: 2 }, block: 'stone' }],
    }))
    const response = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers, body: JSON.stringify(requestBody()),
    }, fixture.env)

    expect(response.status).toBe(200)
    const result = await response.json() as { ops: unknown[]; previewBasis?: { expectedCurrentVersion: number; candidateHash: string | null } }
    expect(result.ops).toEqual([{ kind: 'set-block', at: { x: 2, y: 1, z: 2 }, block: 'stone' }])
    // B69:成功规划携带完整候选的预检依据
    expect(result.previewBasis?.expectedCurrentVersion).toBe(1)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(await revisionCount(fixture)).toBe(1)
  })

  it('A1 AI preflight: blocks planning on an invalid legacy scene before any model call', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    // 无效基底:悬空装饰(缺支撑)触发完整校验 invalid
    const broken = serialize(applyEdits(createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'edit-plan-legacy'), [
      { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
      { kind: 'place-object', objectType: 'stone-lantern', anchor: { x: 4, y: 5, z: 4 }, rotation: 0 },
    ]).document)
    await commitScene(fixture.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'seed-legacy', document: JSON.parse(broken), summary: 'seed', kind: 'initial' })
    const resolve = vi.spyOn(llmResolution, 'resolveLlmConfig')
    const complete = vi.spyOn(llmClient, 'complete')
    const response = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers, body: JSON.stringify(requestBody({ document: broken })),
    }, fixture.env)

    expect(response.status).toBe(422)
    const result = await response.json() as { kind: string; errorCode: string }
    expect(result).toMatchObject({ kind: 'compatibility', errorCode: 'compatibility-required' })
    expect(resolve).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(await revisionCount(fixture)).toBe(1)
  })

  it('A1 maps the legacy exterior alias only for single-space scenes', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    const exterior = compatibilityFixtureRepairedBasis()
    const hall = compatibilityFixtureLegacyScene()
    const spaces = {
      format: 'voxel-spaces', version: 1, defaultSpaceId: 'exterior',
      spaces: [
        { id: 'exterior', name: '石灯外景', document: exterior },
        { id: 'hall', name: '老花房', document: hall },
      ],
    }
    await commitTimelineScene(fixture.db, {
      worldId: 'home-world', timelineId: 'home-main', representation: 'voxel',
      expectedVersion: 0, requestId: 'seed-multi-space', document: spaces, summary: 'multi-space seed', kind: 'initial',
    })
    const resolve = vi.spyOn(llmResolution, 'resolveLlmConfig')
    const complete = vi.spyOn(llmClient, 'complete')

    const response = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers,
      body: JSON.stringify(requestBody({
        timelineId: 'home-main', representation: 'voxel', spaceId: 'exterior', document: JSON.stringify(spaces),
      })),
    }, fixture.env)

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ kind: 'compatibility', errorCode: 'compatibility-required' })
    expect(resolve).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(await revisionCount(fixture)).toBe(1)
  })

  it('A1 AI preflight: rejects a client document that does not match the authoritative basis', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    await seedScene(fixture)
    const complete = vi.spyOn(llmClient, 'complete')
    const stale = serialize(createEmptyWorld({ width: 8, height: 8, depth: 8 }, 'mist-manor', 'edit-plan-stale'))
    const response = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers, body: JSON.stringify(requestBody({ document: stale })),
    }, fixture.env)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ kind: 'conflict', retryable: false })
    expect(complete).not.toHaveBeenCalled()
    expect(await revisionCount(fixture)).toBe(1)
  })

  it('returns safe retry guidance when the planner cannot produce a valid edit', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    await seedScene(fixture)
    vi.spyOn(llmResolution, 'resolveLlmConfig').mockResolvedValue({
      config: { baseUrl: 'https://llm.test', apiKey: 'test-key', model: 'test-model' },
      source: 'env', apiKeySource: 'platform_fallback', verificationValid: false,
    })
    vi.spyOn(llmClient, 'complete').mockResolvedValue('not-json')
    const response = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers, body: JSON.stringify(requestBody()),
    }, fixture.env)

    expect(response.status).toBe(422)
    const result = await response.json() as { error: string; kind: string; retryable: boolean; nextStep: string }
    expect(result).toMatchObject({ kind: 'planning', retryable: true })
    expect(result.error).not.toContain('not-json')
    expect(result.nextStep).toContain('重试')
    expect(await revisionCount(fixture)).toBe(1)
  })

  it('returns a non-retryable budget response without writing a scene', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    await seedScene(fixture)
    vi.spyOn(llmResolution, 'resolveLlmConfig').mockRejectedValue(new BudgetRefusal('今日调用额度已用完'))
    const complete = vi.spyOn(llmClient, 'complete')
    const response = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers, body: JSON.stringify(requestBody()),
    }, fixture.env)

    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ kind: 'budget', retryable: false })
    expect(complete).not.toHaveBeenCalled()
    expect(await revisionCount(fixture)).toBe(1)
  })

  it('returns safe model configuration guidance without exposing provider details', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    await seedScene(fixture)
    vi.spyOn(llmResolution, 'resolveLlmConfig').mockRejectedValue(
      new LlmContractError('provider_http_error', 'provider returned 403 secret-value'),
    )
    const complete = vi.spyOn(llmClient, 'complete')
    const response = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers, body: JSON.stringify(requestBody()),
    }, fixture.env)

    expect(response.status).toBe(502)
    const body = await response.json() as { error: string; kind: string; retryable: boolean; nextStep: string }
    expect(body).toMatchObject({ kind: 'config', retryable: false })
    expect(body.nextStep).toContain('配置')
    expect(JSON.stringify(body)).not.toContain('secret-value')
    expect(complete).not.toHaveBeenCalled()
    expect(await revisionCount(fixture)).toBe(1)
  })

  it('does not expose raw provider errors or secrets', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    await seedScene(fixture)
    vi.spyOn(llmResolution, 'resolveLlmConfig').mockResolvedValue({
      config: { baseUrl: 'https://llm.test', apiKey: 'secret-value', model: 'test-model' },
      source: 'user', apiKeySource: 'personal_global', verificationValid: false,
    })
    vi.spyOn(llmClient, 'complete').mockRejectedValue(new Error('provider internal stack secret-value'))
    const response = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers, body: JSON.stringify(requestBody()),
    }, fixture.env)

    expect(response.status).toBe(503)
    const body = await response.json() as { error: string; kind: string; retryable: boolean }
    expect(body).toMatchObject({ kind: 'service', retryable: true })
    expect(JSON.stringify(body)).not.toContain('secret-value')
    expect(JSON.stringify(body)).not.toContain('provider internal stack')
  })
})

/** A1(B68)：真实规划路径的测试提供者注入——仅 s02-e2e 显式兼容 fixture 模式生效。 */
describe('A1 isolated AI provider', () => {
  const fixtures: Awaited<ReturnType<typeof createWorldFixture>>[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    fixtures.splice(0).forEach(fixture => fixture.close())
  })

  const isolatedEnv = (fixture: Fixture, overrides: Record<string, string> = {}) => ({
    ...fixture.env, ENVIRONMENT: 's02-e2e', SCENE_COMPATIBILITY_FIXTURE: 'compatibility-legacy', ...overrides,
  })
  const basisDocument = () => compatibilityFixtureRepairedBasis()

  it('旧无效场景在提供者调用前阻断（模型调用 0 次）', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    const legacy = compatibilityFixtureLegacyScene()
    await commitScene(fixture.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'seed-legacy', document: legacy, summary: 'seed', kind: 'initial' })
    const complete = vi.spyOn(llmClient, 'complete')

    const response = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers,
      body: JSON.stringify(requestBody({ document: JSON.stringify(legacy) })),
    }, isolatedEnv(fixture))

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ kind: 'compatibility', errorCode: 'compatibility-required' })
    expect(complete).not.toHaveBeenCalled()
    expect(await revisionCount(fixture)).toBe(1)
  })

  it('修复后基底经测试提供者合法规划并真实保存，全程不触真实模型', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    const basis = basisDocument()
    await commitScene(fixture.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'seed-basis', document: basis, summary: 'seed', kind: 'initial' })
    const resolve = vi.spyOn(llmResolution, 'resolveLlmConfig')
    const complete = vi.spyOn(llmClient, 'complete')

    const plan = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers, body: JSON.stringify(requestBody({ document: JSON.stringify(basis) })),
    }, isolatedEnv(fixture))

    expect(plan.status).toBe(200)
    const planned = await plan.json() as { ops: unknown[]; previewBasis?: { expectedCurrentVersion: number } }
    expect(planned.ops).toEqual(compatibilityFixtureValidOps())
    expect(planned.previewBasis?.expectedCurrentVersion).toBe(1)
    // 真实 auth/resolveLlmConfig/预算链保留；模型 HTTP 被测试提供者替代
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(complete).not.toHaveBeenCalled()

    // 真实保存：同一候选走实际保存路由 + 完整校验 + DB
    const edited = ensureAssetPlacementIds(applyEdits(deserialize(JSON.stringify(basis)), planned.ops as Parameters<typeof applyEdits>[1]).document)
    const candidate = JSON.parse(serialize(edited))
    const save = await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', {
      method: 'POST', headers,
      body: JSON.stringify({ requestId: 'save-isolated-1', expectedVersion: 1, document: candidate }),
    }, isolatedEnv(fixture))
    expect(save.status).toBe(200)
    expect(await revisionCount(fixture)).toBe(2)
  })

  it('受控非法候选经实际 planEdits 后被 B69 完整预检阻断', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    const basis = basisDocument()
    await commitScene(fixture.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'seed-basis', document: basis, summary: 'seed', kind: 'initial' })
    const complete = vi.spyOn(llmClient, 'complete')

    const response = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers,
      body: JSON.stringify(requestBody({ document: JSON.stringify(basis), intent: `挖一下灯脚 ${COMPATIBILITY_FIXTURE_INVALID_BRANCH}` })),
    }, isolatedEnv(fixture))

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ kind: 'planning', errorCode: 'scene-invalid' })
    expect(complete).not.toHaveBeenCalled()
    expect(await revisionCount(fixture)).toBe(1)
  })

  it('生产/其他环境不接受 fixture 开启参数', async () => {
    for (const env of [
      { ENVIRONMENT: 'production', SCENE_COMPATIBILITY_FIXTURE: 'compatibility-legacy' },
      { ENVIRONMENT: 'test', SCENE_COMPATIBILITY_FIXTURE: 'compatibility-legacy' },
      { ENVIRONMENT: 's02-e2e', SCENE_COMPATIBILITY_FIXTURE: 'off' },
    ]) {
      const fixture = await createWorldFixture(); fixtures.push(fixture)
      const basis = basisDocument()
      await commitScene(fixture.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'seed-basis', document: basis, summary: 'seed', kind: 'initial' })
      const complete = vi.spyOn(llmClient, 'complete').mockResolvedValue(JSON.stringify({ ops: compatibilityFixtureValidOps() }))

      const response = await voxelRoutes.request('/voxel/edit-plan', {
        method: 'POST', headers, body: JSON.stringify(requestBody({ document: JSON.stringify(basis) })),
      }, { ...fixture.env, ...env })

      expect(response.status).toBe(200)
      // fixture 未注入：走的是真实 complete（此处为间谍），不是测试提供者
      expect(complete).toHaveBeenCalledTimes(1)
      vi.restoreAllMocks()
    }
  })
})
