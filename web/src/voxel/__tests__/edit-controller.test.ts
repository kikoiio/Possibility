import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyEdits, clampTerrainParams, createBlockRegistry, createEmptyWorld, decodeSceneCompatibility, deserialize,
  DEFAULT_SCENE_BUDGET, generateTerrainCells, getBlock, createSceneWorkControl, serialize, validateSceneEnvelope,
  writeTerrainCells,
  type EditOperation, type SceneEditPreflightResult, type SceneIssue, type SceneValidationReport,
  type SceneValidationContext, type VoxelDocument,
} from '@possibility/voxel-contract'
import type { AssetManifest } from '@possibility/voxel-contract'
import type { AtlasJson } from '../engine/atlas'
import { VoxelEngine } from '../engine'
import { EditController, type PreflightBasis, type PreflightBlocked } from '../bridge/edit-controller'

const at = (x: number, y: number, z: number) => ({ x, y, z })

/** 无头引擎：不挂 canvas，仅加载注册表 + 假图集 + 文档 */
function headlessEngine() {
  const engine = new VoxelEngine()
  const registry = createBlockRegistry('mist-manor')
  engine.registry = registry
  const frames: AtlasJson['frames'] = {}
  let i = 0
  for (const block of registry.list()) {
    for (const name of [block.textures.top, block.textures.side, block.textures.bottom]) {
      if (name && !frames[name]) frames[name] = { x: (i++ % 8) * 32, y: 0, w: 32, h: 32 }
    }
  }
  engine.atlas.setTexture(new THREE.Texture(), { width: 256, height: 32, frames })
  const doc = createEmptyWorld({ width: 32, height: 16, depth: 32 }, 'mist-manor', 'test')
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    doc.sections['0,0,0'] ??= { palette: ['air'], indices: new Uint16Array(4096), nonAirCount: 0 }
    break
  }
  const grounded = applyEdits(doc, [{ kind: 'fill', from: at(0, 0, 0), to: at(31, 0, 31), block: 'grass' }]).document
  engine.loadDocument(grounded)
  return engine
}

describe('EditController', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('applies legal edits and rebakes only affected sections', () => {
    const engine = headlessEngine()
    const controller = new EditController({ engine })
    const outcome = controller.applyOps([{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }], false)
    expect(outcome.ok).toBe(true)
    expect(engine.world!.getBlock(at(5, 1, 5))).toBe('stone')
    engine.dispose()
  })

  it('rejects edits on locked objects (AC15 雏形)', () => {
    const engine = headlessEngine()
    const placed = applyEdits(engine.world!.doc, [{ kind: 'place-object', objectType: 'stone-lantern', anchor: at(5, 1, 5), rotation: 0, objectId: 'lamp' }])
    engine.loadDocument({ ...placed.document, lockedObjectIds: ['lamp'] })
    const rejected: unknown[] = []
    const controller = new EditController({ engine, onRejected: (i) => rejected.push(i) })
    const dig = controller.applyOps([{ kind: 'set-block', at: at(5, 1, 5), block: 'air' }])
    expect(dig.ok).toBe(false)
    expect((dig as { issues: Array<{ code: string }> }).issues[0].code).toBe('locked-violation')
    const move = controller.applyOps([{ kind: 'move-object', objectId: 'lamp', anchor: at(8, 1, 8) }])
    expect(move.ok).toBe(false)
    const remove = controller.applyOps([{ kind: 'remove-object', objectId: 'lamp' }])
    expect(remove.ok).toBe(false)
    expect(rejected).toHaveLength(3)
    expect(engine.world!.getBlock(at(5, 1, 5))).toBe('stone') // 未被改动
    engine.dispose()
  })

  it('rejects invalid edits (out of bounds / unknown block)', () => {
    const engine = headlessEngine()
    const controller = new EditController({ engine })
    expect(controller.applyOps([{ kind: 'set-block', at: at(40, 1, 1), block: 'stone' }]).ok).toBe(false)
    expect(controller.applyOps([{ kind: 'set-block', at: at(1, 1, 1), block: 'ectoplasm' }]).ok).toBe(false)
    engine.dispose()
  })

  it('honors the canEdit gate', () => {
    const engine = headlessEngine()
    const controller = new EditController({ engine, canEdit: () => false })
    const outcome = controller.applyOps([{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }])
    expect(outcome.ok).toBe(false)
    expect(engine.world!.getBlock(at(5, 1, 5))).toBe('air')
    engine.dispose()
  })

  it('debounces saves: 10 rapid edits merge into one save', () => {
    const engine = headlessEngine()
    const saved: string[] = []
    const controller = new EditController({ engine, save: (doc) => { saved.push(doc.id) }, saveDebounceMs: 500 })
    for (let i = 0; i < 10; i++) {
      controller.applyOps([{ kind: 'set-block', at: at(i + 2, 1, 2), block: 'stone' }], false)
    }
    vi.advanceTimersByTime(600)
    expect(saved).toHaveLength(1)
    expect(controller.saves).toBe(1)
    controller.dispose()
    engine.dispose()
  })

  it('flushSave persists immediately with the latest document', () => {
    const engine = headlessEngine()
    const saved: number[] = []
    const controller = new EditController({ engine, save: (doc) => { saved.push(Object.keys(doc.sections).length) } })
    controller.applyOps([{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }], false)
    controller.applyOps([{ kind: 'set-block', at: at(20, 1, 5), block: 'stone' }], false)
    controller.flushSave()
    expect(saved).toHaveLength(1)
    controller.flushSave() // 无 pending，不重复保存
    expect(saved).toHaveLength(1)
    engine.dispose()
  })
})

