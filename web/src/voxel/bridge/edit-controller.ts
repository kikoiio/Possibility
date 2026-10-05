import {
  applyEdits, clampStyleRef, clampTerrainParams, diffAssetPlacementsRegen, diffTerrainRegen, generateTerrain,
  serialize, validateDocument, validateEdit, validateWalkability, writeTerrainCells,
  type EditOperation, type EditResult, type SceneCandidate, type SceneEditPreflightResult,
  type SceneValidationBasis, type SceneValidationReport, type StylePackRef, type TerrainParams,
  type ValidationIssue, type VoxelDocument,
} from '@possibility/voxel-contract'
import type { VoxelEngine } from '../engine'

export type EditOutcome = { ok: true; result: EditResult } | { ok: false; issues: ValidationIssue[] }

/** S3b 重生成结果:地形层替换后的校验 issue(悬空/连通等),空数组 = 校验通过 */
export type RegenOutcome = { ok: true; issues: ValidationIssue[] } | { ok: false; issues: ValidationIssue[] }

/** A1(W20):预检通过的候选依据(含 candidateHash),随保存回调传递。 */
export type PreflightBasis = SceneValidationBasis & { candidateHash: string }

/** A1(W20/W22):预检阻断——不 apply、不 autosave、保留原场景。 */
export interface PreflightBlocked {
  /** invalid=候选自身无效;incomplete=检查未完成;conflict=场景/依据已变化;unavailable=预检服务不可用 */
  kind: 'invalid' | 'incomplete' | 'conflict' | 'unavailable'
  message: string
  report?: SceneValidationReport
}

export type AsyncEditOutcome =
  | { ok: true; result: EditResult; basis: PreflightBasis | null }
  | { ok: false; issues: ValidationIssue[]; blocked?: PreflightBlocked }

export type AsyncRegenOutcome =
  | { ok: true; issues: ValidationIssue[]; basis: PreflightBasis | null }
  | { ok: false; issues: ValidationIssue[]; blocked?: PreflightBlocked }

export interface EditControllerOptions {
  engine: VoxelEngine
  /** 产品层注入的权限闸门（移动端只读、锁定之外的规则等） */
  canEdit?: () => boolean
  /** 防抖保存回调（产品层实现，N12 接口不变）；A1 起第二参携带候选对应的预检依据 */
  save?: (doc: VoxelDocument, basis?: PreflightBasis | null) => void | Promise<void>
  saveDebounceMs?: number
  onRejected?: (issues: ValidationIssue[]) => void
  onApplied?: (result: EditResult) => void
  /**
   * A1(W20):完整候选预检（产品层接 /api/worlds/:id/scene/compatibility/preflight）。
   * 配置后所有编辑必须先过预检再触碰引擎/编辑状态;同步 applyOps/regenerateTerrain/setStyle 拒绝执行。
   */
  preflight?: (candidate: SceneCandidate) => Promise<SceneEditPreflightResult>
  /** 多空间信封中当前视口对应的空间 ID,候选按此归位 */
  spaceId?: string
  /** 预检阻断通知(invalid/incomplete/conflict/unavailable),供 UI 统一阶段反馈 */
  onPreflightBlocked?: (blocked: PreflightBlocked) => void
}

/**
 * 三种编辑源统一收口：仓库拖拽 / 方块编辑 / AI 编辑都组装成
 * EditOperation[] 走到这里，经 validateEdit + 权限规则后应用（AC14/AC15）。
 */
export class EditController {
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private pendingDoc: VoxelDocument | null = null
  private pendingBasis: PreflightBasis | null = null
  private saveCount = 0
  /** A1:每次成功应用递增;预检等待期间序号变化 = 场景已被别处改动,迟到结果不得应用 */
  private editSeq = 0

  constructor(private opts: EditControllerOptions) {}

  private get engine() {
    return this.opts.engine
  }

  /** A1:是否配置了完整候选预检(配置后同步编辑入口拒绝执行) */
  get hasPreflight(): boolean {
    return Boolean(this.opts.preflight)
  }

