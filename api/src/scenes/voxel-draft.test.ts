import { afterEach, describe, expect, it } from 'vitest'
import { applyEdits, createEmptyWorld, isSerializedVoxelDocument, type EditOperation, type VoxelDocument } from '@possibility/voxel-contract'
import { createTestDb } from '../test/db'
import { persons, users } from '../db/schema'
import { buildVoxelSceneDescription, createVoxelSceneDraft } from './voxel-draft'
import { WorldGeneratorError } from '../voxel/generate'
import type { WorldDraft } from '../worlds/draft'

const NOW = '2026-10-01T00:00:00.000Z'
let fixture: ReturnType<typeof createTestDb> | undefined
afterEach(() => { fixture?.close(); fixture = undefined })

async function setup() {
  fixture = createTestDb()
  await fixture.db.insert(users).values([
    { id: 'u', username: 'u', passwordHash: 'x', createdAt: NOW },
    { id: 'other', username: 'other', passwordHash: 'x', createdAt: NOW },
  ])
  await fixture.db.insert(persons).values([
    { id: 'p1', userId: 'u', name: '阿黛', modelJson: '{}', createdAt: NOW },
    { id: 'p2', userId: 'u', name: '小北', modelJson: '{}', createdAt: NOW },
    { id: 'p3', userId: 'other', name: '别人的人', modelJson: '{}', createdAt: NOW },
  ])
  return fixture
}

const WORLD: WorldDraft = {
  name: '湖畔庄园',
  description: '湖边的庄园,住着几位安静的人。',
  locations: ['主楼', '温室', '湖畔', '花园', '码头'].map(name => ({ name, description: `${name}的日常` })),
}

/** 合法体素文档:平地 + 每地点一个灯笼承载绑定(与生成器产物同构) */
function docWithLocations(names: string[]): VoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'draft-test')
  const ops: EditOperation[] = [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
    ...names.map<EditOperation>((_, i) => ({ kind: 'place-object', objectId: `spot-${i}`, objectType: 'stone-lantern', anchor: { x: 1 + i * 3, y: 1, z: 1 }, rotation: 0 })),
  ]
  const doc = applyEdits(base, ops).document
  return { ...doc, locations: names.map((name, i) => ({ name, objectId: `spot-${i}` })) }
}

describe('buildVoxelSceneDescription', () => {
  it('枚举全部地点并给出逐字绑定硬约束', () => {
    const desc = buildVoxelSceneDescription(WORLD, '湖边的庄园')
    for (const location of WORLD.locations) expect(desc).toContain(`「${location.name}」`)
    expect(desc).toContain('登记进 locations')
    expect(desc).toContain('严禁多个地点绑定同一物体')
  })
})

describe('createVoxelSceneDraft(S1 体素创建)', () => {
  const deps = (doc: VoxelDocument, capture?: { desc?: string }) => ({
    draftWorldFn: (async () => WORLD) as never,
    generateWorldFn: (async (desc: string) => { if (capture) capture.desc = desc; return doc }) as never,
  })

  it('骨架 → 体素草稿:信封可序列化回读、世界透传、生成描述含绑定指令', async () => {
    await setup()
    const capture: { desc?: string } = {}
    const result = await createVoxelSceneDraft(fixture!.env, fixture!.db, 'u',
      { requestId: 'req-1', prompt: '湖边的庄园', personIds: ['p1', 'p2'] },
      deps(docWithLocations(WORLD.locations.map(l => l.name)), capture))
    expect(result.world).toEqual(WORLD)
    expect(isSerializedVoxelDocument(result.document)).toBe(true)
    expect(result.document.locations.map(l => l.name).sort()).toEqual(WORLD.locations.map(l => l.name).sort())
    expect(capture.desc).toContain('「湖畔庄园」')
    expect(capture.desc).toContain('「码头」')
    expect(result.explanation).toContain('湖畔庄园')
  })

  it('地点绑定覆盖缺失 → WorldGeneratorError(创建端 502)', async () => {
    await setup()
    const doc = docWithLocations(WORLD.locations.slice(1).map(l => l.name)) // 缺「主楼」
    await expect(createVoxelSceneDraft(fixture!.env, fixture!.db, 'u',
      { requestId: 'req-2', prompt: '湖边的庄园', personIds: ['p1'] }, deps(doc)))
      .rejects.toThrowError(WorldGeneratorError)
    await expect(createVoxelSceneDraft(fixture!.env, fixture!.db, 'u',
      { requestId: 'req-2', prompt: '湖边的庄园', personIds: ['p1'] }, deps(doc)))
      .rejects.toThrow('主楼')
  })

  it('居民归属与人数校验', async () => {
    await setup()
    const doc = docWithLocations(WORLD.locations.map(l => l.name))
    await expect(createVoxelSceneDraft(fixture!.env, fixture!.db, 'u',
      { requestId: 'req-3', prompt: 'x', personIds: [] }, deps(doc))).rejects.toThrow('1-6 位居民')
    await expect(createVoxelSceneDraft(fixture!.env, fixture!.db, 'u',
      { requestId: 'req-4', prompt: 'x', personIds: ['p3'] }, deps(doc))).rejects.toThrow('不属于你的居民')
  })
})
