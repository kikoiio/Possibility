import { afterEach, describe, expect, it } from 'vitest'
import { applyEdits, createEmptyWorld, serialize, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import { scenesRoutes } from './routes'
import { createWorldFixture } from '../test/world-fixture'

/** 合法体素信封:平地 + 可选摆放 op */
function voxelEnvelope(...ops: Parameters<typeof applyEdits>[1]): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'voxel-route')
  const doc = applyEdits(base, [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
    ...ops,
  ]).document
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

describe('scene HTTP routes', () => {
  const fixtures: Awaited<ReturnType<typeof createWorldFixture>>[] = []
  afterEach(() => fixtures.splice(0).forEach(f => f.close()))
  it('requires authentication and hides worlds not owned by the caller', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    const unauth = await scenesRoutes.request('/worlds/home-world/scene', {}, f.env)
    expect(unauth.status).toBe(401)
    const foreign = await scenesRoutes.request('/worlds/other-world/scene', { headers: { Authorization: 'Bearer owner-token' } }, f.env)
    expect(foreign.status).toBe(404)
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
