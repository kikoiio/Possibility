import {
  applyEdits, clampStyleRef, clampTerrainParams, diffAssetPlacementsRegen, diffTerrainRegen, generateTerrain,
  validateDocument, validateEdit, validateWalkability, writeTerrainCells,
  type EditOperation, type EditResult, type StylePackRef, type TerrainParams, type ValidationIssue,
  type VoxelDocument,
} from '@possibility/voxel-contract'
import type { VoxelEngine } from '../engine'

export type EditOutcome = { ok: true; result: EditResult } | { ok: false; issues: ValidationIssue[] }

/** S3b 重生成结果:地形层替换后的校验 issue(悬空/连通等),空数组 = 校验通过 */
export type RegenOutcome = { ok: true; issues: ValidationIssue[] } | { ok: false; issues: ValidationIssue[] }

export interface EditControllerOptions {
  engine: VoxelEngine
  /** 产品层注入的权限闸门（移动端只读、锁定之外的规则等） */
  canEdit?: () => boolean
  /** 防抖保存回调（产品层实现，N12 接口不变） */
  save?: (doc: VoxelDocument) => void | Promise<void>
  saveDebounceMs?: number
  onRejected?: (issues: ValidationIssue[]) => void
  onApplied?: (result: EditResult) => void
}

/**
 * 三种编辑源统一收口：仓库拖拽 / 方块编辑 / AI 编辑都组装成
 * EditOperation[] 走到这里，经 validateEdit + 权限规则后应用（AC14/AC15）。
 */
export class EditController {
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private pendingDoc: VoxelDocument | null = null
  private saveCount = 0

  constructor(private opts: EditControllerOptions) {}

  private get engine() {
    return this.opts.engine
  }

  applyOps(ops: EditOperation[], feedback = true): EditOutcome {
    const doc = this.engine.world?.doc
    if (!doc) return { ok: false, issues: [{ code: 'locked-violation', message: '世界尚未加载' }] }
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
    if (feedback) this.playFeedback(ops)
    this.scheduleSave(result.document)
    this.opts.onApplied?.(result)
    return { ok: true, result }
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
    this.scheduleSave(next)
    const issues = [...validateDocument(next), ...validateWalkability(next)]
    return { ok: true, issues }
  }

  /** S3b 风格包切换(F8/F9):夹取 → 落文档 → 引擎即时生效 → 保存 */
  setStyle(raw: unknown): { ok: boolean; style?: StylePackRef; issues: ValidationIssue[] } {
    const doc = this.engine.world?.doc
    if (!doc) return { ok: false, issues: [{ code: 'locked-violation', message: '世界尚未加载' }] }
    if (this.opts.canEdit && !this.opts.canEdit()) {
      const issues: ValidationIssue[] = [{ code: 'locked-violation', message: '当前环境不允许编辑' }]
      this.opts.onRejected?.(issues)
      return { ok: false, issues }
    }
    const { style, clamps } = clampStyleRef(raw)
    const next: VoxelDocument = { ...doc, style: { ...style, ...(clamps.length > 0 ? { clamps } : {}) } }
    this.engine.setStyle(next.style!)
    if (this.engine.world) this.engine.world.doc = next
    this.scheduleSave(next)
    return { ok: true, style: next.style, issues: [] }
  }

  /** 防抖保存：连续编辑合并为一次（N2 不被网络阻塞） */
  private scheduleSave(doc: VoxelDocument): void {
    this.pendingDoc = doc
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
      void this.opts.save(this.pendingDoc)
    }
    this.pendingDoc = null
  }

  /** 测试探针：实际触发保存的次数 */
  get saves(): number {
    return this.saveCount
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.pendingDoc = null
  }
}
