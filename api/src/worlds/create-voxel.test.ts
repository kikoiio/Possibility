import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyEdits, createEmptyWorld, isSerializedVoxelDocument, serialize, type EditOperation, type SerializedVoxelDocument, type VoxelDocument } from '@possibility/voxel-contract'
import { createTestDb } from '../test/db'
import { persons, sessions, timelines, users, worldPersons, worldScenes, worldSceneRevisions, worlds } from '../db/schema'
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

const postAs = (token: string, body: unknown) =>
  worldsRoutes.request('/', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, fixture!.env)
const post = (body: unknown) => postAs('token', body)

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

  it('地点绑定覆盖不符 → 422;缺 sceneRequestId → 400', async () => {
    await setup()
    const mismatch = await post(createBody({ scene: voxelEnvelope(LOCATIONS.slice(1).map(l => l.name)), sceneRequestId: 'req-create-2' }))
    expect(mismatch.status).toBe(422)
    expect(await mismatch.json()).toMatchObject({ error: expect.stringContaining('地点绑定') })
    const noReqId = await post(createBody({ sceneRequestId: undefined }))
    expect(noReqId.status).toBe(400)
  })

  it('相同 owner 请求键和负载重放时返回原 world 与 timeline，且不重复初始数据', async () => {
    const f = await setup()
    const body = createBody({ sceneRequestId: 'req-idempotent-create' })
    const first = await post(body)
    expect(first.status).toBe(200)
    const original = await first.json() as { id: string; timelineId: string }
    expect(await f.db.select().from(worlds).all()).toHaveLength(1)
    expect(await f.db.select().from(timelines).all()).toHaveLength(1)
    expect(await f.db.select().from(worldSceneRevisions).all()).toHaveLength(1)

    // A successful replay remains available even if the created world is subsequently capped.
    await f.db.update(worlds).set({ status: 'capped', pauseReason: 'global_daily_cap' }).where(eq(worlds.id, original.id))
    const replay = await post(body)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(original)
    expect(await f.db.select().from(worlds).all()).toHaveLength(1)
    expect(await f.db.select().from(timelines).all()).toHaveLength(1)
    expect(await f.db.select().from(worldPersons).where(eq(worldPersons.worldId, original.id)).all()).toHaveLength(1)
    expect(await f.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, original.id)).all()).toHaveLength(1)
    expect(await f.db.select().from(worlds).where(eq(worlds.id, original.id)).get()).toMatchObject({ status: 'capped' })
  })

  it('同一请求键的不同负载冲突，且不修改已创建世界', async () => {
    const f = await setup()
    const first = await post(createBody({ sceneRequestId: 'req-conflicting-create' }))
    expect(first.status).toBe(200)
    const original = await first.json() as { id: string; timelineId: string }
    const before = await f.db.select().from(worlds).where(eq(worlds.id, original.id)).get()

    const conflict = await post(createBody({ name: '改过的庄园', sceneRequestId: 'req-conflicting-create' }))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ errorCode: 'request_id_conflict' })
    expect(await f.db.select().from(worlds).all()).toHaveLength(1)
    expect(await f.db.select().from(timelines).all()).toHaveLength(1)
    expect(await f.db.select().from(worldSceneRevisions).all()).toHaveLength(1)
    expect(await f.db.select().from(worlds).where(eq(worlds.id, original.id)).get()).toEqual(before)
  })

  it('相同请求键在不同 owner 下隔离，重放不会返回其他账号的 world', async () => {
    const f = await setup()
    await f.db.insert(users).values({ id: 'u2', username: 'u2', passwordHash: 'x', createdAt: NOW })
    await f.db.insert(sessions).values({ token: 'token-u2', userId: 'u2', expiresAt: '2099-01-01T00:00:00.000Z' })
    await f.db.insert(persons).values({ id: 'p2', userId: 'u2', name: '阿晴', modelJson: '{}', createdAt: NOW })
    const requestId = 'req-owner-isolation'
    const first = await post(createBody({ sceneRequestId: requestId }))
    const otherOwner = await postAs('token-u2', createBody({ personIds: ['p2'], sceneRequestId: requestId }))
    expect(first.status).toBe(200)
    expect(otherOwner.status).toBe(200)
    const firstWorld = await first.json() as { id: string; timelineId: string }
    const otherWorld = await otherOwner.json() as { id: string; timelineId: string }
    expect(otherWorld.id).not.toBe(firstWorld.id)
    expect(otherWorld.timelineId).not.toBe(firstWorld.timelineId)
    const firstReplay = await post(createBody({ sceneRequestId: requestId }))
    expect(await firstReplay.json()).toEqual(firstWorld)
    expect(await f.db.select().from(worlds).all()).toHaveLength(2)
  })

  it('并发相同创建尝试收敛到一组原子 world/timeline/scene 记录', async () => {
    const f = await setup()
    const body = createBody({ sceneRequestId: 'req-concurrent-create' })
    const [first, second] = await Promise.all([post(body), post(body)])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual(await first.json())
    expect(await f.db.select().from(worlds).all()).toHaveLength(1)
    expect(await f.db.select().from(timelines).all()).toHaveLength(1)
    expect(await f.db.select().from(worldPersons).all()).toHaveLength(1)
    expect(await f.db.select().from(worldScenes).all()).toHaveLength(1)
    expect(await f.db.select().from(worldSceneRevisions).all()).toHaveLength(1)
  })

  it('并发复用同一请求键提交不同负载时只接受一个并将另一请求冲突拒绝', async () => {
    const f = await setup()
    const [first, second] = await Promise.all([
      post(createBody({ name: '湖畔庄园 A', sceneRequestId: 'req-concurrent-conflict' })),
      post(createBody({ name: '湖畔庄园 B', sceneRequestId: 'req-concurrent-conflict' })),
    ])
    expect([first.status, second.status].sort()).toEqual([200, 409])
    const conflict = first.status === 409 ? first : second
    expect(await conflict.json()).toMatchObject({ errorCode: 'request_id_conflict' })
    expect(await f.db.select().from(worlds).all()).toHaveLength(1)
    expect(await f.db.select().from(timelines).all()).toHaveLength(1)
    expect(await f.db.select().from(worldPersons).all()).toHaveLength(1)
    expect(await f.db.select().from(worldScenes).all()).toHaveLength(1)
    expect(await f.db.select().from(worldSceneRevisions).all()).toHaveLength(1)
  })

  it('体素校验失败(不可行走) → 422 并携带 issues', async () => {
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
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('校验') })
  })
})