  applyOps(ops: EditOperation[], feedback = true): EditOutcome {
    const doc = this.engine.world?.doc
    if (!doc) return { ok: false, issues: [{ code: 'locked-violation', message: '世界尚未加载' }] }
    if (this.opts.preflight) {
      // A1(W20):配置了预检时同步入口一律拒绝,调用方必须走 applyOpsAsync
      const issues: ValidationIssue[] = [{ code: 'invalid-meta', message: '编辑需先通过完整候选预检' }]
      this.opts.onRejected?.(issues)
      return { ok: false, issues }
    }
    if (this.opts.canEdit && !this.opts.canEdit()) {
      const issues: ValidationIssue[] = [{ code: 'locked-violation', message: '当前环境不允许编辑' }]
      this.opts.onRejected?.(issues)
      return { ok: false, issues }
    }
    // S2b:清单可用时摆放 op 走严格校验(assetId 存在性/footprint)
    const issues = validateEdit(doc, ops, undefined, this.engine.assetsManifest ?? undefined)
    if (issues.length > 0) {
      this.opts.onRejected?.(issues)
      return { ok: false, issues }
    }
    const result = applyEdits(doc, ops)
    this.engine.applyEditResult(result)
    this.editSeq += 1
    if (feedback) this.playFeedback(ops)
    this.scheduleSave(result.document, null)
    this.opts.onApplied?.(result)
    return { ok: true, result }
  }

  /** A1(W22/W26):按报告问题来源给出统一阶段反馈文案。 */
  private blockedFromReport(kind: 'invalid' | 'incomplete', report: SceneValidationReport | undefined): PreflightBlocked {
    if (!report || !report.issues) {
      return { kind, message: kind === 'incomplete' ? '场景检查未完成，未应用任何改动，请稍后重试。' : '候选未通过完整校验，未应用任何改动。' }
    }
    const issues = Array.isArray(report.issues) ? report.issues : (report.issues as { items: SceneValidationReport['issues'] }).items
    const existing = issues.find(issue => issue.origin === 'existing')
    const edited = issues.find(issue => issue.origin === 'edit' || issue.origin === 'repair')
    const message = kind === 'incomplete'
      ? '场景检查未完成，未应用任何改动，请稍后重试。'
      : existing
        ? `场景存在既存问题（${existing.summary}），请先完成兼容修复；本次改动未应用。`
        : `本次编辑未通过完整校验（${edited?.summary ?? issues[0]?.summary ?? '未知问题'}），未应用任何改动。`
    return { kind, message, report }
  }