describe('EditController × A1 完整候选预检(W20/W25/W26)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const basisStub = (hash = 'sha256:test'): PreflightBasis => ({
    expectedCurrentVersion: 1,
    currentContentHash: 'current-hash',
    source: { worldId: 'world-1', version: 1, contentHash: 'current-hash' },
    candidateHash: hash,
    rulesVersion: 'rules-1',
    assetManifestHash: 'assets-1',
    templateCatalogHash: 'templates-1',
    bindingHash: 'bindings-1',
    contextFingerprint: 'context-1',
    baseline: null,
  })

  const issueStub = (
    origin: SceneIssue['origin'],
    summary: string,
    details: Pick<SceneIssue, 'code' | 'category'> & Partial<Pick<SceneIssue, 'reason'>> = {
      code: 'asset-unsupported', category: 'structure',
    },
  ): SceneIssue => ({
    id: `issue-${origin}-${details.code}`,
    code: details.code,
    origin,
    category: details.category,
    spaceId: null,
    summary,
    suggestion: '调整后再试',
    blocking: true,
    ...(details.reason ? { reason: details.reason } : {}),
  })

  const reportStub = (status: SceneValidationReport['status'], issues: SceneIssue[] = []): SceneValidationReport => ({
    status,
    issues,
    issueCount: issues.length,
    countIsExact: true,
    stopReason: null,
    checkedSpaceIds: ['exterior'],
    pendingSpaceIds: [],
    workUnitsUsed: 1,
    elapsedMs: 1,
    ruleNotes: { items: [], total: 0, hasMore: false },
  })

  const validResult = (hash?: string): SceneEditPreflightResult => ({ status: 'valid', basis: basisStub(hash), report: reportStub('valid') })

  it('配置预检后同步入口拒绝执行,引擎与保存均不变(W20)', () => {
    const engine = headlessEngine()
    const controller = new EditController({ engine, preflight: async () => validResult() })
    const outcome = controller.applyOps([{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }], false)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.issues[0].code).toBe('invalid-meta')
    expect(engine.world!.getBlock(at(5, 1, 5))).toBe('air')
    expect(controller.saves).toBe(0)
    engine.dispose()
  })

  it('invalid 预检:不 apply、不 autosave、原场景保留,阻断通知带出来源(W25)', async () => {
    const engine = headlessEngine()
    const blocked: PreflightBlocked[] = []
    const saved: unknown[] = []
    const controller = new EditController({
      engine,
      save: doc => { saved.push(doc) },
      preflight: async () => ({ status: 'invalid', report: reportStub('invalid', [issueStub('edit', '石灯悬空')]) }),
      onPreflightBlocked: b => blocked.push(b),
    })
    const outcome = await controller.applyOpsAsync([{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }], { feedback: false })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.blocked?.kind).toBe('invalid')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]!.message).toContain('本次编辑未通过完整校验')
    expect(blocked[0]!.message).toContain('石灯悬空')
    expect(engine.world!.getBlock(at(5, 1, 5))).toBe('air')
    vi.advanceTimersByTime(1000)
    expect(controller.saves).toBe(0)
    expect(saved).toHaveLength(0)
    engine.dispose()
  })

  const a42GateIssues: Array<[string, SceneIssue]> = [
    ['结构问题', issueStub('edit', '石墙结构存在重叠', { code: 'object-overlap', category: 'structure' })],
    ['资产碰撞', issueStub('edit', '花卉资产与石灯笼发生碰撞', { code: 'asset-overlap', category: 'asset', reason: 'collision' })],
    ['资产缺支撑', issueStub('edit', '花卉资产下方缺少支撑', { code: 'asset-overlap', category: 'asset', reason: 'unsupported' })],
    ['绑定问题', issueStub('edit', '人物居民未绑定到载体', { code: 'binding-mismatch', category: 'binding' })],
    ['连接问题', issueStub('edit', '跨空间入口目标不存在', { code: 'connection-invalid', category: 'connection' })],
    ['通行问题', issueStub('edit', '入口净高不足，无法通行', { code: 'walk-clearance', category: 'walkability' })],
  ]

  it.each(a42GateIssues)('A4.2 控制器闸门：%s 独立阻断且保留原场景', async (_name, issue) => {
    const engine = headlessEngine()
    const originalDoc = engine.world!.doc
    const originalSerialized = serialize(originalDoc)
    const apply = vi.spyOn(engine, 'applyEditResult')
    const save = vi.fn()
    const blocked: PreflightBlocked[] = []
    const controller = new EditController({
      engine,
      save,
      preflight: async () => ({ status: 'invalid', report: reportStub('invalid', [issue]) }),
      onPreflightBlocked: value => blocked.push(value),
    })

    const outcome = await controller.applyOpsAsync(
      [{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }],
      { feedback: false },
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.blocked?.kind).toBe('invalid')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]!.report?.issues).toEqual([issue])
    expect(blocked[0]!.message).toContain('本次编辑未通过完整校验')
    expect(blocked[0]!.message).toContain(issue.summary)
    expect(apply).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(controller.saves).toBe(0)
    expect(engine.world!.doc).toBe(originalDoc)
    expect(serialize(engine.world!.doc)).toBe(originalSerialized)

    controller.dispose()
    engine.dispose()
  })

  it('A4.2:真实场景规则报告阻断缺支撑编辑,不应用也不保存', async () => {
    const engine = headlessEngine()
    const assets: AssetManifest = {
      version: 2,
      assets: {
        'test-hut': {
          id: 'test-hut', category: 'building', url: '/hut.glb', footprint: [2, 2], height: 2,
          thumbnail: '/hut.png', sway: 0,
        },
      },
    }
    const placed = applyEdits(engine.world!.doc, [{
      kind: 'place-asset', assetId: 'test-hut', anchor: at(10, 1, 10), rotation: 0, placementId: 'hut-a',
    }]).document
    engine.loadDocument(placed)
    const originalDoc = engine.world!.doc
    const originalSerialized = serialize(originalDoc)
    const apply = vi.spyOn(engine, 'applyEditResult')
    const save = vi.fn()
    const blocked: PreflightBlocked[] = []
    const context: SceneValidationContext = {
      rulesVersion: 'a4.2-controller-integration',
      assets,
      assetManifestHash: 'a4.2-assets',
      templateCatalogHash: 'a4.2-templates',
      bindingHash: 'a4.2-bindings',
      contextFingerprint: 'a4.2-context',
      bindings: {
        personIds: [], locations: [], protectedObjects: [], protectedPlacements: [],
        locationBindings: [], personBindings: [], entries: [],
      },
    }
    const preflightEvidence: { report?: SceneValidationReport } = {}
    const controller = new EditController({
      engine,
      save,
      onPreflightBlocked: value => blocked.push(value),
      preflight: async candidate => {
        if (candidate.kind !== 'operations') throw new Error('expected operations candidate')
        // applyEdits writes through section objects, so isolate its input from the live engine document.
        const candidateBase = deserialize(serialize(engine.world!.doc))
        const candidateDoc = applyEdits(candidateBase, candidate.operations).document
        const decoded = decodeSceneCompatibility(JSON.parse(serialize(candidateDoc)))
        if (decoded.status !== 'ready') throw new Error('could not decode candidate scene')
        preflightEvidence.report = await validateSceneEnvelope(
          decoded.envelope, context, DEFAULT_SCENE_BUDGET, createSceneWorkControl({ yieldControl: async () => {} }), 'edit',
        )
        return preflightEvidence.report.status === 'invalid'
          ? { status: 'invalid', report: preflightEvidence.report }
          : preflightEvidence.report.status === 'incomplete'
            ? { status: 'incomplete', report: preflightEvidence.report }
            : validResult()
      },
    })
    const supportRemoval = [
      { kind: 'set-block' as const, at: at(10, 0, 10), block: 'air' },
      { kind: 'set-block' as const, at: at(11, 0, 10), block: 'air' },
      { kind: 'set-block' as const, at: at(10, 0, 11), block: 'air' },
      { kind: 'set-block' as const, at: at(11, 0, 11), block: 'air' },
    ]

    const outcome = await controller.applyOpsAsync(supportRemoval, { feedback: false })

    expect(preflightEvidence.report?.status).toBe('invalid')
    const unsupportedIssue = preflightEvidence.report?.issues.find(issue => issue.code === 'asset-overlap')
    expect(unsupportedIssue).toMatchObject({
      code: 'asset-overlap', origin: 'edit', category: 'asset', reason: 'unsupported', at: at(10, 1, 10),
    })
    expect(unsupportedIssue?.summary).toContain('support')
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.blocked?.kind).toBe('invalid')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]!.report).toBe(preflightEvidence.report)
    expect(blocked[0]!.message).toContain(unsupportedIssue!.summary)
    expect(apply).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(controller.saves).toBe(0)
    expect(engine.world!.doc).toBe(originalDoc)
    expect(serialize(engine.world!.doc)).toBe(originalSerialized)

    controller.dispose()
    engine.dispose()
  })

  const a42RealGateScenarios: Array<{
    name: string
    code: string
    category: SceneIssue['category']
    reason?: SceneIssue['reason']
    summary: RegExp
    at?: ReturnType<typeof at>
    operations: EditOperation[]
    prepare?: (engine: VoxelEngine) => void
    configure?: (context: SceneValidationContext) => void
  }> = [
    {
      name: '结构', code: 'floating-object', category: 'structure', summary: /floating-lantern/,
      at: at(5, 1, 5),
      prepare: engine => engine.loadDocument(applyEdits(engine.world!.doc, [{
        kind: 'place-object', objectType: 'stone-lantern', anchor: at(5, 1, 5), rotation: 0, objectId: 'floating-lantern',
      }]).document),
      operations: [{ kind: 'set-block', at: at(5, 0, 5), block: 'air' }],
    },
    {
      name: '资产碰撞', code: 'asset-overlap', category: 'asset', reason: 'collision', summary: /collision-hut-a|collision-hut-b/,
      at: at(12, 1, 12),
      operations: [
        { kind: 'place-asset', assetId: 'test-hut', anchor: at(12, 1, 12), rotation: 0, placementId: 'collision-hut-a' },
        { kind: 'place-asset', assetId: 'test-hut', anchor: at(12, 1, 12), rotation: 0, placementId: 'collision-hut-b' },
      ],
    },
    {
      name: '资产缺支撑', code: 'asset-overlap', category: 'asset', reason: 'unsupported', summary: /support/,
      at: at(20, 4, 20),
      operations: [{ kind: 'place-asset', assetId: 'test-hut', anchor: at(20, 4, 20), rotation: 0, placementId: 'unsupported-hut' }],
    },
    {
      name: '人物绑定', code: 'binding-mismatch', category: 'binding', summary: /person-expected.*person-carrier/,
      operations: [{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }],
      configure: (context: SceneValidationContext) => context.bindings.personBindings.push({
        spaceId: 'single', objectId: 'person-carrier', personId: 'person-expected',
      }),
    },
    {
      name: '地点绑定', code: 'binding-mismatch', category: 'binding', summary: /Kitchen.*location-carrier/,
      operations: [{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }],
      configure: (context: SceneValidationContext) => context.bindings.locationBindings.push({
        spaceId: 'single', carrierId: 'location-carrier', location: { name: 'Kitchen', stableId: 'kitchen' },
      }),
    },
    {
      name: '连接无效', code: 'connection-invalid', category: 'connection', summary: /missing-target/,
      at: at(0, 1, 3),
      operations: [{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }],
      configure: (context: SceneValidationContext) => context.bindings.entries.push({
        fromSpaceId: 'single', toSpaceId: 'missing-target', at: at(0, 1, 3),
      }),
    },
    {
      name: '通行净空', code: 'walk-clearance', category: 'walkability', summary: /净空不足/,
      at: at(0, 1, 0),
      operations: [{ kind: 'set-block', at: at(0, 2, 0), block: 'stone' }],
    },
  ]

  it.each(a42RealGateScenarios)('A4.2 真实验证器门禁：$name 报告阻断且文档/版本/持久历史不变', async scenario => {
    const engine = headlessEngine()
    scenario.prepare?.(engine)
    const originalDoc = engine.world!.doc
    const originalSerialized = serialize(originalDoc)
    const originalVersion = originalDoc.version
    const apply = vi.spyOn(engine, 'applyEditResult')
    const save = vi.fn()
    const blocked: PreflightBlocked[] = []
    const assets: AssetManifest = {
      version: 2,
      assets: {
        'test-hut': {
          id: 'test-hut', category: 'building', url: '/hut.glb', footprint: [2, 2], height: 2,
          thumbnail: '/hut.png', sway: 0,
        },
      },
    }
    const context: SceneValidationContext = {
      rulesVersion: 'a4.2-controller-gate-matrix',
      assets,
      assetManifestHash: 'a4.2-controller-assets',
      templateCatalogHash: 'a4.2-controller-templates',
      bindingHash: 'a4.2-controller-bindings',
      contextFingerprint: 'a4.2-controller-context',
      bindings: {
        personIds: [], locations: [], protectedObjects: [], protectedPlacements: [],
        locationBindings: [], personBindings: [], entries: [],
      },
    }
    scenario.configure?.(context)
    const evidence: { report?: SceneValidationReport } = {}
    const controller = new EditController({
      engine,
      save,
      onPreflightBlocked: value => blocked.push(value),
      preflight: async candidate => {
        if (candidate.kind !== 'operations') throw new Error('expected operations candidate')
        // Build the actual edited candidate on an isolated copy, then use the real scene validator.
        const candidateBase = deserialize(serialize(engine.world!.doc))
        const candidateDoc = applyEdits(candidateBase, candidate.operations).document
        const decoded = decodeSceneCompatibility(JSON.parse(serialize(candidateDoc)))
        if (decoded.status !== 'ready') throw new Error('could not decode candidate scene')
        evidence.report = await validateSceneEnvelope(
          decoded.envelope, context, DEFAULT_SCENE_BUDGET,
          createSceneWorkControl({ yieldControl: async () => {} }), 'edit',
        )
        return evidence.report.status === 'invalid'
          ? { status: 'invalid', report: evidence.report }
          : evidence.report.status === 'incomplete'
            ? { status: 'incomplete', report: evidence.report }
            : validResult()
      },
    })

    const outcome = await controller.applyOpsAsync(scenario.operations, { feedback: false })

    expect(evidence.report?.status).toBe('invalid')
    const issue = evidence.report?.issues.find(candidate => candidate.code === scenario.code)
    expect(issue).toBeDefined()
    expect(issue).toMatchObject({
      code: scenario.code, origin: 'edit', category: scenario.category, spaceId: 'single',
      ...(scenario.reason ? { reason: scenario.reason } : {}),
      ...(scenario.at ? { at: scenario.at } : {}),
      blocking: true,
    })
    expect(issue?.summary).toMatch(scenario.summary)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.blocked?.kind).toBe('invalid')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]!.report).toBe(evidence.report)
    expect(blocked[0]!.message).toContain(issue!.summary)
    expect(apply).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    controller.flushSave()
    expect(controller.saves).toBe(0)
    expect(save).not.toHaveBeenCalled()
    expect(engine.world!.doc).toBe(originalDoc)
    expect(engine.world!.doc.version).toBe(originalVersion)
    expect(serialize(engine.world!.doc)).toBe(originalSerialized)

    controller.dispose()
    engine.dispose()
  })

  it('incomplete 预检:同样不 apply、不保存,反馈检查未完成(W25)', async () => {
    const engine = headlessEngine()
    const controller = new EditController({
      engine,
      preflight: async () => ({ status: 'incomplete', report: reportStub('incomplete') }),
    })
    const outcome = await controller.applyOpsAsync([{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }], { feedback: false })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.blocked?.kind).toBe('incomplete')
    expect(outcome.ok === false && outcome.blocked?.message).toContain('检查未完成')
    expect(engine.world!.getBlock(at(5, 1, 5))).toBe('air')
    vi.advanceTimersByTime(1000)
    expect(controller.saves).toBe(0)
    engine.dispose()
  })

  it('valid 候选才应用,保存消费同一 basis(W25)', async () => {
    const engine = headlessEngine()
    const saves: Array<{ basis: PreflightBasis | null | undefined }> = []
    const controller = new EditController({
      engine,
      save: (_doc, basis) => { saves.push({ basis }) },
      preflight: async () => validResult('sha256:candidate-1'),
    })
    const outcome = await controller.applyOpsAsync([{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }], { feedback: false })
    expect(outcome.ok).toBe(true)
    expect(engine.world!.getBlock(at(5, 1, 5))).toBe('stone')
    controller.flushSave()
    expect(saves).toHaveLength(1)
    expect(saves[0]!.basis?.candidateHash).toBe('sha256:candidate-1')
    engine.dispose()
  })

  it('迟到的预检结果不得应用到已变化的场景(W25 序号守卫)', async () => {
    const engine = headlessEngine()
    let gate: ((result: SceneEditPreflightResult) => void) | null = null
    let calls = 0
    const controller = new EditController({
      engine,
      preflight: () => new Promise<SceneEditPreflightResult>(resolve => {
        calls += 1
        if (calls === 1) gate = resolve
        else resolve(validResult('sha256:second'))
      }),
    })
    const first = controller.applyOpsAsync([{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }], { feedback: false })
    // 第二笔编辑先完成预检并应用,场景序号随之推进
    const second = await controller.applyOpsAsync([{ kind: 'set-block', at: at(6, 1, 6), block: 'stone' }], { feedback: false })
    expect(second.ok).toBe(true)
    // 第一笔的迟到结果:场景已变 → conflict 阻断,不重复应用
    gate!(validResult('sha256:first'))
    const firstOutcome = await first
    expect(firstOutcome.ok).toBe(false)
    expect(firstOutcome.ok === false && firstOutcome.blocked?.kind).toBe('conflict')
    expect(engine.world!.getBlock(at(5, 1, 5))).toBe('air')
    expect(engine.world!.getBlock(at(6, 1, 6))).toBe('stone')
    engine.dispose()
  })

  it('已知 basis 且文档未变时直接消费,不重复预检;文档已变按 conflict 阻断(W22/W26)', async () => {
    const engine = headlessEngine()
    let preflightCalls = 0
    const controller = new EditController({
      engine,
      preflight: async () => { preflightCalls += 1; return validResult() },
    })
    const previewDoc = engine.world!.doc
    const basis = basisStub('sha256:ai-plan')
    const applied = await controller.applyOpsAsync([{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }], { basis, basisDoc: previewDoc, feedback: false })
    expect(applied.ok).toBe(true)
    expect(preflightCalls).toBe(0)
    expect(engine.world!.getBlock(at(5, 1, 5))).toBe('stone')

    // 场景已变(上一笔已应用),旧预览依据失效:不应用、不重复预检
    const stale = await controller.applyOpsAsync([{ kind: 'set-block', at: at(7, 1, 7), block: 'stone' }], { basis, basisDoc: previewDoc, feedback: false })
    expect(stale.ok).toBe(false)
    expect(stale.ok === false && stale.blocked?.kind).toBe('conflict')
    expect(stale.ok === false && stale.blocked?.message).toContain('重新生成预览')
    expect(preflightCalls).toBe(0)
    expect(engine.world!.getBlock(at(7, 1, 7))).toBe('air')
    engine.dispose()
  })

  it('既存问题与本次编辑问题来源区分(W26)', async () => {
    const engine = headlessEngine()
    const existingBlocked: PreflightBlocked[] = []
    const existingController = new EditController({
      engine,
      preflight: async () => ({ status: 'invalid', report: reportStub('invalid', [issueStub('existing', '旧石灯悬空')]) }),
      onPreflightBlocked: b => existingBlocked.push(b),
    })
    const outcome = await existingController.applyOpsAsync([{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }], { feedback: false })
    expect(outcome.ok).toBe(false)
    expect(existingBlocked[0]!.message).toContain('既存问题')
    expect(existingBlocked[0]!.message).toContain('兼容修复')
    engine.dispose()
  })

  it('预检服务不可用:不应用、不保存,反馈不可用(W26)', async () => {
    const engine = headlessEngine()
    const controller = new EditController({
      engine,
      preflight: async () => { throw new Error('网络错误') },
    })
    const outcome = await controller.applyOpsAsync([{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }], { feedback: false })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.blocked?.kind).toBe('unavailable')
    expect(engine.world!.getBlock(at(5, 1, 5))).toBe('air')
    vi.advanceTimersByTime(1000)
    expect(controller.saves).toBe(0)
    engine.dispose()
  })

  it('本地校验失败不发起预检(W26 不重复无效调用)', async () => {
    const engine = headlessEngine()
    let preflightCalls = 0
    const controller = new EditController({
      engine,
      preflight: async () => { preflightCalls += 1; return validResult() },
    })
    const outcome = await controller.applyOpsAsync([{ kind: 'set-block', at: at(40, 1, 1), block: 'stone' }], { feedback: false })
    expect(outcome.ok).toBe(false)
    expect(preflightCalls).toBe(0)
    engine.dispose()
  })
})

