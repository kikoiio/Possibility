import {
  getBlock as contractGetBlock, inBounds, setBlockMut,
  type EditResult, type SectionKey, type VoxelCoord, type VoxelDocument,
} from '@possibility/voxel-contract'

export type WorldListener = (changed: SectionKey[]) => void

/** 节存储的读写视图 + dirty 追踪（契约文档之上的引擎侧包装） */
export class WorldModel {
  private dirty = new Set<SectionKey>()
  private listeners = new Set<WorldListener>()

  constructor(public doc: VoxelDocument) {}

  getBlock(at: VoxelCoord): string {
    return contractGetBlock(this.doc, at)
  }

  inBounds(at: VoxelCoord): boolean {
    return inBounds(this.doc.size, at)
  }

  /** 就地写一格，返回受影响节（含边界邻居节），并标记 dirty + 通知 */
  setBlock(at: VoxelCoord, id: string): SectionKey[] {
    const affected = setBlockMut(this.doc, at, id)
    if (affected.length > 0) {
      for (const key of affected) this.dirty.add(key)
      for (const fn of this.listeners) fn(affected)
    }
    return affected
  }

  /** 用契约 applyEdits 的结果整体替换文档，changedSections 标记 dirty */
  applyResult(result: EditResult): void {
    this.doc = result.document
    for (const key of result.changedSections) this.dirty.add(key)
    if (result.changedSections.length > 0) {
      for (const fn of this.listeners) fn(result.changedSections)
    }
  }

  replaceDocument(doc: VoxelDocument): void {
    this.doc = doc
    this.dirty.clear()
    for (const fn of this.listeners) fn(Object.keys(doc.sections))
  }

  consumeDirty(): SectionKey[] {
    const keys = [...this.dirty]
    this.dirty.clear()
    return keys
  }

  subscribe(fn: WorldListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}
