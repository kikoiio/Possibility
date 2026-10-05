import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyEdits, createEmptyWorld, isSerializedVoxelDocument, serialize, type EditOperation, type SerializedVoxelDocument, type VoxelDocument } from '@possibility/voxel-contract'
import { createTestDb } from '../test/db'
import { persons, sessions, users, worldPersons, worldSceneRevisions, worlds } from '../db/schema'
import { initialSceneStatements } from '../scenes/repository'
import type { SceneWriteProof } from '../scenes/compatibility/write-proof'
import { buildTestPolicyActivationSql } from '../../scripts/prepare-scene-compatibility-fixture'
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

describe('A1 initial scene', () => {
  /** 给首版信封的 spot-0 载体加人物绑定 */
  function envelopeWithPersonBinding(personId: string): SerializedVoxelDocument {
    const doc = voxelEnvelope(LOCATIONS.map(l => l.name))
    const objects = doc.objects.map((object, i) => i === 0 ? { ...object, binding: { kind: 'person' as const, personId } } : object)
    return { ...doc, objects }
  }

  it('策略激活后带成员创建成功：首版依据携带批内绑定快照（B30/B54）', async () => {
    const f = await setup()
    f.sqlite.exec(await buildTestPolicyActivationSql())
    const res = await post(createBody({ sceneRequestId: 'req-a1-active' }))
    expect(res.status).toBe(200)
    const { id } = await res.json() as { id: string }
    const members = await f.db.select().from(worldPersons).where(eq(worldPersons.worldId, id)).all()
    expect(members.map(member => member.personId)).toEqual(['p1'])
    const revision = await f.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, id)).get()
    expect(revision).toBeTruthy()
    expect(revision!.commitGuard).toBe(true)
    const proof = JSON.parse(revision!.validationJson!) as SceneWriteProof
    expect(proof.mode).toBe('initial')
    expect(proof.bindings.personIds).toEqual(['p1'])
    expect(proof.bindings.locations).toEqual(LOCATIONS.map(l => l.name).sort())
  })

  it('场景语句失败时世界/成员整批回滚（B54）', async () => {
    const f = await setup()
    f.sqlite.exec(await buildTestPolicyActivationSql())
    const worldId = 'w-a1-rollback'
    // 与路由同序的批：世界先写、场景语句随后；快照声明的成员不在批内 → authority gate 拒绝 → 整批回滚
    await expect(f.db.batch([
      f.db.insert(worlds).values({
        id: worldId, userId: 'u', name: '回滚世界', description: 'd',
        locationsJson: JSON.stringify(LOCATIONS), status: 'running', isDemo: false, callsToday: 0, createdAt: NOW,
      }),
      ...await initialSceneStatements(f.db, worldId, voxelEnvelope(LOCATIONS.map(l => l.name)), 'req-a1-rollback', { personIds: ['p1'], locations: LOCATIONS }),
    ])).rejects.toThrow(/scene_revision_binding_mismatch/)
    expect(await f.db.select().from(worlds).where(eq(worlds.id, worldId)).get()).toBeUndefined()
    expect(await f.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, worldId)).all()).toHaveLength(0)
  })

  it('绑定快照与批内实际资料不符被拒且不残留（B30 最终断言）', async () => {
    const f = await setup()
    f.sqlite.exec(await buildTestPolicyActivationSql())
    const worldId = 'w-a1-mismatch'
    // 批内写入成员 p1，快照却声明 p-stranger → 插入闸门拒绝，世界/成员不残留
    await expect(f.db.batch([
      f.db.insert(worlds).values({
        id: worldId, userId: 'u', name: '错快照世界', description: 'd',
        locationsJson: JSON.stringify(LOCATIONS), status: 'running', isDemo: false, callsToday: 0, createdAt: NOW,
      }),
      f.db.insert(worldPersons).values({ worldId, personId: 'p1', joinedAt: NOW }),
      ...await initialSceneStatements(f.db, worldId, voxelEnvelope(LOCATIONS.map(l => l.name)), 'req-a1-mismatch', { personIds: ['p-stranger'], locations: LOCATIONS }),
    ])).rejects.toThrow(/scene_revision_binding_mismatch/)
    expect(await f.db.select().from(worlds).where(eq(worlds.id, worldId)).get()).toBeUndefined()
    expect(await f.db.select().from(worldPersons).where(eq(worldPersons.worldId, worldId)).all()).toHaveLength(0)
  })

  it('人物绑定预检：场景绑定未选定人物 → 400；绑定选定人物 → 200（B54/P17）', async () => {
    await setup()
    const stranger = await post(createBody({ scene: envelopeWithPersonBinding('p-stranger'), sceneRequestId: 'req-a1-stranger' }))
    expect(stranger.status).toBe(400)
    expect(await stranger.json()).toMatchObject({ error: expect.stringContaining('人物绑定') })
    const own = await post(createBody({ scene: envelopeWithPersonBinding('p1'), sceneRequestId: 'req-a1-own' }))
    expect(own.status).toBe(200)
  })
})
