import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createEmptyWorld,
  setBlockMut,
  serialize,
  type SceneBindingContext,
  type SerializedVoxelDocument,
  type SceneWorkControl,
} from '@possibility/voxel-contract'
import { createTestDb } from '../../test/db'
import {
  sceneCompatibilityRequests,
  users,
  worldSceneRevisions,
  worldScenes,
  worlds,
} from '../../db/schema'
import { commitScene, readCurrentScene } from '../repository'
import {
  confirmCompatibility,
  createCompatibilityDraft,
  inspectSceneCompatibility,
  preflightSceneEdit,
  readCompatibilityRequest,
} from './service'
import { toSceneCompatibilityDraftView } from './repository'
import type { SceneValidationAccess } from './context'

const NOW = '2026-10-05T00:00:00.000Z'
const ACTOR = { actorKey: 'actor-1', userId: 'u' }

/** 固定时钟与空调度，禁止真实 sleep */
const control = (): Partial<SceneWorkControl> => ({
  signal: new AbortController().signal,
  nowMs: () => 0,
  yieldControl: async () => {},
})

const access = (overrides: Partial<SceneBindingContext> = {}): SceneValidationAccess => ({
  bindings: {
    personIds: [],
    locations: [],
    protectedObjects: [],
    protectedPlacements: [],
    locationBindings: [],
    personBindings: [],
    entries: [],
    ...overrides,
  },
})

