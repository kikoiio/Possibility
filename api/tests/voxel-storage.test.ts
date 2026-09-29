import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  applyEdits, createEmptyWorld, deserialize, serialize, type SerializedVoxelDocument,
} from '@possibility/voxel-contract'
import { persons, worldPersons, worldSceneRevisions } from '../src/db/schema'
import { createWorldFixture, WORLD_TIME } from '../src/test/world-fixture'
import { commitScene, initialSceneStatements, readCurrentScene } from '../src/scenes/repository'
import { cloneWorldGraph } from '../src/demo/world-graph-cloner'

/** 小型体素世界 → 序列化信封（存储层接收的形态） */
function voxelEnvelope(): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 8, depth: 16 }, 'mist-manor', 'voxel-home')
  const doc = applyEdits(base, [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
    { kind: 'place-object', objectType: 'stone-lantern', anchor: { x: 3, y: 1, z: 3 }, rotation: 0, objectId: 'lantern-1' },
  ]).document
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

describe('voxel scene storage (T31)', () => {
  const fixtures: Awaited<ReturnType<typeof createWorldFixture>>[] = []
  afterEach(() => fixtures.splice(0).forEach((f) => f.close()))

  it('stores and reads voxel envelopes with contract round-trip intact', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    const envelope = voxelEnvelope()
    const committed = await commitScene(f.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'v1', document: envelope, summary: '体素初始', kind: 'initial' })
    expect(committed.version).toBe(1)
    // 信封的 version 是格式版本（恒 1），不被修订版本覆盖
    expect((committed.document as SerializedVoxelDocument).version).toBe(1)

    const stored = await readCurrentScene(f.db, 'home-world')
    expect(stored?.document).toEqual(envelope)
    // 存储内容可被契约反序列化：节数据（base64→Uint16Array）无损
    const revived = deserialize(JSON.stringify(stored!.document))
    expect(revived.id).toBe('voxel-home')
    expect(revived.objects.map((o) => o.id)).toEqual(['lantern-1'])
    expect(Object.keys(revived.sections).length).toBeGreaterThan(0)

    // 同 requestId 幂等；不同内容进入下一修订版本
    const replay = await commitScene(f.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'v1', document: envelope, summary: '体素初始', kind: 'initial' })
    expect(replay.version).toBe(1)
    const second = await commitScene(f.db, { worldId: 'home-world', expectedVersion: 1, requestId: 'v2', document: { ...envelope, id: 'voxel-home-2' }, summary: '调整', kind: 'edit' })
    expect(second.version).toBe(2)
    expect((await readCurrentScene(f.db, 'home-world'))?.version).toBe(2)
  })

  it('initialSceneStatements accepts voxel envelopes (world creation path)', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    const envelope = voxelEnvelope()
    const statements = await initialSceneStatements(f.db, 'other-world', envelope, 'init-1')
    await f.db.batch(statements)
    const stored = await readCurrentScene(f.db, 'other-world')
    expect(stored?.version).toBe(1)
    expect(stored?.document).toEqual(envelope)
  })

  it('guest clone deep-copies voxel documents: remap bindings, isolate sections/objectCells (AC15)', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    await f.db.insert(persons).values({ id: 'person-1', userId: 'owner', name: '小夜', modelJson: '{}', createdAt: WORLD_TIME })
    await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'person-1', joinedAt: WORLD_TIME })
    const envelope = voxelEnvelope()
    envelope.objects.push({ id: 'obj-ada', objectType: 'bench', anchor: { x: 5, y: 1, z: 5 }, rotation: 0, binding: { kind: 'person', personId: 'person-1' } })
    await commitScene(f.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'init', document: envelope, summary: '初始', kind: 'initial' })

    const cloned = await cloneWorldGraph(f.db, { sourceWorldId: 'home-world', targetOwnerId: 'other', requestId: 'clone-1' })
    const clonedScene = await readCurrentScene(f.db, cloned.worldId)
    const clonedEnvelope = clonedScene!.document as SerializedVoxelDocument
    // 人物绑定重映射到克隆的新 person id
    const newPersonId = cloned.personIds.get('person-1')!
    expect(newPersonId).toBeTruthy()
    expect(clonedEnvelope.objects.find((o) => o.id === 'obj-ada')?.binding).toEqual({ kind: 'person', personId: newPersonId })
    // 节数据与格子登记完整复制
    expect(clonedEnvelope.sections).toEqual(envelope.sections)
    expect(clonedEnvelope.objectCells).toEqual(envelope.objectCells)

    // 改克隆副本的存储内容（sections/objectCells 清空）不影响源世界
    const clonedRow = await f.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, cloned.worldId)).get()
    const tampered = JSON.parse(clonedRow!.documentJson) as SerializedVoxelDocument
    tampered.sections = {}
    tampered.objectCells = []
    await f.db.update(worldSceneRevisions).set({ documentJson: JSON.stringify(tampered) }).where(eq(worldSceneRevisions.worldId, cloned.worldId))

    const sourceAfter = await readCurrentScene(f.db, 'home-world')
    const sourceEnvelope = sourceAfter!.document as SerializedVoxelDocument
    expect(sourceEnvelope.objectCells).toEqual(envelope.objectCells)
    expect(Object.keys(sourceEnvelope.sections).length).toBeGreaterThan(0)
    // 篡改确实落在了克隆上（证明读的是不同行）
    expect((await readCurrentScene(f.db, cloned.worldId))!.document).toMatchObject({ sections: {}, objectCells: [] })
  })
})