  /**
   * A1(W20):候选预检先于一切引擎/编辑状态变更。
   * - 预检 invalid/incomplete/unavailable:不 apply、不 autosave,原场景保留;
   * - 等待期间场景被改动(序号/文档引用变化):按 conflict 阻断,迟到结果不应用;
   * - 已知 basis(如 AI 规划已携 previewBasis)且文档未变时直接消费,不重复预检。
   */
  async applyOpsAsync(ops: EditOperation[], options: { basis?: PreflightBasis | null; basisDoc?: VoxelDocument; feedback?: boolean } = {}): Promise<AsyncEditOutcome> {
    const doc = this.engine.world?.doc
    if (!doc) return { ok: false, issues: [{ code: 'locked-violation', message: '世界尚未加载' }] }
    if (this.opts.canEdit && !this.opts.canEdit()) {
      const issues: ValidationIssue[] = [{ code: 'locked-violation', message: '当前环境不允许编辑' }]
      this.opts.onRejected?.(issues)
      return { ok: false, issues }
    }
    const issues = validateEdit(doc, ops, undefined, this.engine.assetsManifest ?? undefined)
    if (issues.length > 0) {
      this.opts.onRejected?.(issues)
      return { ok: false, issues }
    }
    let basis = options.basis ?? null
    if (this.opts.preflight) {
      if (basis && options.basisDoc && options.basisDoc !== doc) {
        const blocked: PreflightBlocked = { kind: 'conflict', message: '场景已变化，预览依据失效，请重新生成预览。' }
        this.opts.onPreflightBlocked?.(blocked)
        return { ok: false, issues: [], blocked }
      }
      if (!basis) {
        const seq = this.editSeq
        let result: SceneEditPreflightResult
        try {
          result = await this.opts.preflight({
            kind: 'operations',
            ...(this.opts.spaceId ? { spaceId: this.opts.spaceId } : {}),
            operations: ops,
          })
        } catch (error) {
          const blocked: PreflightBlocked = { kind: 'unavailable', message: error instanceof Error ? error.message : '场景预检暂时不可用，未应用任何改动。' }
          this.opts.onPreflightBlocked?.(blocked)
          return { ok: false, issues: [], blocked }
        }
        if (this.editSeq !== seq || this.engine.world?.doc !== doc) {
          const blocked: PreflightBlocked = { kind: 'conflict', message: '场景在检查期间已变化，请重新检查后再试。' }
          this.opts.onPreflightBlocked?.(blocked)
          return { ok: false, issues: [], blocked }
        }
        if (result.status !== 'valid') {
          const blocked = this.blockedFromReport(result.status === 'invalid' ? 'invalid' : 'incomplete', result.report)
          this.opts.onPreflightBlocked?.(blocked)
          return { ok: false, issues: [], blocked }
        }
        basis = result.basis
      }
    }
    const result = applyEdits(doc, ops)
    this.engine.applyEditResult(result)
    this.editSeq += 1
    if (options.feedback !== false) this.playFeedback(ops)
    this.scheduleSave(result.document, basis)
    this.opts.onApplied?.(result)
    return { ok: true, result, basis }
  }

  private playFeedback(ops: EditOperation[]): void {
    const feedback = this.engine.feedback
    if (!feedback) return
    for (const op of ops) {
      switch (op.kind) {
        case 'set-block':
          if (op.block === 'air') feedback.playDig(op.at)
          else feedback.playPlace(op.at)
          break
        case 'place-object':
          feedback.playPlace(op.anchor)
          break
        case 'move-object':
          feedback.playPlace(op.anchor)
          break
        case 'remove-object':
          break // 移除由 UI 自身反馈
        case 'fill':
          feedback.playPlace(op.from)
          break
        case 'place-asset':
        case 'move-asset':
          feedback.playPlace(op.anchor)
          break
        case 'remove-asset':
          break // 移除由 UI 自身反馈
      }
    }
  }

  /**
   * S3b 显式重新生成(F7):重放旧地形 → diff 新地形 → 替换地形层,
   * 保留地形层以外的方块与全部物体;完成后重跑契约+可行走性校验,
   * issue 如实返回给调用方呈现,不静默。
   */
  regenerateTerrain(rawParams: TerrainParams): RegenOutcome {
    const doc = this.engine.world?.doc
    if (!doc) return { ok: false, issues: [{ code: 'locked-violation', message: '世界尚未加载' }] }
    if (this.opts.preflight) {
      const issues: ValidationIssue[] = [{ code: 'invalid-meta', message: '重新生成需先通过完整候选预检' }]
      this.opts.onRejected?.(issues)
      return { ok: false, issues }
    }
    if (this.opts.canEdit && !this.opts.canEdit()) {
      const issues: ValidationIssue[] = [{ code: 'locked-violation', message: '当前环境不允许编辑' }]
      this.opts.onRejected?.(issues)
      return { ok: false, issues }
    }
    if (!doc.terrain) {
      return { ok: false, issues: [{ code: 'invalid-meta', message: '当前世界不是参数化地形世界,无法重新生成' }] }
    }
    const { params, clamps } = clampTerrainParams(rawParams, doc.size, doc.terrain.params.seed)
    const oldGenerated = generateTerrain(doc.size, doc.terrain.params)
    const newGenerated = generateTerrain(doc.size, params)
    const diff = diffTerrainRegen(doc, oldGenerated.cells, newGenerated.cells)
    const written = writeTerrainCells(doc, diff)
    const placements = diffAssetPlacementsRegen(doc, oldGenerated.assetPlacements, newGenerated.assetPlacements)
    const next: VoxelDocument = {
      ...written.document,
      ...(placements ? { assetPlacements: placements } : {}),
      terrain: { params, clamps },
    }
    this.engine.applyEditResult({
      document: next,
      changedSections: written.changedSections,
      affectedObjectIds: [],
    })
    this.editSeq += 1
    this.scheduleSave(next, null)
    const issues = [...validateDocument(next), ...validateWalkability(next)]
    return { ok: true, issues }
  }

