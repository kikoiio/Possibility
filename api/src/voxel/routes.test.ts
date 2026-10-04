import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyWorld, serialize } from '@possibility/voxel-contract'
import { demoBaselines, worldSceneRevisions } from '../db/schema'
import * as llmClient from '../llm/client'
import * as llmResolution from '../llm/resolve'
import { BudgetRefusal } from '../engine/guard'
import { LlmContractError } from '../llm/contracts'
import { createWorldFixture } from '../test/world-fixture'
import { EditPlannerError } from './edit-planner'
import { voxelRoutes } from './routes'

const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
const document = serialize(createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'edit-plan-route'))
const requestBody = (overrides: Record<string, unknown> = {}) => ({
  worldId: 'home-world', requestId: 'plan-route-request-1', intent: '在庭院里加一盏灯', document, ...overrides,
})

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
    expect(await fixture.db.select().from(worldSceneRevisions)).toEqual([])
  })

  it('runs the authorized planner and returns its validated preview operations without writing a scene', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
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
    expect(await response.json()).toMatchObject({ ops: [{ kind: 'set-block', at: { x: 2, y: 1, z: 2 }, block: 'stone' }] })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(await fixture.db.select().from(worldSceneRevisions)).toEqual([])
  })

  it('returns safe retry guidance when the planner cannot produce a valid edit', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
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
    expect(await fixture.db.select().from(worldSceneRevisions)).toEqual([])
  })

  it('returns a non-retryable budget response without writing a scene', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    vi.spyOn(llmResolution, 'resolveLlmConfig').mockRejectedValue(new BudgetRefusal('今日调用额度已用完'))
    const complete = vi.spyOn(llmClient, 'complete')
    const response = await voxelRoutes.request('/voxel/edit-plan', {
      method: 'POST', headers, body: JSON.stringify(requestBody()),
    }, fixture.env)

    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ kind: 'budget', retryable: false })
    expect(complete).not.toHaveBeenCalled()
    expect(await fixture.db.select().from(worldSceneRevisions)).toEqual([])
  })

  it('returns safe model configuration guidance without exposing provider details', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
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
    expect(await fixture.db.select().from(worldSceneRevisions)).toEqual([])
  })

  it('does not expose raw provider errors or secrets', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
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
