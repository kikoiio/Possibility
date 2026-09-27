import { afterEach, describe, expect, it } from 'vitest'
import { scenesRoutes } from './routes'
import { createWorldFixture } from '../test/world-fixture'

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
    const save = await scenesRoutes.request('/worlds/home-world/scene/revisions', { method: 'POST', headers, body: JSON.stringify({ requestId: 'req-1', expectedVersion: 0, operations: [{ type: 'add_object', object: { id: 'bench-1', assetId: 'bench', position: { x: 1, y: 1 }, binding: null, label: null, purpose: null } }] }) }, f.env)
    expect(save.status).toBe(200); expect(await save.json()).toMatchObject({ version: 1 })
    const current = await scenesRoutes.request('/worlds/home-world/scene', { headers }, f.env)
    expect(await current.json()).toMatchObject({ status: 'ready', version: 1 })
  })
})
