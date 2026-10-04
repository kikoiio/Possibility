import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyEdits, createEmptyWorld, isSerializedVoxelDocument, type EditOperation, type VoxelDocument } from '@possibility/voxel-contract'
import { createTestDb } from '../test/db'
import { llmCallLog, persons, users, worlds } from '../db/schema'
import { buildVoxelSceneDescription, createFixedWorldVoxelSceneDraft, createVoxelSceneDraft } from './voxel-draft'
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

function modelResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
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
  const deps = (doc: VoxelDocument, capture?: { desc?: string }, sceneCalls = 0) => ({
    generateWorldFn: (async (desc: string, _theme: string, options: { complete: (messages: never[]) => Promise<string> }) => {
      if (capture) capture.desc = desc
      for (let i = 0; i < sceneCalls; i++) await options.complete([])
      return doc
    }) as never,
  })

  it('骨架 → 体素草稿:信封可序列化回读、世界透传、生成描述含绑定指令且准确报告调用数', async () => {
    await setup()
    const capture: { desc?: string } = {}
    let providerCalls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      providerCalls++
      return modelResponse(providerCalls === 1 ? JSON.stringify(WORLD) : '{}')
    }))
    const sceneCalls = 3
    const result = await createVoxelSceneDraft(fixture!.env, fixture!.db, 'u',
      { requestId: 'req-1', prompt: '湖边的庄园', personIds: ['p1', 'p2'] },
      deps(docWithLocations(WORLD.locations.map(l => l.name)), capture, sceneCalls))
    expect(result.world).toEqual(WORLD)
    expect(isSerializedVoxelDocument(result.document)).toBe(true)
    expect(result.document.locations.map(l => l.name).sort()).toEqual(WORLD.locations.map(l => l.name).sort())
    expect(capture.desc).toContain('「湖畔庄园」')
    expect(capture.desc).toContain('「码头」')
    expect(result.explanation).toContain('湖畔庄园')
    expect(result.callsUsed).toBe(providerCalls)
    expect(result.callsUsed).toBe(1 + sceneCalls)
    expect(await fixture!.db.select().from(llmCallLog)).toHaveLength(result.callsUsed)
  })

  it('场景生成失败时错误保留骨架与场景调用数', async () => {
    await setup()
    let providerCalls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      providerCalls++
      return modelResponse(providerCalls === 1 ? JSON.stringify(WORLD) : '{}')
    }))
    const sceneCalls = 2
    const error = new WorldGeneratorError('场景生成失败')
    const failedDeps = {
      generateWorldFn: (async (_desc: string, _theme: string, options: { complete: (messages: never[]) => Promise<string> }) => {
        for (let i = 0; i < sceneCalls; i++) await options.complete([])
        throw error
      }) as never,
    }
    await expect(createVoxelSceneDraft(fixture!.env, fixture!.db, 'u',
      { requestId: 'req-failed', prompt: '湖边的庄园', personIds: ['p1'] }, failedDeps))
      .rejects.toBe(error)
    expect(error).toMatchObject({ callsUsed: providerCalls })
    expect(error).toMatchObject({ callsUsed: 1 + sceneCalls })
    expect(await fixture!.db.select().from(llmCallLog)).toHaveLength((error as WorldGeneratorError & { callsUsed: number }).callsUsed)
  })

  it('骨架失败时错误带重试后的实际调用数', async () => {
    await setup()
    const provider = vi.fn(async () => modelResponse('{invalid'))
    vi.stubGlobal('fetch', provider)
    const error = await createVoxelSceneDraft(fixture!.env, fixture!.db, 'u',
      { requestId: 'req-skeleton-failed', prompt: '湖边的庄园', personIds: ['p1'] }, deps(docWithLocations(WORLD.locations.map(l => l.name))))
      .catch((failure: Error & { callsUsed?: number }) => failure)
    expect(error).toMatchObject({ callsUsed: provider.mock.calls.length })
    expect(error).toMatchObject({ callsUsed: 2 })
    expect(await fixture!.db.select().from(llmCallLog)).toHaveLength(error.callsUsed!)
  })

  it('地点绑定覆盖缺失 → WorldGeneratorError(创建端 502)', async () => {
    await setup()
    const doc = docWithLocations(WORLD.locations.slice(1).map(l => l.name)) // 缺「主楼」
    vi.stubGlobal('fetch', vi.fn(async () => modelResponse(JSON.stringify(WORLD))))
    await expect(createVoxelSceneDraft(fixture!.env, fixture!.db, 'u',
      { requestId: 'req-2', prompt: '湖边的庄园', personIds: ['p1'] }, deps(doc)))
      .rejects.toThrowError(WorldGeneratorError)
    vi.stubGlobal('fetch', vi.fn(async () => modelResponse(JSON.stringify(WORLD))))
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

describe('createFixedWorldVoxelSceneDraft(R2 原世界补建)', () => {
  it('uses the supplied world and residents directly without drafting or persisting a replacement world', async () => {
    await setup()
    let captured = ''
    const result = await createFixedWorldVoxelSceneDraft(fixture!.env, fixture!.db, 'u', {
      requestId: 'repair-existing-world',
      prompt: '在湖畔建一座温室',
      world: { id: 'existing-world', ...WORLD },
      residents: [{ id: 'p1', name: '阿黛' }],
    }, {
      generateWorldFn: (async (description: string) => {
        captured = description
        return docWithLocations(WORLD.locations.map(location => location.name))
      }) as never,
    })
    expect(result.worldId).toBe('existing-world')
    expect(result.document.locations.map(location => location.name)).toEqual(WORLD.locations.map(location => location.name))
    expect(captured).toContain('湖边的庄园,住着几位安静的人。')
    expect(captured).toContain('阿黛')
    expect(captured).toContain('创建者的一句话:在湖畔建一座温室')
    expect(await fixture!.db.select().from(worlds)).toHaveLength(0)
  })
})