  /** A1(W23):重生成候选先本地组装,完整预检通过才替换地形层;阻断/冲突保留原场景与待选参数。 */
  async regenerateTerrainAsync(rawParams: TerrainParams): Promise<AsyncRegenOutcome> {
    const doc = this.engine.world?.doc
    if (!doc) return { ok: false, issues: [{ code: 'locked-violation', message: '世界尚未加载' }] }
    if (this.opts.canEdit && !this.opts.canEdit()) {
      const issues: ValidationIssue[] = [{ code: 'locked-violation', message: '当前环境不允许编辑' }]
      this.opts.onRejected?.(issues)
      return { ok: false, issues }
    }
    if (!doc.terrain) {
      return { ok: false, issues: [{ code: 'invalid-meta', message: '当前世界不是参数化地形世界,无法重新生成' }] }
    }
    const { params, clamps } = clampTerrainParams(rawParams, doc.size, doc.terrain.params.seed)
    const oldGenerated = generateTerrain(doc.size, doc.terrain.params)
    const newGenerated = generateTerrain(doc.size, params)
    const diff = diffTerrainRegen(doc, oldGenerated.cells, newGenerated.cells)
    const written = writeTerrainCells(doc, diff)
    const placements = diffAssetPlacementsRegen(doc, oldGenerated.assetPlacements, newGenerated.assetPlacements)
    const next: VoxelDocument = {
      ...written.document,
      ...(placements ? { assetPlacements: placements } : {}),
      terrain: { params, clamps },
    }
    let basis: PreflightBasis | null = null
    if (this.opts.preflight) {
      const seq = this.editSeq
      let result: SceneEditPreflightResult
      try {
        result = await this.opts.preflight({
          kind: 'document',
          ...(this.opts.spaceId ? { spaceId: this.opts.spaceId } : {}),
          document: JSON.parse(serialize(next)),
        })
      } catch (error) {
        const blocked: PreflightBlocked = { kind: 'unavailable', message: error instanceof Error ? error.message : '场景预检暂时不可用，未应用任何改动。' }
        this.opts.onPreflightBlocked?.(blocked)
        return { ok: false, issues: [], blocked }
      }
      if (this.editSeq !== seq || this.engine.world?.doc !== doc) {
        const blocked: PreflightBlocked = { kind: 'conflict', message: '场景在检查期间已变化，请重新检查后再试。' }
        this.opts.onPreflightBlocked?.(blocked)
        return { ok: false, issues: [], blocked }
      }
      if (result.status !== 'valid') {
        const blocked = this.blockedFromReport(result.status === 'invalid' ? 'invalid' : 'incomplete', result.report)
        this.opts.onPreflightBlocked?.(blocked)
        return { ok: false, issues: [], blocked }
      }
      basis = result.basis
    }
    this.engine.applyEditResult({
      document: next,
      changedSections: written.changedSections,
      affectedObjectIds: [],
    })
    this.editSeq += 1
    this.scheduleSave(next, basis)
    const issues = [...validateDocument(next), ...validateWalkability(next)]
    return { ok: true, issues, basis }
  }