describe('A1 initial scene', () => {
  async function expectNoPartialWorldCreate(f: ReturnType<typeof createTestDb>) {
    expect(await f.db.select().from(worlds).all()).toHaveLength(0)
    expect(await f.db.select().from(timelines).all()).toHaveLength(0)
    expect(await f.db.select().from(worldPersons).all()).toHaveLength(0)
    expect(await f.db.select().from(worldScenes).all()).toHaveLength(0)
    expect(await f.db.select().from(worldSceneRevisions).all()).toHaveLength(0)
  }

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
    const { id, timelineId } = await res.json() as { id: string; timelineId: string }
    expect(await f.db.select().from(worlds).where(eq(worlds.id, id)).get()).toMatchObject({ id, userId: 'u' })
    expect(await f.db.select().from(timelines).where(eq(timelines.id, timelineId)).get()).toMatchObject({ id: timelineId, worldId: id, parentTimelineId: null })
    const members = await f.db.select().from(worldPersons).where(eq(worldPersons.worldId, id)).all()
    expect(members.map(member => member.personId)).toEqual(['p1'])
    expect(await f.db.select().from(worldScenes).where(eq(worldScenes.worldId, id)).get()).toMatchObject({ worldId: id, currentVersion: 1 })
    const revision = await f.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, id)).get()
    expect(revision).toBeTruthy()
    expect(revision!.commitGuard).toBe(true)
    const proof = JSON.parse(revision!.validationJson!) as SceneWriteProof
    expect(proof.mode).toBe('initial')
    expect(proof.bindings.personIds).toEqual(['p1'])
    expect(proof.bindings.locations).toEqual(LOCATIONS.map(l => l.name).sort())
  })

  it('真实创建入口：无效首版几何被拒且五类创建记录均无残留', async () => {
    const f = await setup()
    const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'create-voxel-invalid-initial')
    const ops: EditOperation[] = [
      { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
      { kind: 'fill', from: { x: 0, y: 1, z: 0 }, to: { x: 15, y: 1, z: 15 }, block: 'stone' },
    ]
    const invalid = JSON.parse(serialize({
      ...applyEdits(base, ops).document,
      locations: LOCATIONS.map((location, i) => ({ name: location.name, objectId: `spot-${i}` })),
    })) as SerializedVoxelDocument

    const res = await post(createBody({ scene: invalid, sceneRequestId: 'req-a1-invalid-initial' }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('校验'), issues: expect.any(Array) })
    await expectNoPartialWorldCreate(f)
  })

  it('真实创建入口：选定人物与场景绑定不符时不创建任何世界数据', async () => {
    const f = await setup()
    const res = await post(createBody({ scene: envelopeWithPersonBinding('p-stranger'), sceneRequestId: 'req-a1-binding-mismatch' }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('人物绑定') })
    await expectNoPartialWorldCreate(f)
  })

  it('真实创建入口：批内成员与首版依据不符时整批回滚', async () => {
    const f = await setup()
    f.sqlite.exec(await buildTestPolicyActivationSql())
    // 模拟外层批次中的成员记录缺失；首版最终绑定断言必须使整批失败。
    f.sqlite.exec(`CREATE TRIGGER omit_initial_world_member BEFORE INSERT ON world_persons
      WHEN NEW.person_id = 'p1' BEGIN SELECT RAISE(IGNORE); END`)

    const res = await post(createBody({ sceneRequestId: 'req-a1-binding-guard-failure' }))
    expect(res.status).toBeGreaterThanOrEqual(500)
    await expectNoPartialWorldCreate(f)
  })

  it('真实创建入口：后置首版修订插入失败时世界、timeline、成员和场景整体回滚', async () => {
    const f = await setup()
    f.sqlite.exec(await buildTestPolicyActivationSql())
    f.sqlite.exec(`CREATE TRIGGER fail_initial_scene_revision BEFORE INSERT ON world_scene_revisions
      WHEN NEW.request_id = 'req-a1-late-initial-failure' BEGIN SELECT RAISE(ABORT, 'injected initial revision failure'); END`)

    const res = await post(createBody({ sceneRequestId: 'req-a1-late-initial-failure' }))
    expect(res.status).toBeGreaterThanOrEqual(500)
    await expectNoPartialWorldCreate(f)
  })

  it('创建批次原子回滚后，相同请求键和负载可以安全重试', async () => {
    const f = await setup()
    f.sqlite.exec(await buildTestPolicyActivationSql())
    f.sqlite.exec(`CREATE TRIGGER fail_create_once BEFORE INSERT ON world_scene_revisions
      WHEN NEW.request_id = 'req-create-retry-after-rollback' BEGIN SELECT RAISE(ABORT, 'injected first create failure'); END`)
    const body = createBody({ sceneRequestId: 'req-create-retry-after-rollback' })

    const failed = await post(body)
    expect(failed.status).toBeGreaterThanOrEqual(500)
    await expectNoPartialWorldCreate(f)

    f.sqlite.exec('DROP TRIGGER fail_create_once')
    const retried = await post(body)
    expect(retried.status).toBe(200)
    const created = await retried.json() as { id: string; timelineId: string }
    expect(await f.db.select().from(worlds).where(eq(worlds.id, created.id)).get()).toMatchObject({ id: created.id, userId: 'u' })
    expect(await f.db.select().from(timelines).where(eq(timelines.id, created.timelineId)).get()).toMatchObject({ id: created.timelineId, worldId: created.id })
    expect(await f.db.select().from(worldPersons).where(eq(worldPersons.worldId, created.id)).all()).toHaveLength(1)
    expect(await f.db.select().from(worldScenes).where(eq(worldScenes.worldId, created.id)).all()).toHaveLength(1)
    expect(await f.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, created.id)).all()).toHaveLength(1)
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

  it('人物绑定预检：场景绑定未选定人物 → 422；绑定选定人物 → 200（B54/P17）', async () => {
    await setup()
    const stranger = await post(createBody({ scene: envelopeWithPersonBinding('p-stranger'), sceneRequestId: 'req-a1-stranger' }))
    expect(stranger.status).toBe(422)
    expect(await stranger.json()).toMatchObject({ error: expect.stringContaining('人物绑定') })
    const own = await post(createBody({ scene: envelopeWithPersonBinding('p1'), sceneRequestId: 'req-a1-own' }))
    expect(own.status).toBe(200)
  })
})
