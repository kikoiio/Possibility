import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createEmptyWorld,
  setBlockMut,
  serialize,
  type SceneBindingContext,
  type SerializedVoxelDocument,
  type SerializedVoxelSpaces,
  type SceneWorkControl,
} from '@possibility/voxel-contract'
import { createTestDb } from '../../test/db'
import {
  sceneCompatibilityDrafts,
  sceneCompatibilityRequests,
  sceneValidationPolicy,
  demoBaselines,
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
  readCompatibilityDraft,
  readCompatibilityRequest,
  recoverCompatibilityRequest,
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

function multiSpaceCollisionDocument(): SerializedVoxelSpaces {
  return {
    format: 'voxel-spaces',
    version: 1,
    defaultSpaceId: 'garden',
    spaces: [
      { id: 'garden', name: '花园', document: collisionDocument('veg-flower-a') },
      { id: 'hall', name: '大厅', document: validDocument('untouched-hall') },
    ],
  }
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
    document: SerializedVoxelDocument | SerializedVoxelSpaces,
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

  it('A7.1: 读取故障传播为运行错误，不冒充用户场景损坏', async () => {
    const f = await seedWorld()
    const seeded = await seedScene(f, 'w1', collisionDocument('veg-flower-a'))
    const revisionsBefore = await revisionCount(f, 'w1')
    const invalidContent = await inspectSceneCompatibility(f.db, { worldId: 'w1', access: access(), control: control() })
    expect(invalidContent.status).toBe('ready')
    if (invalidContent.status !== 'ready') return
    expect(invalidContent.report.status).toBe('invalid')
    const unreadable = new Proxy(f.db, {
      get(target, property, receiver) {
        if (property === 'select') return () => { throw new Error('injected scene storage read failure') }
        return Reflect.get(target, property, receiver)
      },
    }) as typeof f.db
    await expect(inspectSceneCompatibility(unreadable, { worldId: 'w1', access: access(), control: control() }))
      .rejects.toThrow('injected scene storage read failure')
    expect(await readCurrentScene(f.db, 'w1')).toEqual(seeded)
    expect(await revisionCount(f, 'w1')).toBe(revisionsBefore)
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

  it('R01 scene limits: 超维度/空间数/UTF-8 JSON 上限均不能通过草稿确认写入', async () => {
    const f = await seedWorld('r01-dimension')
    const worldIds = ['r01-spaces', 'r01-json-bytes']
    await f.db.insert(worlds).values(worldIds.map(id => ({ id, userId: 'u', name: 'R01', description: '' })))

    const tooWide = validDocument('r01-too-wide')
    tooWide.size = { ...tooWide.size, width: 257 }
    const tooManySpaces: SerializedVoxelSpaces = {
      format: 'voxel-spaces', version: 1, defaultSpaceId: 'space-0',
      spaces: Array.from({ length: 9 }, (_, index) => ({
        id: `space-${index}`, name: `空间 ${index}`, document: validDocument(`r01-space-${index}`),
      })),
    }
    const tooManyBytes = { ...validDocument('r01-too-many-bytes'), extension: '界'.repeat(500_001) }
    const cases = [
      { worldId: 'r01-dimension', json: JSON.stringify(tooWide) },
      { worldId: 'r01-spaces', json: JSON.stringify(tooManySpaces) },
      { worldId: 'r01-json-bytes', json: JSON.stringify(tooManyBytes) },
    ]
    expect(new TextEncoder().encode(cases[2]!.json).byteLength).toBeGreaterThan(1_500_000)

    for (const [index, scenario] of cases.entries()) {
      await insertRawScene(f, scenario.worldId, scenario.json)
      const currentBefore = await readCurrentScene(f.db, scenario.worldId)
      const revisionsBefore = await f.db.select().from(worldSceneRevisions)
        .where(eq(worldSceneRevisions.worldId, scenario.worldId)).all()

      const inspected = await inspectSceneCompatibility(f.db, {
        worldId: scenario.worldId, access: access(), control: control(),
      })
      expect(inspected.status, `case ${index} inspection`).toBe('unsupported')
      if (inspected.status === 'ready') continue
      expect(inspected.error.code, `case ${index} error`).toBe('format-unsupported')

      const draft = await createCompatibilityDraft(f.db, {
        ...ACTOR, worldId: scenario.worldId, draftRequestId: `r01-draft-${index}`,
        purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 1,
        access: access(), control: control(),
      })
      expect(draft.status, `case ${index} draft`).toBe('blocked')
      expect(draft.candidate, `case ${index} candidate`).toBeNull()
      expect(toSceneCompatibilityDraftView(draft).canConfirm, `case ${index} canConfirm`).toBe(false)

      await expect(confirmCompatibility(f.db, {
        ...ACTOR, worldId: scenario.worldId, draftId: draft.id, requestId: `r01-confirm-${index}`,
        expectedCurrentVersion: 1, expectedAttempt: 0, access: access(), control: control(),
      })).rejects.toMatchObject({
        code: 'draft-blocked', status: 409, message: '草稿尚未准备好确认',
      })

      expect(await f.db.select().from(sceneCompatibilityRequests)
        .where(eq(sceneCompatibilityRequests.requestId, `r01-confirm-${index}`)).all(), `case ${index} request`).toHaveLength(0)
      expect(await readCurrentScene(f.db, scenario.worldId), `case ${index} current`).toEqual(currentBefore)
      expect(await f.db.select().from(worldSceneRevisions)
        .where(eq(worldSceneRevisions.worldId, scenario.worldId)).all(), `case ${index} revisions`).toEqual(revisionsBefore)
    }
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

  it('A13.4 active rule, asset, or template fingerprints changing after preview rejects confirmation', async () => {
    for (const changedBasis of ['rules', 'assets', 'templates'] as const) {
      const f = await seedWorld(`basis-${changedBasis}`)
      await f.db.insert(sceneValidationPolicy).values({
        id: 'active', rulesVersion: 'rules-v1', assetManifestHash: 'assets-v1',
        templateCatalogHash: 'templates-v1', publishedAt: NOW,
      })
      await seedScene(f, `basis-${changedBasis}`, collisionDocument('veg-flower-a'))
      const draft = await createCompatibilityDraft(f.db, {
        ...ACTOR, worldId: `basis-${changedBasis}`, draftRequestId: 'draft-1', purpose: 'repair-current',
        target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
      })
      expect(draft.status).toBe('ready')

      if (changedBasis === 'rules') {
        await f.db.update(sceneValidationPolicy).set({ rulesVersion: 'rules-v2' }).where(eq(sceneValidationPolicy.id, 'active'))
      } else if (changedBasis === 'assets') {
        await f.db.update(sceneValidationPolicy).set({ assetManifestHash: 'assets-v2' }).where(eq(sceneValidationPolicy.id, 'active'))
      } else {
        await f.db.update(sceneValidationPolicy).set({ templateCatalogHash: 'templates-v2' }).where(eq(sceneValidationPolicy.id, 'active'))
      }

      const beforeConfirm = await revisionCount(f, `basis-${changedBasis}`)
      const result = await confirmCompatibility(f.db, {
        ...ACTOR, worldId: `basis-${changedBasis}`, draftId: draft.id, requestId: 'confirm-1',
        expectedCurrentVersion: 1, expectedAttempt: 0, access: access(), control: control(),
      })
      expect(result.status).toBe('not-committed')
      if (result.status === 'not-committed' && 'error' in result) expect(result.error.code).toBe('basis-changed')
      expect(await revisionCount(f, `basis-${changedBasis}`)).toBe(beforeConfirm)
      expect((await readCurrentScene(f.db, `basis-${changedBasis}`))?.version).toBe(1)
    }
  })

  it('A13.1 repeated repair previews keep identical basis, candidate, and changes', async () => {
    const f = await seedWorld()
    await seedScene(f, 'w1', collisionDocument('veg-flower-a'))
    const create = (draftRequestId: string) => createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w1', draftRequestId, purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
    })
    const first = await create('preview-a')
    const second = await create('preview-b')
    expect(first.status).toBe('ready')
    expect(second.status).toBe('ready')
    expect(second.basis).toEqual(first.basis)
    expect(second.candidate).toEqual(first.candidate)
    expect(second.changes).toEqual(first.changes)
    expect(second.report).toEqual(first.report)
    expect(await revisionCount(f, 'w1')).toBe(1)
  })

  it('B35/R05: 并发检查占用工作槽,忙时创建不写入草稿或请求', async () => {
    const f = await seedWorld()
    await seedScene(f, 'w1', validDocument())
    let entered!: () => void
    let release!: () => void
    const enteredYield = new Promise<void>((resolve) => { entered = resolve })
    const holdYield = new Promise<void>((resolve) => { release = resolve })
    let fakeNow = 0
    const first = inspectSceneCompatibility(f.db, {
      worldId: 'w1', access: access(), budget: { maxWorkUnits: 512, maxWallMs: 60_000 },
      control: { ...control(), nowMs: () => (fakeNow += 10), yieldControl: async () => { entered(); await holdYield } },
    })
    await enteredYield

    await expect(createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w1', draftRequestId: 'busy-draft', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
    })).rejects.toMatchObject({ code: 'service-busy', status: 503 })
    expect(await f.db.select().from(sceneCompatibilityDrafts)).toHaveLength(0)
    expect(await f.db.select().from(sceneCompatibilityRequests)).toHaveLength(0)

    release()
    expect((await first).status).toBe('ready')
    const next = await inspectSceneCompatibility(f.db, { worldId: 'w1', access: access(), control: control() })
    expect(next.status).toBe('ready')
  })

  it('R08: lazy draft read cleans at most ten expired rows in only the requested world', async () => {
    const f = await seedWorld()
    await seedScene(f, 'w1', collisionDocument('veg-flower-a'))
    let expiredCount = 0
    for (let i = 0; i < 11; i += 1) {
      const draft = await createCompatibilityDraft(f.db, {
        ...ACTOR, worldId: 'w1', draftRequestId: `expired-${i}`, purpose: 'repair-current',
        target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
      })
      expiredCount += 1
      await f.db.update(sceneCompatibilityDrafts).set({ updatedAt: '2026-09-01T00:00:00.000Z' })
        .where(eq(sceneCompatibilityDrafts.id, draft.id))
    }
    const fresh = await createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w1', draftRequestId: 'fresh', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
    })
    await f.db.insert(worlds).values({ id: 'w2', userId: 'u', name: 'Other', description: '' })
    const other = await createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w2', draftRequestId: 'other-expired', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 0, access: access(), control: control(),
    })
    await f.db.update(sceneCompatibilityDrafts).set({ updatedAt: '2026-09-01T00:00:00.000Z' })
      .where(eq(sceneCompatibilityDrafts.id, other.id))

    f.queryLog.length = 0
    const read = await readCompatibilityDraft(f.db, { ...ACTOR, worldId: 'w1', draftId: fresh.id })
    const cleanupLog = [...f.queryLog]
    expect(read.id).toBe(fresh.id)
    expect((await f.db.select().from(sceneCompatibilityDrafts).where(eq(sceneCompatibilityDrafts.worldId, 'w1')))).toHaveLength(2)
    expect((await f.db.select().from(sceneCompatibilityDrafts).where(eq(sceneCompatibilityDrafts.worldId, 'w2')))).toHaveLength(1)
    const draftQueries = cleanupLog.filter(entry => /scene_compatibility_drafts/i.test(entry.query))
    expect(draftQueries.length).toBeGreaterThan(0)
    for (const entry of draftQueries) expect(entry.params).not.toContain('w2')
    expect(expiredCount).toBe(11)
  })

  it('B35/R05: 草稿构建异常后释放工作槽', async () => {
    const f = await seedWorld()
    await seedScene(f, 'w1', validDocument())
    await expect(createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w1', draftRequestId: 'unneeded-repair', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
    })).rejects.toMatchObject({ code: 'repair-not-required' })

    expect((await inspectSceneCompatibility(f.db, { worldId: 'w1', access: access(), control: control() })).status).toBe('ready')
  })

  it('B35/R05: 验证取消后释放工作槽', async () => {
    const f = await seedWorld()
    await seedScene(f, 'w1', validDocument())
    const abort = new AbortController()
    let entered!: () => void
    let release!: () => void
    const enteredYield = new Promise<void>((resolve) => { entered = resolve })
    const holdYield = new Promise<void>((resolve) => { release = resolve })
    let fakeNow = 0
    const cancelled = inspectSceneCompatibility(f.db, {
      worldId: 'w1', access: access(), budget: { maxWorkUnits: 512, maxWallMs: 60_000 },
      control: { ...control(), signal: abort.signal, nowMs: () => (fakeNow += 10), yieldControl: async () => { entered(); await holdYield } },
    })
    await enteredYield
    abort.abort()
    release()
    const cancelledResult = await cancelled
    expect(cancelledResult.status).toBe('ready')
    if (cancelledResult.status !== 'ready') return
    expect(cancelledResult.report.status).toBe('incomplete')
    expect(cancelledResult.report.stopReason).toBe('cancelled')
    const next = await inspectSceneCompatibility(f.db, { worldId: 'w1', access: access(), control: control() })
    expect(next.status).toBe('ready')
    if (next.status !== 'ready') return
    expect(next.report.status).toBe('valid')
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

    const reread = await readCompatibilityRequest(f.db, { ...ACTOR, worldId: 'w1', requestId: 'confirm-1', access: access() })
    expect(reread.status).toBe('completed')
    if (reread.status !== 'completed') return
    expect(reread.result.version).toBe(first.result.version)
    expect(reread.result.contentHash).toBe(first.result.contentHash)
    expect(reread.result.audit.draftId).toBe(draft.id)
  })

  it('A7.2: 多空间成功确认后 current、完整历史、审计、请求回执与基线一致', async () => {
    const f = await seedWorld()
    const original = multiSpaceCollisionDocument()
    const seeded = await seedScene(f, 'w1', original)
    await f.db.insert(demoBaselines).values({
      id: 'baseline-a7-success', worldId: 'w1', sceneVersion: seeded.version,
      contentHash: seeded.contentHash, status: 'active', createdAt: NOW, retiredAt: null,
    })
    const draft = await createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w1', draftRequestId: 'a7-success-draft', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
    })
    expect(draft.status).toBe('ready')

    const confirmed = await confirmCompatibility(f.db, {
      ...ACTOR, worldId: 'w1', draftId: draft.id, requestId: 'a7-success-request',
      expectedCurrentVersion: 1, expectedAttempt: 0, access: access(), allowBaseline: true,
    })
    expect(confirmed.status).toBe('completed')
    if (confirmed.status !== 'completed') return

    const current = await readCurrentScene(f.db, 'w1')
    expect(current).not.toBeNull()
    expect(current?.version).toBe(2)
    expect(current?.contentHash).toBe(confirmed.result.contentHash)
    const currentDocument = current?.document as SerializedVoxelSpaces
    expect(currentDocument.spaces.map(space => space.id)).toEqual(['garden', 'hall'])
    expect(currentDocument.spaces.find(space => space.id === 'garden')?.document.assetPlacements?.[0]?.anchor)
      .not.toEqual(original.spaces[0]!.document.assetPlacements?.[0]?.anchor)
    expect(currentDocument.spaces.find(space => space.id === 'hall')?.document)
      .toEqual(original.spaces[1]!.document)

    const history = await f.db.select().from(worldSceneRevisions)
      .where(eq(worldSceneRevisions.worldId, 'w1')).orderBy(worldSceneRevisions.version).all()
    expect(history).toHaveLength(2)
    expect(history.map(row => ({ version: row.version, parentVersion: row.parentVersion })))
      .toEqual([{ version: 1, parentVersion: null }, { version: 2, parentVersion: 1 }])
    expect(JSON.parse(history[0]!.documentJson)).toEqual(original)
    expect(JSON.parse(history[1]!.documentJson)).toEqual(currentDocument)
    expect(history[1]!.contentHash).toBe(current?.contentHash)

    const audit = JSON.parse(history[1]!.compatibilityJson ?? 'null') as {
      purpose: string; source: { worldId: string; version: number }; basis: unknown
      changes: unknown[]; draftId: string; requestId: string
    }
    expect(audit).toMatchObject({
      purpose: 'repair-current', source: { worldId: 'w1', version: 1 },
      basis: draft.basis, changes: draft.changes, draftId: draft.id, requestId: 'a7-success-request',
    })
    const proof = JSON.parse(history[1]!.validationJson ?? 'null') as {
      mode: string; source: { worldId: string; version: number; contentHash: string }
      candidate: { version: number; contentHash: string }
      baseline: { id: string; status: string; sceneVersion: number; contentHash: string }
      request: { draftId: string; requestId: string; attempt: number }
    }
    expect(proof).toMatchObject({
      mode: 'valid', source: { worldId: 'w1', version: 1, contentHash: seeded.contentHash },
      candidate: { version: 2, contentHash: confirmed.result.contentHash },
      baseline: { id: 'baseline-a7-success', status: 'active', sceneVersion: 1, contentHash: seeded.contentHash },
      request: { draftId: draft.id, requestId: 'a7-success-request', attempt: 0 },
    })

    const receipt = await f.db.select().from(sceneCompatibilityRequests)
      .where(eq(sceneCompatibilityRequests.requestId, 'a7-success-request')).get()
    expect(receipt).toMatchObject({ state: 'completed', attempt: 0, resultVersion: 2, leaseToken: null, leaseUntil: null })
    const recovered = await readCompatibilityRequest(f.db, {
      ...ACTOR, worldId: 'w1', requestId: 'a7-success-request', access: access(),
    })
    expect(recovered.status).toBe('completed')
    if (recovered.status === 'completed') {
      expect(recovered.result.version).toBe(2)
      expect(recovered.result.contentHash).toBe(history[1]!.contentHash)
      expect(recovered.result.audit).toEqual(audit)
    }
    expect(await f.db.select().from(demoBaselines).where(eq(demoBaselines.id, 'baseline-a7-success')).get())
      .toMatchObject({ sceneVersion: 1, contentHash: seeded.contentHash, status: 'active' })
  })

  it('A7.2: 成功请求记录更新失败时场景修订和当前指针一起回滚', async () => {
    const f = await seedWorld()
    const seeded = await seedScene(f, 'w1', collisionDocument('veg-flower-a'))
    const draft = await createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w1', draftRequestId: 'atomic-failure-draft', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
    })
    expect(draft.status).toBe('ready')
    const revisionsBefore = await revisionCount(f, 'w1')
    f.sqlite.exec(`CREATE TRIGGER fail_compat_completion BEFORE UPDATE OF state ON scene_compatibility_requests
      WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'injected request completion failure'); END`)

    const result = await confirmCompatibility(f.db, {
      ...ACTOR, worldId: 'w1', draftId: draft.id, requestId: 'atomic-failure-request',
      expectedCurrentVersion: 1, expectedAttempt: 0, access: access(),
    })

    expect(result.status).toBe('not-committed')
    if (result.status !== 'not-committed' || result.retryAllowed) return
    expect(result.error.code).toBe('storage-failure')
    expect((await readCurrentScene(f.db, 'w1'))).toEqual(seeded)
    expect(await revisionCount(f, 'w1')).toBe(revisionsBefore)
    const request = await f.db.select().from(sceneCompatibilityRequests)
      .where(eq(sceneCompatibilityRequests.requestId, 'atomic-failure-request')).get()
    expect(request).toMatchObject({ state: 'not-committed', resultVersion: null })
  })

  it('A7.1: 草稿构建发布故障显示为运行错误且不写入场景历史', async () => {
    const f = await seedWorld()
    const seeded = await seedScene(f, 'w1', collisionDocument('veg-flower-a'))
    const revisionsBefore = await revisionCount(f, 'w1')
    f.sqlite.exec(`CREATE TRIGGER fail_draft_publish BEFORE UPDATE OF status ON scene_compatibility_drafts
      WHEN NEW.status = 'ready' BEGIN SELECT RAISE(ABORT, 'injected draft publish failure'); END`)

    await expect(createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w1', draftRequestId: 'draft-publish-fault', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
    })).rejects.toThrow(/Failed query:/)
    expect(await readCurrentScene(f.db, 'w1')).toEqual(seeded)
    expect(await revisionCount(f, 'w1')).toBe(revisionsBefore)
  })

  it.each(['revision insert', 'current pointer update', 'final commit guard'] as const)(
    'A7.2: %s 失败时修订、current 与请求回执整批回滚', async stage => {
      const f = await seedWorld()
      const seeded = await seedScene(f, 'w1', collisionDocument('veg-flower-a'))
      const draft = await createCompatibilityDraft(f.db, {
        ...ACTOR, worldId: 'w1', draftRequestId: `atomic-${stage.replaceAll(' ', '-')}`, purpose: 'repair-current',
        target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
      })
      if (draft.status !== 'ready') throw new Error('fixture draft should be ready')
      const revisionsBefore = await revisionCount(f, 'w1')
      const trigger = stage === 'revision insert'
        ? `CREATE TRIGGER injected_stage_failure BEFORE INSERT ON world_scene_revisions WHEN NEW.request_id = 'atomic-${stage.replaceAll(' ', '-')}-request' BEGIN SELECT RAISE(ABORT, 'injected revision insert failure'); END`
        : stage === 'current pointer update'
          ? `CREATE TRIGGER injected_stage_failure BEFORE UPDATE OF current_version ON world_scenes WHEN NEW.current_version = 2 BEGIN SELECT RAISE(ABORT, 'injected current pointer failure'); END`
          : `CREATE TRIGGER injected_stage_failure BEFORE UPDATE OF commit_guard ON world_scene_revisions WHEN NEW.request_id = 'atomic-${stage.replaceAll(' ', '-')}-request' BEGIN SELECT RAISE(ABORT, 'injected final guard failure'); END`
      f.sqlite.exec(trigger)

      const result = await confirmCompatibility(f.db, {
        ...ACTOR, worldId: 'w1', draftId: draft.id, requestId: `atomic-${stage.replaceAll(' ', '-')}-request`,
        expectedCurrentVersion: 1, expectedAttempt: 0, access: access(),
      })

      expect(result.status).toBe('not-committed')
      if (result.status !== 'not-committed' || result.retryAllowed) return
      expect(result.error.code).toBe('storage-failure')
      expect(await readCurrentScene(f.db, 'w1')).toEqual(seeded)
      expect(await revisionCount(f, 'w1')).toBe(revisionsBefore)
      const request = await f.db.select().from(sceneCompatibilityRequests)
        .where(eq(sceneCompatibilityRequests.requestId, `atomic-${stage.replaceAll(' ', '-')}-request`)).get()
      expect(request).toMatchObject({ state: 'not-committed', resultVersion: null })
    },
  )

  it('A7.2: 演示基线在最终提交 guard 前变化时整批回滚', async () => {
    const f = await seedWorld()
    const seeded = await seedScene(f, 'w1', collisionDocument('veg-flower-a'))
    await f.db.insert(demoBaselines).values({
      id: 'baseline-1', worldId: 'w1', sceneVersion: 1, contentHash: seeded.contentHash,
      status: 'active', createdAt: NOW, retiredAt: null,
    })
    const draft = await createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w1', draftRequestId: 'baseline-drift-draft', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
    })
    if (draft.status !== 'ready') throw new Error('fixture draft should be ready')
    const revisionsBefore = await revisionCount(f, 'w1')
    let drifted = false
    const racingDb = new Proxy(f.db, {
      get(target, property, receiver) {
        if (property === 'batch') return async (statements: Parameters<typeof f.db.batch>[0]) => {
          if (!drifted) {
            drifted = true
            await f.db.update(demoBaselines).set({ contentHash: 'changed-before-final-guard' })
              .where(eq(demoBaselines.id, 'baseline-1'))
          }
          const batch = Reflect.get(target, property, target) as typeof f.db.batch
          return batch.call(target, statements)
        }
        return Reflect.get(target, property, receiver)
      },
    }) as typeof f.db

    const result = await confirmCompatibility(racingDb, {
      ...ACTOR, worldId: 'w1', draftId: draft.id, requestId: 'baseline-drift-request',
      expectedCurrentVersion: 1, expectedAttempt: 0, access: access(), allowBaseline: true,
    })

    expect(result.status).toBe('not-committed')
    if (result.status !== 'not-committed' || result.retryAllowed) return
    expect(result.error.code).toBe('storage-failure')
    expect(await readCurrentScene(f.db, 'w1')).toEqual(seeded)
    expect(await revisionCount(f, 'w1')).toBe(revisionsBefore)
    expect(await f.db.select().from(demoBaselines).where(eq(demoBaselines.id, 'baseline-1')).get())
      .toMatchObject({ contentHash: 'changed-before-final-guard' })
    expect(await f.db.select().from(sceneCompatibilityRequests)
      .where(eq(sceneCompatibilityRequests.requestId, 'baseline-drift-request')).get())
      .toMatchObject({ state: 'not-committed', resultVersion: null })
  })

  it.each(['scene version', 'active rule policy'] as const)(
    'A8.6: %s 在预览后变化时 query/recover 都不授予旧草稿重试', async changedBasis => {
      const f = await seedWorld()
      await seedScene(f, 'w1', collisionDocument('veg-flower-a'))
      const draft = await createCompatibilityDraft(f.db, {
        ...ACTOR, worldId: 'w1', draftRequestId: `stale-${changedBasis.replaceAll(' ', '-')}-draft`, purpose: 'repair-current',
        target: { kind: 'current' }, expectedCurrentVersion: 1, access: access(), control: control(),
      })
      if (draft.status !== 'ready') throw new Error('fixture draft should be ready')
      const requestId = `stale-${changedBasis.replaceAll(' ', '-')}-request`
      const initialRecovery = await recoverCompatibilityRequest(f.db, {
        ...ACTOR, worldId: 'w1', draftId: draft.id, requestId,
        expectedCurrentVersion: 1, expectedAttempt: 0, access: access(),
      })
      expect(initialRecovery).toMatchObject({ status: 'not-committed', attempt: 0, nextAttempt: 1, retryAllowed: true })

      if (changedBasis === 'scene version') {
        await commitScene(f.db, {
          worldId: 'w1', expectedVersion: 1, requestId: 'unrelated-version-update',
          document: validDocument('updated-current'), summary: 'concurrent edit', kind: 'edit',
        })
      } else {
        await f.db.insert(sceneValidationPolicy).values({
          id: 'active', rulesVersion: 'rules-after-preview', assetManifestHash: 'asset-hash',
          templateCatalogHash: 'template-hash', publishedAt: new Date().toISOString(),
        })
      }
      const revisionsBeforeRecovery = await revisionCount(f, 'w1')
      const input = {
        ...ACTOR, worldId: 'w1', requestId,
        draftId: draft.id, expectedCurrentVersion: 1, expectedAttempt: 1, access: access(),
      }

      const queried = await readCompatibilityRequest(f.db, { ...input, access: access() })
      const recovered = await recoverCompatibilityRequest(f.db, input)

      for (const view of [queried, recovered]) {
        expect(view.status).toBe('not-committed')
        if (view.status !== 'not-committed' || view.retryAllowed) continue
        expect(view.error.code).toBe(changedBasis === 'scene version' ? 'scene-changed' : 'basis-changed')
      }
      expect(queried.status === 'not-committed' && queried.retryAllowed).toBe(false)
      expect(recovered.status === 'not-committed' && recovered.retryAllowed).toBe(false)
      expect(await revisionCount(f, 'w1')).toBe(revisionsBeforeRecovery)
      expect(await f.db.select().from(sceneCompatibilityRequests)
        .where(eq(sceneCompatibilityRequests.requestId, input.requestId)).get())
        .toMatchObject({ state: 'not-committed', attempt: 0 })
    },
  )
})
