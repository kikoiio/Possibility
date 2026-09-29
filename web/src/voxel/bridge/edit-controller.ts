import {
  applyEdits, validateEdit,
  type EditOperation, type EditResult, type ValidationIssue, type VoxelDocument,
} from '@possibility/voxel-contract'
import type { VoxelEngine } from '../engine'

export type EditOutcome = { ok: true; result: EditResult } | { ok: false; issues: ValidationIssue[] }

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
    const issues = validateEdit(doc, ops)
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
      }
    }
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
