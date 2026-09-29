import { useCallback, useEffect, useRef, useState } from 'react'
import { validateEdit, type EditOperation } from '@possibility/voxel-contract'
import type { VoxelEngine } from '../engine'
import { Picker } from '../engine'
import type { EditController } from '../bridge/edit-controller'
import WarehousePanel from './WarehousePanel'
import BlockPalette from './BlockPalette'
import AiEditPanel from './AiEditPanel'
import WorldPanel from './WorldPanel'

export interface VoxelEditorProps {
  engine: VoxelEngine
  controller: EditController
  /** AI 编辑规划（产品层接 /api/voxel/edit-plan） */
  planEdits: (intent: string) => Promise<EditOperation[]>
  /** 无编辑工具激活时的观察点击（居民/地点/空间导航，T28）；返回 true 表示已消费 */
  interact?: (clientX: number, clientY: number) => boolean
  /** 平台闸门（T29）：false 时隐藏全部编辑入口 */
  editing?: boolean
}

type Tool = 'warehouse' | 'block' | 'ai' | 'world'

const CLICK_SLOP_PX = 6

/** 编辑器编排：三种编辑方式的 UI 与画布交互，全部归约到 EditController（F15/F16/F17） */
export default function VoxelEditor({ engine, controller, planEdits, interact, editing = true }: VoxelEditorProps) {
  const [tool, setTool] = useState<Tool | null>(null)
  const [armedType, setArmedType] = useState<string | null>(null)
  const [blockTool, setBlockTool] = useState<'place' | 'dig'>('place')
  const [selectedBlock, setSelectedBlock] = useState('stone')
  const [selectedObject, setSelectedObject] = useState<{ id: string; label: string } | null>(null)
  const [aiPending, setAiPending] = useState<EditOperation[] | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [rejection, setRejection] = useState<string | null>(null)
  const aiGhost = useRef<{ dismiss(): void } | null>(null)

  const showRejection = useCallback((message: string) => {
    setRejection(message)
    setTimeout(() => setRejection(null), 3200)
  }, [])

  const rayAt = useCallback((clientX: number, clientY: number) => {
    const canvas = engine.renderer.canvas
    if (!canvas || !engine.picker) return null
    const ray = Picker.rayFromScreen(clientX, clientY, canvas, engine.cameraRig.camera)
    return { ray, picker: engine.picker }
  }, [engine])

  const applyWithNotice = useCallback((ops: EditOperation[]) => {
    const outcome = controller.applyOps(ops)
    if (!outcome.ok) showRejection(outcome.issues[0]?.message ?? '编辑被拒绝')
    return outcome.ok
  }, [controller, showRejection])

  const handleClick = useCallback((clientX: number, clientY: number) => {
    if (aiPending) return // 预览待确认期间锁定画布编辑
    if (tool === null) {
      interact?.(clientX, clientY) // 观察模式：居民 / 地点 / 空间导航
      return
    }
    if (!editing) return
    const ctx = rayAt(clientX, clientY)
    if (!ctx) return
    if (tool === 'block') {
      const hit = ctx.picker.pickVoxel(ctx.ray)
      if (!hit) return
      if (blockTool === 'dig') {
        applyWithNotice([{ kind: 'set-block', at: hit.at, block: 'air' }])
      } else {
        applyWithNotice([{ kind: 'set-block', at: Picker.placementCell(hit), block: selectedBlock }])
      }
      return
    }
    if (tool === 'warehouse') {
      const hit = ctx.picker.pickVoxel(ctx.ray)
      if (armedType) {
        if (!hit) return
        const anchor = Picker.placementCell(hit)
        const ok = applyWithNotice([{ kind: 'place-object', objectType: armedType, anchor, rotation: 0 }])
        if (ok) setArmedType(null)
        return
      }
      if (selectedObject) {
        if (!hit) return
        const anchor = Picker.placementCell(hit)
        const ok = applyWithNotice([{ kind: 'move-object', objectId: selectedObject.id, anchor }])
        if (ok) setSelectedObject(null)
        return
      }
      const objectId = ctx.picker.pickObject(ctx.ray)
      if (objectId) {
        const object = engine.world?.doc.objects.find((o) => o.id === objectId)
        setSelectedObject({ id: objectId, label: object?.label ?? object?.objectType ?? objectId })
      }
    }
  }, [aiPending, applyWithNotice, armedType, blockTool, editing, engine.world, interact, rayAt, selectedBlock, selectedObject, tool])

  // 画布点击（位移小于阈值才算点击，避免与相机拖动冲突）与悬停高亮
  useEffect(() => {
    const canvas = engine.renderer.canvas
    if (!canvas) return
    let downX = 0, downY = 0
    let hoverRaf = 0
    const onPointerDown = (e: PointerEvent) => {
      downX = e.clientX
      downY = e.clientY
    }
    const onPointerUp = (e: PointerEvent) => {
      if (e.button !== 0) return
      if (Math.hypot(e.clientX - downX, e.clientY - downY) <= CLICK_SLOP_PX) handleClick(e.clientX, e.clientY)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (hoverRaf) return
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0
        const feedback = engine.feedback
        if (!feedback) return
        if (tool !== 'block' || aiPending) {
          feedback.setHover(null)
          return
        }
        const ctx = rayAt(e.clientX, e.clientY)
        const hit = ctx?.picker.pickVoxel(ctx.ray)
        feedback.setHover(hit ? (blockTool === 'dig' ? hit.at : Picker.placementCell(hit)) : null)
      })
    }
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointermove', onPointerMove)
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointermove', onPointerMove)
      if (hoverRaf) cancelAnimationFrame(hoverRaf)
      engine.feedback?.setHover(null)
    }
  }, [engine, tool, blockTool, aiPending, handleClick, rayAt])

  // HTML5 拖拽放置
  useEffect(() => {
    const canvas = engine.renderer.canvas
    if (!canvas) return
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('application/x-voxel-object')) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      const objectType = e.dataTransfer?.getData('application/x-voxel-object')
      if (!objectType) return
      e.preventDefault()
      const ctx = rayAt(e.clientX, e.clientY)
      const hit = ctx?.picker.pickVoxel(ctx.ray)
      if (!hit) return
      applyWithNotice([{ kind: 'place-object', objectType, anchor: Picker.placementCell(hit), rotation: 0 }])
    }
    canvas.addEventListener('dragover', onDragOver)
    canvas.addEventListener('drop', onDrop)
    return () => {
      canvas.removeEventListener('dragover', onDragOver)
      canvas.removeEventListener('drop', onDrop)
    }
  }, [engine, applyWithNotice, rayAt])

  const dismissAiGhost = () => {
    aiGhost.current?.dismiss()
    aiGhost.current = null
  }

  const handleAiPreview = (ops: EditOperation[]) => {
    setAiError(null)
    const doc = engine.world?.doc
    if (!doc) return
    const issues = validateEdit(doc, ops)
    if (issues.length > 0) {
      setAiError(`AI 方案未通过校验：${issues[0].message}`)
      return
    }
    dismissAiGhost()
    aiGhost.current = engine.feedback?.showGhost(ops) ?? null
    setAiPending(ops)
  }

  const handleAiConfirm = () => {
    if (!aiPending) return
    const ok = applyWithNotice(aiPending)
    if (ok) {
      dismissAiGhost()
      setAiPending(null)
    }
  }

  const handleAiCancel = () => {
    dismissAiGhost()
    setAiPending(null)
  }

  const toolButton = (id: Tool, label: string) => (
    <button
      key={id}
      data-testid={`voxel-tool-${id}`}
      className={`rounded px-3 py-1.5 ${tool === id ? 'bg-sky-600 text-white' : 'bg-zinc-700/70 text-zinc-300'}`}
      onClick={() => {
        setTool(tool === id ? null : id)
        setArmedType(null)
        setSelectedObject(null)
        engine.feedback?.setHover(null)
      }}
    >
      {label}
    </button>
  )

  return (
    <div className="pointer-events-none absolute inset-0" data-testid="voxel-editor">
      <div className="pointer-events-auto absolute left-3 top-20 flex flex-col gap-2">
        {editing && tool === 'warehouse' && (
          <WarehousePanel
            armedType={armedType}
            onPick={(t) => setArmedType(armedType === t ? null : t)}
            selectedObject={selectedObject}
            onRemoveSelected={() => {
              if (selectedObject && applyWithNotice([{ kind: 'remove-object', objectId: selectedObject.id }])) setSelectedObject(null)
            }}
            onDeselect={() => setSelectedObject(null)}
          />
        )}
        {editing && tool === 'block' && engine.registry && (
          <BlockPalette
            registry={engine.registry}
            selected={selectedBlock}
            onSelect={setSelectedBlock}
            tool={blockTool}
            onToolChange={setBlockTool}
          />
        )}
        {editing && tool === 'ai' && (
          <AiEditPanel
            planEdits={planEdits}
            onPreview={handleAiPreview}
            onConfirm={handleAiConfirm}
            onCancel={handleAiCancel}
            pending={aiPending !== null}
            error={aiError}
          />
        )}
        {editing && tool === 'world' && (
          <WorldPanel engine={engine} controller={controller} />
        )}
      </div>
      {editing && (
        <div className="pointer-events-auto absolute bottom-3 right-3 flex gap-1 text-xs" data-testid="voxel-editor-toolbar">
          {toolButton('warehouse', '物体仓库')}
          {toolButton('block', '方块')}
          {toolButton('ai', 'AI 改造')}
          {toolButton('world', '世界')}
        </div>
      )}
      {rejection && (
        <div className="pointer-events-auto absolute bottom-14 right-3 max-w-xs rounded bg-red-900/80 px-3 py-2 text-xs text-red-100" data-testid="voxel-edit-rejected">
          {rejection}
        </div>
      )}
    </div>
  )
}