  /** S3b 风格包切换(F8/F9):夹取 → 落文档 → 引擎即时生效 → 保存 */
  setStyle(raw: unknown): { ok: boolean; style?: StylePackRef; issues: ValidationIssue[] } {
    const doc = this.engine.world?.doc
    if (!doc) return { ok: false, issues: [{ code: 'locked-violation', message: '世界尚未加载' }] }
    if (this.opts.preflight) {
      const issues: ValidationIssue[] = [{ code: 'invalid-meta', message: '风格切换需先通过完整候选预检' }]
      this.opts.onRejected?.(issues)
      return { ok: false, issues }
    }
    if (this.opts.canEdit && !this.opts.canEdit()) {
      const issues: ValidationIssue[] = [{ code: 'locked-violation', message: '当前环境不允许编辑' }]
      this.opts.onRejected?.(issues)
      return { ok: false, issues }
    }
    const { style, clamps } = clampStyleRef(raw)
    const next: VoxelDocument = { ...doc, style: { ...style, ...(clamps.length > 0 ? { clamps } : {}) } }
    this.engine.setStyle(next.style!)
    if (this.engine.world) this.engine.world.doc = next
    this.editSeq += 1
    this.scheduleSave(next, null)
    return { ok: true, style: next.style, issues: [] }
  }

  /** A1(W23):风格候选预检通过才落文档;阻断时保留原风格与面板待选值。 */
  async setStyleAsync(raw: unknown): Promise<{ ok: boolean; style?: StylePackRef; issues: ValidationIssue[]; blocked?: PreflightBlocked }> {
    const doc = this.engine.world?.doc
    if (!doc) return { ok: false, issues: [{ code: 'locked-violation', message: '世界尚未加载' }] }
    if (this.opts.canEdit && !this.opts.canEdit()) {
      const issues: ValidationIssue[] = [{ code: 'locked-violation', message: '当前环境不允许编辑' }]
      this.opts.onRejected?.(issues)
      return { ok: false, issues }
    }
    const { style, clamps } = clampStyleRef(raw)
    const next: VoxelDocument = { ...doc, style: { ...style, ...(clamps.length > 0 ? { clamps } : {}) } }
    let basis: PreflightBasis | null = null
    if (this.opts.preflight) {
      const seq = this.editSeq
      let result: SceneEditPreflightResult
      try {
        result = await this.opts.preflight({
          kind: 'document',
          ...(this.opts.spaceId ? { spaceId: this.opts.spaceId } : {}),
          document: JSON.parse(serialize(next)),
        })
      } catch (error) {
        const blocked: PreflightBlocked = { kind: 'unavailable', message: error instanceof Error ? error.message : '场景预检暂时不可用，未应用任何改动。' }
        this.opts.onPreflightBlocked?.(blocked)
        return { ok: false, issues: [], blocked }
      }
      if (this.editSeq !== seq || this.engine.world?.doc !== doc) {
        const blocked: PreflightBlocked = { kind: 'conflict', message: '场景在检查期间已变化，请重新检查后再试。' }
        this.opts.onPreflightBlocked?.(blocked)
        return { ok: false, issues: [], blocked }
      }
      if (result.status !== 'valid') {
        const blocked = this.blockedFromReport(result.status === 'invalid' ? 'invalid' : 'incomplete', result.report)
        this.opts.onPreflightBlocked?.(blocked)
        return { ok: false, issues: [], blocked }
      }
      basis = result.basis
    }
    this.engine.setStyle(next.style!)
    if (this.engine.world) this.engine.world.doc = next
    this.editSeq += 1
    this.scheduleSave(next, basis)
    return { ok: true, style: next.style, issues: [] }
  }

  /** 防抖保存：连续编辑合并为一次（N2 不被网络阻塞）；依据随最新候选一并保存 */
  private scheduleSave(doc: VoxelDocument, basis: PreflightBasis | null): void {
    this.pendingDoc = doc
    this.pendingBasis = basis
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flushSave(), this.opts.saveDebounceMs ?? 800)
  }

  flushSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.pendingDoc && this.opts.save) {
      this.saveCount += 1
      void this.opts.save(this.pendingDoc, this.pendingBasis)
    }
    this.pendingDoc = null
    this.pendingBasis = null
  }

  /** 测试探针：实际触发保存的次数 */
  get saves(): number {
    return this.saveCount
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.pendingDoc = null
    this.pendingBasis = null
  }
}
