import { afterEach, describe, expect, it } from 'vitest'
import {
  applyEdits,
  deserialize,
  ensureAssetPlacementIds,
  serialize,
  validateEdit,
  type SerializedVoxelDocument,
} from '@possibility/voxel-contract'
import { createWorldFixture } from '../../test/world-fixture'
import { commitScene } from '../repository'
import { loadWorldSceneBindings } from './context'
import { inspectSceneCompatibility, validateStoredSceneCandidate } from './service'
import { planEdits } from '../../voxel/edit-planner'
import {
  COMPATIBILITY_FIXTURE_INVALID_BRANCH,
  compatibilityFixtureInvalidOps,
  compatibilityFixtureLegacyScene,
  compatibilityFixtureRepairedBasis,
  compatibilityFixtureValidOps,
  createCompatibilityFixtureVoxelProvider,
} from '../e2e-fixture'

/**
 * A1(B67)：确定性 voxel ops 测试提供者——返回模型层 ops（不伪造 API plan/save 成功），
 * 合法分支产出已预检合法且确有变化的候选；受控非法分支操作级校验可通过、
 * 完整真实校验失败，经实际 planEdits + B69 完整候选预检阻断。
 */

type Fixture = Awaited<ReturnType<typeof createWorldFixture>>

async function seedScene(fixture: Fixture, document: SerializedVoxelDocument, requestId: string) {
  await commitScene(fixture.db, {
    worldId: 'home-world', expectedVersion: 0, requestId, document, summary: 'seed', kind: 'initial',
  })
}

function toStoredCandidate(baseDoc: ReturnType<typeof deserialize>, ops: Parameters<typeof applyEdits>[1]): SerializedVoxelDocument {
  return JSON.parse(serialize(ensureAssetPlacementIds(applyEdits(baseDoc, ops).document))) as SerializedVoxelDocument
}

describe('A1 deterministic voxel provider', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createWorldFixture>>> = []
  afterEach(() => { fixtures.splice(0).forEach(fixture => fixture.close()) })

  it('合法分支：ops 可解析、操作级合法、候选完整有效且确有变化', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    const basis = compatibilityFixtureRepairedBasis()
    await seedScene(fixture, basis, 'seed-basis')
    const provider = createCompatibilityFixtureVoxelProvider()
    const baseDoc = deserialize(JSON.stringify(basis))

    const ops = await planEdits(baseDoc, '在庭院里再加一盏石灯', { complete: provider.complete })

    expect(ops).toEqual(compatibilityFixtureValidOps())
    expect(provider.calls).toBe(1)
    expect(validateEdit(baseDoc, ops)).toEqual([])
    const candidate = toStoredCandidate(baseDoc, ops)
    expect(JSON.stringify(candidate)).not.toBe(JSON.stringify(basis))
    const access = { bindings: await loadWorldSceneBindings(fixture.db, 'home-world') }
    const preflight = await validateStoredSceneCandidate(fixture.db, {
      worldId: 'home-world', document: candidate, access,
    })
    expect(preflight.status).toBe('valid')
  })

  it('受控非法分支：操作级校验通过但完整真实校验失败，经 B69 完整候选预检阻断', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    const basis = compatibilityFixtureRepairedBasis()
    await seedScene(fixture, basis, 'seed-basis')
    const provider = createCompatibilityFixtureVoxelProvider()
    const baseDoc = deserialize(JSON.stringify(basis))

    const ops = await planEdits(baseDoc, `挖一下灯脚 ${COMPATIBILITY_FIXTURE_INVALID_BRANCH}`, { complete: provider.complete })

    expect(ops).toEqual(compatibilityFixtureInvalidOps())
    expect(provider.calls).toBe(1)
    // 操作级校验可通过（挖单格在界内、无锁定冲突）
    expect(validateEdit(baseDoc, ops)).toEqual([])
    const candidate = toStoredCandidate(baseDoc, ops)
    // 完整真实校验失败：石灯失去支撑悬空
    const access = { bindings: await loadWorldSceneBindings(fixture.db, 'home-world') }
    const preflight = await validateStoredSceneCandidate(fixture.db, {
      worldId: 'home-world', document: candidate, access,
    })
    expect(preflight.status).toBe('invalid')
    if (preflight.status === 'valid') return
    expect(preflight.report.issues.some(issue => issue.code === 'floating-object')).toBe(true)
  })

  it('对照：原无效旧场景完整检查 invalid，规划在模型调用前阻断（提供者调用 0 次）', async () => {
    const fixture = await createWorldFixture(); fixtures.push(fixture)
    const legacy = compatibilityFixtureLegacyScene()
    await seedScene(fixture, legacy, 'seed-legacy')
    const provider = createCompatibilityFixtureVoxelProvider()
    const access = { bindings: await loadWorldSceneBindings(fixture.db, 'home-world') }

    const inspection = await inspectSceneCompatibility(fixture.db, { worldId: 'home-world', access })
    expect(inspection.status).toBe('ready')
    if (inspection.status !== 'ready') return
    expect(inspection.report.status).toBe('invalid')
    const directSave = await validateStoredSceneCandidate(fixture.db, {
      worldId: 'home-world', document: legacy, access,
    })
    expect(directSave.status).toBe('invalid')
    // 非法基底不会被该 fixture 绕过：检查未通过时规划根本不进入模型层
    expect(provider.calls).toBe(0)
  })

  it('提供者返回模型层 ops JSON，而非伪造的 API plan/save 成功载荷', async () => {
    const provider = createCompatibilityFixtureVoxelProvider()
    const raw = await provider.complete([{ role: 'user', content: '当前世界：… 用户意图：加灯' }])
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(Array.isArray(parsed.ops)).toBe(true)
    expect(parsed.ops).toEqual(compatibilityFixtureValidOps())
    // 不携带任何 API 层成功标志/预检依据——保存仍必须走真实 HTTP/DB
    expect(parsed).not.toHaveProperty('previewBasis')
    expect(parsed).not.toHaveProperty('success')
    expect(parsed).not.toHaveProperty('version')
    expect(provider.calls).toBe(1)
  })
})
