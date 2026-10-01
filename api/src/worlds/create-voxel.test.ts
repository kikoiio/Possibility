import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyEdits, createEmptyWorld, isSerializedVoxelDocument, serialize, type EditOperation, type SerializedVoxelDocument, type VoxelDocument } from '@possibility/voxel-contract'
import { createTestDb } from '../test/db'
import { persons, sessions, users, worldSceneRevisions } from '../db/schema'
import { worldsRoutes } from './routes'

const NOW = '2026-10-01T00:00:00.000Z'
let fixture: ReturnType<typeof createTestDb> | undefined
afterEach(() => { fixture?.close(); fixture = undefined })

async function setup() {
  fixture = createTestDb()
  await fixture.db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'x', createdAt: NOW })
  await fixture.db.insert(sessions).values({ token: 'token', userId: 'u', expiresAt: '2099-01-01T00:00:00.000Z' })
  await fixture.db.insert(persons).values({ id: 'p1', userId: 'u', name: '阿黛', modelJson: '{}', createdAt: NOW })
  return fixture
}

const LOCATIONS = ['主楼', '温室', '湖畔', '花园', '码头'].map(name => ({ name, description: `${name}的日常` }))

/** 合法体素信封:平地 + 每地点一个灯笼承载绑定 */
function voxelEnvelope(names: string[]): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'create-voxel')
  const ops: EditOperation[] = [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
    ...names.map<EditOperation>((_, i) => ({ kind: 'place-object', objectId: `spot-${i}`, objectType: 'stone-lantern', anchor: { x: 1 + i * 3, y: 1, z: 1 }, rotation: 0 })),
  ]
  const doc: VoxelDocument = { ...applyEdits(base, ops).document, locations: names.map((name, i) => ({ name, objectId: `spot-${i}` })) }
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    name: '湖畔庄园', description: '湖边的庄园。', locations: LOCATIONS, personIds: ['p1'],
    scene: voxelEnvelope(LOCATIONS.map(l => l.name)), sceneRequestId: 'req-create-1',
    ...overrides,
  }
}

const post = (body: unknown) =>
  worldsRoutes.request('/', { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, fixture!.env)

describe('POST /api/worlds 体素场景创建(S1)', () => {
  it('合法体素信封:世界创建成功、场景随初始版本入库且保持体素格式', async () => {
    const f = await setup()
    const res = await post(createBody())
    expect(res.status).toBe(200)
    const { id } = await res.json() as { id: string }
    const revision = await f.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, id)).get()
    expect(revision).toBeTruthy()
    expect(revision!.kind).toBe('initial')
    expect(isSerializedVoxelDocument(JSON.parse(revision!.documentJson))).toBe(true)
  })

  it('地点绑定覆盖不符 → 400;缺 sceneRequestId → 400', async () => {
    await setup()
    const mismatch = await post(createBody({ scene: voxelEnvelope(LOCATIONS.slice(1).map(l => l.name)), sceneRequestId: 'req-create-2' }))
    expect(mismatch.status).toBe(400)
    expect(await mismatch.json()).toMatchObject({ error: expect.stringContaining('地点绑定') })
    const noReqId = await post(createBody({ sceneRequestId: undefined }))
    expect(noReqId.status).toBe(400)
  })

  it('体素校验失败(不可行走) → 400 并携带 issues', async () => {
    await setup()
    // 平地 y=1 整层封死 → 无净空
    const broken = (() => {
      const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'create-voxel-bad')
      const ops: EditOperation[] = [
        { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
        { kind: 'fill', from: { x: 0, y: 1, z: 0 }, to: { x: 15, y: 1, z: 15 }, block: 'stone' },
      ]
      return JSON.parse(serialize({ ...applyEdits(base, ops).document, locations: LOCATIONS.map((l, i) => ({ name: l.name, objectId: `spot-${i}` })) })) as SerializedVoxelDocument
    })()
    const res = await post(createBody({ scene: broken, sceneRequestId: 'req-create-3' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('校验') })
  })
})