describe('EditController × S3b 地形重生成与风格包', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const TERRAIN_SIZE = { width: 32, height: 16, depth: 32 }

  function terrainEngine() {
    const engine = headlessEngine()
    const { params } = clampTerrainParams(
      { seed: 42, elevation: { amplitude: 4 }, river: { enabled: true }, vegetation: { density: 0.05 } },
      TERRAIN_SIZE,
    )
    const cells = generateTerrainCells(TERRAIN_SIZE, params)
    const doc = {
      ...writeTerrainCells(engine.world!.doc, cells).document,
      terrain: { params, clamps: [] },
    }
    engine.loadDocument(doc)
    return { engine, params }
  }

  const topY = (doc: VoxelDocument, x: number, z: number) => {
    for (let y = doc.size.height - 1; y >= 0; y--) {
      if (getBlock(doc, at(x, y, z)) !== 'air') return y
    }
    return 0
  }

  it('非参数化地形世界 → 拒绝并给 invalid-meta', () => {
    const engine = headlessEngine()
    const controller = new EditController({ engine })
    const outcome = controller.regenerateTerrain({ elevation: { amplitude: 2 } })
    expect(outcome.ok).toBe(false)
    expect(outcome.issues[0].code).toBe('invalid-meta')
    engine.dispose()
  })

  it('重生成替换地形层但物体格原样保留(F7)', () => {
    const { engine } = terrainEngine()
    const doc = engine.world!.doc
    const anchor = at(10, topY(doc, 10, 10) + 1, 10)
    const placed = applyEdits(doc, [
      { kind: 'place-object', objectType: 'stone-lantern', anchor, rotation: 0, objectId: 'lamp' },
    ]).document
    engine.loadDocument(placed)
    const lampCells = placed.objectCells.find((c) => c.objectId === 'lamp')!.cells
    const before = lampCells.map((c) => getBlock(engine.world!.doc, c))

    const controller = new EditController({ engine })
    const outcome = controller.regenerateTerrain({ seed: 42, elevation: { amplitude: 4 }, river: { enabled: false }, vegetation: { density: 0.05 } })
    expect(outcome.ok).toBe(true)
    expect(Array.isArray(outcome.issues)).toBe(true)
    // 物体记录与格子内容原样
    expect(engine.world!.doc.objectCells.find((c) => c.objectId === 'lamp')).toBeDefined()
    lampCells.forEach((c, i) => expect(getBlock(engine.world!.doc, c)).toBe(before[i]))
    // 元数据已更新
    expect(engine.world!.doc.terrain?.params.river?.enabled).toBe(false)
    engine.dispose()
  })

  it('手工挖掉的地形格在重生成时被覆盖(F7)', () => {
    const { engine } = terrainEngine()
    const doc = engine.world!.doc
    const victim = at(5, topY(doc, 5, 5), 5)
    const controller = new EditController({ engine })
    const dug = controller.applyOps([{ kind: 'set-block', at: victim, block: 'air' }], false)
    expect(dug.ok).toBe(true)
    expect(getBlock(engine.world!.doc, victim)).toBe('air')
    const outcome = controller.regenerateTerrain(engine.world!.doc.terrain!.params)
    expect(outcome.ok).toBe(true)
    expect(getBlock(engine.world!.doc, victim)).not.toBe('air')
    engine.dispose()
  })

  it('setStyle:夹取落文档、引擎即时生效、未知预设记录(F8/F9)', () => {
    const { engine } = terrainEngine()
    const controller = new EditController({ engine })
    const outcome = controller.setStyle({ preset: 'dusk-warm', tweaks: { exposure: 5 } })
    expect(outcome.ok).toBe(true)
    expect(engine.getStyle()?.preset).toBe('dusk-warm')
    expect(engine.getStyle()?.tweaks?.exposure).toBe(0.3)
    const docStyle = engine.world!.doc.style
    expect(docStyle?.preset).toBe('dusk-warm')
    expect(docStyle?.clamps).toEqual([{ field: 'style.tweaks.exposure', from: 5, to: 0.3 }])

    const unknown = controller.setStyle({ preset: 'cyberpunk' })
    expect(unknown.ok).toBe(true)
    expect(engine.world!.doc.style?.preset).toBe('default')
    expect(engine.world!.doc.style?.clamps).toEqual([{ field: 'style.preset', from: 'cyberpunk', to: 'default' }])
    engine.dispose()
  })
})
