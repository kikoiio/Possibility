import { useEffect, useMemo, useRef, useState } from 'react'
import type { SceneRepairChange, SceneRuleNote, VoxelDocument } from '@possibility/voxel-contract'
import VoxelViewport from '../../voxel/VoxelViewport'
import { parseVoxelDocument } from '../../voxel/flags'

export interface SceneRepairPreviewSpace { spaceId: string; name: string }

export interface SceneRepairPreviewProps {
  /** 候选草稿声明的空间列表（来自公开 DTO 的 previewSpaces） */
  spaces: SceneRepairPreviewSpace[]
  /** 按空间惰性读取来源（修复前）序列化文档；实现应对接公开按空间接口 */
  loadSourceSpace: (spaceId: string, signal: AbortSignal) => Promise<unknown>
  /** 按空间惰性读取候选（修复后）序列化文档 */
  loadCandidateSpace: (spaceId: string, signal: AbortSignal) => Promise<unknown>
  changes?: SceneRepairChange[]
  ruleNotes?: SceneRuleNote[]
  initialSpaceId?: string
  timeZone?: string | null
}

type Side = 'before' | 'after'

function coordText(at: { x: number; y: number; z: number }): string {
  return `(${at.x}, ${at.y}, ${at.z})`
}

/**
 * 修复前后只读预览（W15/W16）：同一个 VoxelViewport 切换空间与前后，
 * 不挂载编辑器、不接保存回调；切换/卸载时 abort 进行中的读取。
 */
export function SceneRepairPreview({
  spaces, loadSourceSpace, loadCandidateSpace, changes = [], ruleNotes = [], initialSpaceId, timeZone,
}: SceneRepairPreviewProps) {
  const [spaceId, setSpaceId] = useState(initialSpaceId ?? spaces[0]?.spaceId ?? '')
  const [side, setSide] = useState<Side>('after')
  const [doc, setDoc] = useState<VoxelDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const cacheRef = useRef(new Map<string, VoxelDocument>())

  useEffect(() => {
    if (!spaceId) return
    const key = `${spaceId}:${side}`
    const cached = cacheRef.current.get(key)
    if (cached) {
      setDoc(cached)
      setError(null)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const load = side === 'before' ? loadSourceSpace : loadCandidateSpace
    load(spaceId, controller.signal)
      .then(raw => {
        if (controller.signal.aborted) return
        const parsed = parseVoxelDocument(raw)
        if (!parsed) throw new Error('预览资料无法解析')
        cacheRef.current.set(key, parsed)
        setDoc(parsed)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setDoc(null)
        setError(cause instanceof Error ? cause.message : '预览加载失败')
        setLoading(false)
      })
    return () => controller.abort()
  }, [spaceId, side, loadSourceSpace, loadCandidateSpace])

  useEffect(() => () => { cacheRef.current.clear() }, [])

  const spaceChanges = useMemo(() => changes.filter(change => change.spaceId === spaceId), [changes, spaceId])
  const spaceNotes = useMemo(() => ruleNotes.filter(note => note.spaceId === spaceId), [ruleNotes, spaceId])

  if (!spaces.length) return <p className="text-sm text-[#798579]">没有可预览的空间。</p>

  return <div className="flex h-full flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <div role="tablist" aria-label="预览空间" className="flex flex-wrap gap-1">
        {spaces.map(space => <button
          key={space.spaceId}
          type="button"
          role="tab"
          aria-selected={space.spaceId === spaceId}
          onClick={() => setSpaceId(space.spaceId)}
          className={`rounded-full px-3 py-1 text-xs ${space.spaceId === spaceId ? 'bg-[#496153] text-white' : 'border border-[#d4ded3] text-[#496153]'}`}
        >{space.name}</button>)}
      </div>
      <div role="tablist" aria-label="修复前后" className="ml-auto flex gap-1">
        {(['before', 'after'] as const).map(value => <button
          key={value}
          type="button"
          role="tab"
          aria-selected={side === value}
          onClick={() => setSide(value)}
          className={`rounded-full px-3 py-1 text-xs ${side === value ? 'bg-[#496153] text-white' : 'border border-[#d4ded3] text-[#496153]'}`}
        >{value === 'before' ? '修复前' : '修复后'}</button>)}
      </div>
    </div>

    <div className="relative min-h-[240px] flex-1 overflow-hidden rounded-xl border border-[#dfe4d9] bg-[#f4f6f0]">
      {/* absolute 撑满 relative 容器：h-full 在仅靠 min-height 撑高的容器里会塌成 0，画布随之 0 高 */}
      {doc && <div className="absolute inset-0"><VoxelViewport
        key={`${spaceId}:${side}`}
        document={doc}
        spaceId={spaceId}
        timeZone={timeZone}
        instanceId={`repair-preview-${spaceId}`}
        probePrimary={false}
        fitContainer
      /></div>}
      {loading && <p role="status" className="absolute inset-0 grid place-items-center text-sm text-[#798579]">正在加载预览…</p>}
      {error && <div role="alert" className="absolute inset-0 grid place-items-center p-4 text-center">
        <p className="text-sm text-[#8a5147]">{error}</p>
        <p className="mt-1 text-[11px] text-[#859085]">预览加载失败不会影响真实场景。</p>
      </div>}
    </div>

    {spaceChanges.length > 0 && <ul className="space-y-1">
      {spaceChanges.map(change => <li key={change.id} className="text-[11px] text-[#6b7a6f]">
        {change.summary}
        {change.kind === 'move-asset' ? `（${coordText(change.from)} → ${coordText(change.to)}）` : ''}
        {change.kind === 'set-block' ? `（${coordText(change.at)}）` : ''}
      </li>)}
    </ul>}
    {spaceNotes.length > 0 && <ul className="space-y-1">
      {spaceNotes.map((note, index) => <li key={`${note.code}-${index}`} className="text-[11px] text-[#859085]">{note.message}</li>)}
    </ul>}
    <p className="text-[11px] text-[#859085]">预览为只读，不会触发编辑或自动保存。</p>
  </div>
}