/** 合法体素场景:4x4x3,一层草地,无摆放 */
function validDocument(id = 'compat-valid'): SerializedVoxelDocument {
  const doc = createEmptyWorld({ width: 4, height: 3, depth: 4 }, 'mist-manor', id)
  for (let z = 0; z < 4; z += 1) for (let x = 0; x < 4; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

/** 资产压物体的非法场景:veg-flower-a(植被,可修复)或 bld-hut-a(建筑,不可修复) */
function collisionDocument(assetId: 'veg-flower-a' | 'bld-hut-a'): SerializedVoxelDocument {
  const doc = createEmptyWorld({ width: 4, height: 3, depth: 4 }, 'mist-manor', `compat-${assetId}`)
  for (let z = 0; z < 4; z += 1) for (let x = 0; x < 4; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
  doc.assetPlacements = [{ id: 'asset-1', assetId, anchor: [1, 0, 1], rotation: 0, seed: 1 }]
  doc.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: { x: 1, y: 0, z: 1 }, rotation: 0 })
  doc.objectCells.push({ objectId: 'keeper', cells: [{ x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }] })
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

describe('scene compatibility service', () => {
  const fixtures: ReturnType<typeof createTestDb>[] = []
  afterEach(() => { fixtures.splice(0).forEach((f) => f.close()) })

  async function seedWorld(worldId = 'w1') {
    const f = createTestDb()
    fixtures.push(f)
    await f.db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'x', createdAt: NOW })
    await f.db.insert(worlds).values({ id: worldId, userId: 'u', name: 'W', description: '' })
    return f
  }

  async function seedScene(
    f: ReturnType<typeof createTestDb>,
    worldId: string,
    document: SerializedVoxelDocument,
    requestId = 'seed-1',
  ) {
    return commitScene(f.db, { worldId, expectedVersion: 0, requestId, document, summary: '种子场景', kind: 'initial' })
  }

  const revisionCount = async (f: ReturnType<typeof createTestDb>, worldId: string) =>
    (await f.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, worldId))).length

  /** 绕过 commitScene 直接写入一条场景修订(用于损坏/不支持格式) */
  async function insertRawScene(f: ReturnType<typeof createTestDb>, worldId: string, documentJson: string) {
    await f.db.insert(worldScenes).values({ worldId, currentVersion: 1, themeId: 'mist-manor', updatedAt: NOW })
    await f.db.insert(worldSceneRevisions).values({
      id: crypto.randomUUID(), worldId, version: 1, parentVersion: null, requestId: 'raw-1',
      contentHash: 'raw-hash', documentJson, summary: 'raw', kind: 'initial', createdAt: NOW,
    })
  }

  it('1. current inspection: 合法当前场景 ready/valid 且不可建修复草稿', async () => {
    const f = await seedWorld()
    await seedScene(f, 'w1', validDocument())
    const result = await inspectSceneCompatibility(f.db, { worldId: 'w1', access: access(), control: control() })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.report.status).toBe('valid')
    expect(result.canCreateRepairDraft).toBe(false)
    expect(result.source.version).toBe(1)
    expect(result.basis.expectedCurrentVersion).toBe(1)
  })

  it('1. current inspection: 非法当前场景 invalid 且可建修复草稿', async () => {
    const f = await seedWorld()
    await seedScene(f, 'w1', collisionDocument('veg-flower-a'))
    const result = await inspectSceneCompatibility(f.db, { worldId: 'w1', access: access(), control: control() })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.report.status).toBe('invalid')
    expect(result.canCreateRepairDraft).toBe(true)
    expect(result.report.issues.some((issue) => issue.code === 'asset-overlap')).toBe(true)
  })

  it('2. historical inspection: 存在的历史版本 ready,缺失版本 missing', async () => {
    const f = await seedWorld()
    await seedScene(f, 'w1', validDocument('compat-v1'))
    await commitScene(f.db, {
      worldId: 'w1', expectedVersion: 1, requestId: 'seed-2',
      document: validDocument('compat-v2'), summary: '第二版', kind: 'edit',
    })

    const history = await inspectSceneCompatibility(f.db, {
      worldId: 'w1', target: { kind: 'history', version: 1 }, access: access(), control: control(),
    })
    expect(history.status).toBe('ready')
    if (history.status !== 'ready') return
    expect(history.source.version).toBe(1)
    expect(history.report.status).toBe('valid')
    expect(history.basis.expectedCurrentVersion).toBe(2)

    const missing = await inspectSceneCompatibility(f.db, {
      worldId: 'w1', target: { kind: 'history', version: 99 }, access: access(), control: control(),
    })
    expect(missing.status).toBe('missing')
    if (missing.status === 'ready') return
    expect(missing.error.code).toBe('scene-missing')
  })

  it('3. 无场景世界 → missing / scene-missing', async () => {
    const f = await seedWorld()
    const result = await inspectSceneCompatibility(f.db, { worldId: 'w1', access: access(), control: control() })
    expect(result.status).toBe('missing')
    if (result.status === 'ready') return
    expect(result.error.code).toBe('scene-missing')
  })

  it('3. documentJson 无法解析 → corrupt / scene-corrupt', async () => {
    const f = await seedWorld()
    await insertRawScene(f, 'w1', 'not-json{')
    const result = await inspectSceneCompatibility(f.db, { worldId: 'w1', access: access(), control: control() })
    expect(result.status).toBe('corrupt')
    if (result.status === 'ready') return
    expect(result.error.code).toBe('scene-corrupt')
  })

  it('3. 可解析但格式不支持 → unsupported / format-unsupported', async () => {
    const f = await seedWorld()
    await insertRawScene(f, 'w1', JSON.stringify({ format: 'legacy-2d-scene', version: 7 }))
    const result = await inspectSceneCompatibility(f.db, { worldId: 'w1', access: access(), control: control() })
    expect(result.status).toBe('unsupported')
    if (result.status === 'ready') return
    expect(result.error.code).toBe('format-unsupported')
  })

  it('3.5 preflight 来源区分: 既存问题标 existing,本次编辑引入的保留 edit', async () => {
    const f = await seedWorld()
    const stored = collisionDocument('veg-flower-a')
    await seedScene(f, 'w1', stored)

    // 候选与原场景相同 → 唯一问题为既存
    const same = await preflightSceneEdit(f.db, {
      worldId: 'w1', candidate: { kind: 'document', document: stored }, access: access(), control: control(),
    })
    expect(same.status).toBe('invalid')
    if (same.status !== 'invalid') return
    expect(same.report.issues.length).toBeGreaterThan(0)
    expect(same.report.issues.every(issue => issue.origin === 'existing')).toBe(true)
    expect(same.report.issues.every(issue => issue.id.includes('|existing|'))).toBe(true)

    // 候选在原既存碰撞上再引入一处新碰撞 → 既存保留 existing,新引入为 edit
    const worse = structuredClone(stored)
    worse.assetPlacements!.push({ id: 'asset-2', assetId: 'veg-flower-a', anchor: [1, 0, 1], rotation: 0, seed: 2 })
    const added = await preflightSceneEdit(f.db, {
      worldId: 'w1', candidate: { kind: 'document', document: worse }, access: access(), control: control(),
    })
    expect(added.status).toBe('invalid')
    if (added.status !== 'invalid') return
    const origins = added.report.issues.map(issue => issue.origin)
    expect(origins).toContain('existing')
    expect(origins).toContain('edit')
    // 原既存碰撞(asset-1 vs keeper)仍标 existing;asset-1↔asset-2 成对重叠为本次新引入,标 edit
    const keeperOverlap = added.report.issues.find(issue => issue.placementId === 'asset-1' && issue.objectId === 'keeper')
    expect(keeperOverlap?.origin).toBe('existing')
    const pairOverlap = added.report.issues.find(issue => issue.summary.includes('asset-2'))
    expect(pairOverlap?.origin).toBe('edit')
  })

  it('4. repair-current: 可修复场景产出 ready 草稿,确认前不产生新修订', async () => {
    const f = await seedWorld()
    await seedScene(f, 'w1', collisionDocument('veg-flower-a'))
    const before = await revisionCount(f, 'w1')

    const draft = await createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w1', draftRequestId: 'draft-1', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
    })
    expect(draft.status).toBe('ready')
    expect(draft.candidate).not.toBeNull()
    expect(draft.changes.length).toBeGreaterThan(0)
    expect(draft.report?.status).toBe('valid')
    const candidate = draft.candidate as SerializedVoxelDocument
    expect(candidate.assetPlacements?.[0]?.id).toBe('asset-1')
    expect(candidate.assetPlacements?.[0]?.anchor).not.toEqual([1, 0, 1])
    expect(await revisionCount(f, 'w1')).toBe(before)
  })

  it('5. restore-history: 非法历史版本产出 ready 草稿,候选来自该历史版本的修复', async () => {
    const f = await seedWorld()
    await seedScene(f, 'w1', collisionDocument('veg-flower-a'))
    await commitScene(f.db, {
      worldId: 'w1', expectedVersion: 1, requestId: 'seed-2',
      document: validDocument('compat-v2'), summary: '第二版', kind: 'edit',
    })
    const before = await revisionCount(f, 'w1')

    const draft = await createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w1', draftRequestId: 'draft-1', purpose: 'restore-history',
      target: { kind: 'history', version: 1 }, expectedCurrentVersion: 2, access: access(), control: control(),
    })
    expect(draft.status).toBe('ready')
    expect(draft.changes.length).toBeGreaterThan(0)
    expect(draft.report?.status).toBe('valid')
    // v1 的修复候选带着被挪走的资产摆放;当前 v2 没有任何资产摆放
    const candidate = draft.candidate as SerializedVoxelDocument
    expect(candidate.assetPlacements).toHaveLength(1)
    const current = await readCurrentScene(f.db, 'w1')
    expect((current?.document as SerializedVoxelDocument).assetPlacements ?? []).toHaveLength(0)
    expect(await revisionCount(f, 'w1')).toBe(before)
  })

  it('6. blocked repair: 建筑碰撞草稿 blocked,不可确认,不产生修订', async () => {
    const f = await seedWorld()
    await seedScene(f, 'w1', collisionDocument('bld-hut-a'))
    const before = await revisionCount(f, 'w1')

    const draft = await createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w1', draftRequestId: 'draft-1', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
    })
    expect(draft.status).toBe('blocked')
    expect(draft.candidate).toBeNull()
    expect(toSceneCompatibilityDraftView(draft).canConfirm).toBe(false)

    // 当前实现:repository 在草稿未 ready 时直接抛错,而非返回 draft-blocked 视图
    await expect(confirmCompatibility(f.db, {
      ...ACTOR, worldId: 'w1', draftId: draft.id, requestId: 'confirm-1',
      expectedCurrentVersion: 1, expectedAttempt: 0, access: access(),
    })).rejects.toThrowError('草稿尚未准备好确认')

    expect(await revisionCount(f, 'w1')).toBe(before)
    expect(await f.db.select().from(sceneCompatibilityRequests)).toHaveLength(0)
  })

  // 尚未实现(TDD 红):confirm 前不重检当前版本/内容,过期草稿会用旧 expectedCurrentVersion 之外的新版本号直接覆盖提交
  it('7. current version conflict: 草稿后场景已推进,confirm 应拒绝且不产生修订', async () => {
    const f = await seedWorld()
    await seedScene(f, 'w1', collisionDocument('veg-flower-a'))
    const draft = await createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w1', draftRequestId: 'draft-1', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
    })
    expect(draft.status).toBe('ready')

    // 另一请求把当前场景推进到 v2
    const advanced = await commitScene(f.db, {
      worldId: 'w1', expectedVersion: 1, requestId: 'other-edit',
      document: validDocument('compat-v2'), summary: '并行编辑', kind: 'edit',
    })
    expect(advanced.version).toBe(2)
    const beforeConfirm = await revisionCount(f, 'w1')

    // 调用方拿着旧草稿,但按最新版本号 confirm;服务应发现草稿依据(expectedCurrentVersion=1)已过期
    const view = await confirmCompatibility(f.db, {
      ...ACTOR, worldId: 'w1', draftId: draft.id, requestId: 'confirm-1',
      expectedCurrentVersion: 2, expectedAttempt: 0, access: access(),
    })
    expect(view.status).toBe('not-committed')
    if (view.status === 'not-committed' && 'error' in view) {
      expect(view.error.code).toBe('scene-changed')
    }
    expect(await revisionCount(f, 'w1')).toBe(beforeConfirm)
    const current = await readCurrentScene(f.db, 'w1')
    expect(current?.version).toBe(2)
    expect(current?.contentHash).toBe(advanced.contentHash)
  })

  // 尚未实现(TDD 红):confirm 完全不使用 access/bindings,绑定上下文变化后仍能直接提交
  it('8. basis conflict: 绑定上下文变化后 confirm 应拒绝且不产生修订', async () => {
    const f = await seedWorld()
    await seedScene(f, 'w1', collisionDocument('veg-flower-a'))
    const draft = await createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w1', draftRequestId: 'draft-1', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
    })
    expect(draft.status).toBe('ready')
    const beforeConfirm = await revisionCount(f, 'w1')

    // 草稿构建后,绑定上下文新增受保护对象 → bindingHash/contextFingerprint 已变化
    const changed = access({
      protectedObjects: [{ spaceId: 'single', objectId: 'keeper', reasons: ['owner-marked'] }],
    })
    const view = await confirmCompatibility(f.db, {
      ...ACTOR, worldId: 'w1', draftId: draft.id, requestId: 'confirm-1',
      expectedCurrentVersion: 1, expectedAttempt: 0, access: changed,
    })
    expect(view.status).toBe('not-committed')
    if (view.status === 'not-committed' && 'error' in view) {
      expect(view.error.code).toBe('basis-changed')
    }
    expect(await revisionCount(f, 'w1')).toBe(beforeConfirm)
    const current = await readCurrentScene(f.db, 'w1')
    expect(current?.version).toBe(1)
  })

  it('9. confirm 幂等: 同 requestId 重发返回同次结果,修订数不变,事后可重建', async () => {
    const f = await seedWorld()
    await seedScene(f, 'w1', collisionDocument('veg-flower-a'))
    const draft = await createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w1', draftRequestId: 'draft-1', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
    })
    expect(draft.status).toBe('ready')

    const confirmInput = {
      ...ACTOR, worldId: 'w1', draftId: draft.id, requestId: 'confirm-1',
      expectedCurrentVersion: 1, expectedAttempt: 0, access: access(),
    }
    const first = await confirmCompatibility(f.db, confirmInput)
    expect(first.status).toBe('completed')
    if (first.status !== 'completed') return
    expect(first.result.version).toBe(2)
    expect(first.result.outcome).toBe('repaired-current')
    expect(first.result.requestId).toBe('confirm-1')
    expect(await revisionCount(f, 'w1')).toBe(2)

    const second = await confirmCompatibility(f.db, confirmInput)
    expect(second.status).toBe('completed')
    if (second.status !== 'completed') return
    expect(second.result.version).toBe(first.result.version)
    expect(second.result.contentHash).toBe(first.result.contentHash)
    expect(await revisionCount(f, 'w1')).toBe(2)

    const reread = await readCompatibilityRequest(f.db, { ...ACTOR, worldId: 'w1', requestId: 'confirm-1' })
    expect(reread.status).toBe('completed')
    if (reread.status !== 'completed') return
    expect(reread.result.version).toBe(first.result.version)
    expect(reread.result.contentHash).toBe(first.result.contentHash)
    expect(reread.result.audit.draftId).toBe(draft.id)
  })
})
