import { useCallback, useEffect, useRef, useState } from 'react'
import { validateEdit, type EditOperation, type VoxelCoord } from '@possibility/voxel-contract'
import type { VoxelEngine } from '../engine'
import { Picker } from '../engine'
import type { EditController } from '../bridge/edit-controller'
import WarehousePanel from './WarehousePanel'
import AssetPanel from './AssetPanel'
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

type Tool = 'warehouse' | 'asset' | 'ai' | 'world'

const CLICK_SLOP_PX = 6

/** 拖动中的摆放:原始位置用于取消复原 */
interface AssetDrag {
  placementId: string
  originAnchor: VoxelCoord
  originRotation: 0 | 1 | 2 | 3
  dragging: boolean
}

/** 编辑器编排：物体仓库 / 资产摆放 / AI 编辑 / 世界设置，全部归约到 EditController（F15/F16/F17；S2b F1-F3） */
export default function VoxelEditor({ engine, controller, planEdits, interact, editing = true }: VoxelEditorProps) {
  const [tool, setTool] = useState<Tool | null>(null)
  const [armedType, setArmedType] = useState<string | null>(null)
  const [armedAssetId, setArmedAssetId] = useState<string | null>(null)
  const [selectedObject, setSelectedObject] = useState<{ id: string; label: string } | null>(null)
  const [selectedPlacement, setSelectedPlacement] = useState<{ id: string; label: string } | null>(null)
  const [aiPending, setAiPending] = useState<EditOperation[] | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [rejection, setRejection] = useState<string | null>(null)
  const aiGhost = useRef<{ dismiss(): void } | null>(null)
  const assetDrag = useRef<AssetDrag | null>(null)

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

  const placementOf = useCallback((placementId: string) => {
    return engine.world?.doc.assetPlacements?.find((p) => p.id === placementId) ?? null
  }, [engine])

  const selectPlacement = useCallback((placementId: string | null) => {
    if (!placementId) {
      setSelectedPlacement(null)
      engine.feedback?.setAssetSelected(null)
      return
    }
    const placement = placementOf(placementId)
    setSelectedPlacement({ id: placementId, label: placement?.assetId ?? placementId })
    engine.feedback?.setAssetSelected(placementId)
  }, [engine, placementOf])

  /** 摆放校验预检(ghost 着色/拖动落点判定) */
  const placementIssues = useCallback((ops: EditOperation[]) => {
    const doc = engine.world?.doc
    if (!doc) return []
    return validateEdit(doc, ops, undefined, engine.assetsManifest ?? undefined)
  }, [engine])

  const handleClick = useCallback((clientX: number, clientY: number) => {
    if (aiPending) return // 预览待确认期间锁定画布编辑
    if (tool === null) {
      interact?.(clientX, clientY) // 观察模式：居民 / 地点 / 空间导航
      return
    }
    if (!editing) return
    const ctx = rayAt(clientX, clientY)
    if (!ctx) return
    if (tool === 'asset') {
      if (armedAssetId) {
        const hit = ctx.picker.pickVoxel(ctx.ray)
        if (!hit) return
        const anchor = Picker.placementCell(hit)
        // 放置后保持 armed 可连续放置,Esc 解除
        applyWithNotice([{ kind: 'place-asset', assetId: armedAssetId, anchor, rotation: 0 }])
        return
      }
      if (selectedPlacement) {
        const placement = placementOf(selectedPlacement.id)
        if (!placement) {
          selectPlacement(null)
          return
        }
        const hit = ctx.picker.pickVoxel(ctx.ray)
        if (!hit) return
        const anchor = Picker.placementCell(hit)
        if (applyWithNotice([{ kind: 'move-asset', placementId: selectedPlacement.id, anchor }])) selectPlacement(null)
        return
      }
      const placementId = ctx.picker.pickAsset(ctx.ray)
      if (placementId) selectPlacement(placementId)
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
  }, [aiPending, applyWithNotice, armedAssetId, armedType, editing, engine.world, interact, placementOf, rayAt, selectPlacement, selectedObject, selectedPlacement, tool])

  // 画布点击（位移小于阈值才算点击，避免与相机拖动冲突）、悬停高亮、资产拖动
  useEffect(() => {
    const canvas = engine.renderer.canvas
    if (!canvas) return
    let downX = 0, downY = 0
    let hoverRaf = 0
    const onPointerDown = (e: PointerEvent) => {
      downX = e.clientX
      downY = e.clientY
      // 资产拖动起点:asset 工具、未 armed、有选中摆放时按住了资产则进入待拖动
      assetDrag.current = null
      if (tool === 'asset' && !armedAssetId && selectedPlacement && editing && !aiPending) {
        const ctx = rayAt(e.clientX, e.clientY)
        const hitId = ctx?.picker.pickAsset(ctx.ray)
        if (hitId && hitId === selectedPlacement.id) {
          const placement = placementOf(hitId)
          if (placement) {
            assetDrag.current = {
              placementId: hitId,
              originAnchor: { x: placement.anchor[0], y: placement.anchor[1], z: placement.anchor[2] },
              originRotation: placement.rotation,
              dragging: false,
            }
          }
        }
      }
    }
    const onPointerUp = (e: PointerEvent) => {
      if (e.button !== 0) return
      const drag = assetDrag.current
      assetDrag.current = null
      if (drag?.dragging) {
        // 拖动结束:落点合法则提交 move-asset,否则复原
        const ctx = rayAt(e.clientX, e.clientY)
        const hit = ctx?.picker.pickVoxel(ctx.ray)
        const anchor = hit ? Picker.placementCell(hit) : null
        const placement = placementOf(drag.placementId)
        const ok = anchor && placement
          && placementIssues([{ kind: 'move-asset', placementId: drag.placementId, anchor }]).length === 0
          && applyWithNotice([{ kind: 'move-asset', placementId: drag.placementId, anchor }])
        if (!ok && placement) {
          engine.assets.previewTransform(drag.placementId, drag.originAnchor, drag.originRotation)
        }
        return
      }
      if (Math.hypot(e.clientX - downX, e.clientY - downY) <= CLICK_SLOP_PX) handleClick(e.clientX, e.clientY)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (hoverRaf) return
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0
        const feedback = engine.feedback
        // 拖动中:每帧增量预览(N1,不过 applyEditResult)
        const drag = assetDrag.current
        if (drag) {
          if (!drag.dragging) {
            if (Math.hypot(e.clientX - downX, e.clientY - downY) <= CLICK_SLOP_PX) return
            drag.dragging = true
          }
          const ctx = rayAt(e.clientX, e.clientY)
          const hit = ctx?.picker.pickVoxel(ctx.ray)
          if (hit) {
            const anchor = Picker.placementCell(hit)
            engine.assets.previewTransform(drag.placementId, anchor, drag.originRotation)
          }
          return
        }
        if (!feedback) return
        // armed 放置预览:ghost 跟随落点,预检着色
        if (tool === 'asset' && armedAssetId && !aiPending) {
          const ctx = rayAt(e.clientX, e.clientY)
          const hit = ctx?.picker.pickVoxel(ctx.ray)
          if (!hit) {
            feedback.dismissAssetGhost()
            return
          }
          const anchor = Picker.placementCell(hit)
          const entry = engine.assetsManifest?.assets[armedAssetId]
          const valid = placementIssues([{ kind: 'place-asset', assetId: armedAssetId, anchor, rotation: 0 }]).length === 0
          if (entry) feedback.showAssetGhost(armedAssetId, entry.footprint, anchor, 0, valid)
          return
        }
        feedback.dismissAssetGhost()
        feedback.setHover(null)
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
      engine.feedback?.dismissAssetGhost()
    }
  }, [engine, tool, armedAssetId, aiPending, editing, selectedPlacement, handleClick, rayAt, placementIssues, applyWithNotice, placementOf])

  // Esc / R 键盘交互
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (assetDrag.current?.dragging) {
          // 取消拖动:复原并清除
          const drag = assetDrag.current
          engine.assets.previewTransform(drag.placementId, drag.originAnchor, drag.originRotation)
          assetDrag.current = null
          return
        }
        if (armedAssetId) {
          setArmedAssetId(null)
          engine.feedback?.dismissAssetGhost()
          return
        }
        if (selectedPlacement) selectPlacement(null)
        return
      }
      if ((e.key === 'r' || e.key === 'R') && tool === 'asset' && selectedPlacement && !assetDrag.current) {
        const placement = placementOf(selectedPlacement.id)
        if (!placement) return
        const rotation = ((placement.rotation + 1) % 4) as 0 | 1 | 2 | 3
        applyWithNotice([{
          kind: 'move-asset',
          placementId: selectedPlacement.id,
          anchor: { x: placement.anchor[0], y: placement.anchor[1], z: placement.anchor[2] },
          rotation,
        }])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [applyWithNotice, armedAssetId, engine, placementOf, selectPlacement, selectedPlacement, tool])

  // HTML5 拖拽放置(物体模板 + S2b 资产)
  useEffect(() => {
    const canvas = engine.renderer.canvas
    if (!canvas) return
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('application/x-voxel-object') || e.dataTransfer?.types.includes('application/x-voxel-asset')) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      const assetId = e.dataTransfer?.getData('application/x-voxel-asset')
      const objectType = e.dataTransfer?.getData('application/x-voxel-object')
      if (!assetId && !objectType) return
      e.preventDefault()
      const ctx = rayAt(e.clientX, e.clientY)
      const hit = ctx?.picker.pickVoxel(ctx.ray)
      if (!hit) return
      const anchor = Picker.placementCell(hit)
      if (assetId) applyWithNotice([{ kind: 'place-asset', assetId, anchor, rotation: 0 }])
      else if (objectType) applyWithNotice([{ kind: 'place-object', objectType, anchor, rotation: 0 }])
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
    const issues = validateEdit(doc, ops, undefined, engine.assetsManifest ?? undefined)
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
        setArmedAssetId(null)
        setSelectedObject(null)
        selectPlacement(null)
        engine.feedback?.setHover(null)
        engine.feedback?.dismissAssetGhost()
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
        {editing && tool === 'asset' && engine.assetsManifest && (
          <AssetPanel
            manifest={engine.assetsManifest}
            armedAssetId={armedAssetId}
            onPick={(id) => setArmedAssetId(armedAssetId === id ? null : id)}
            selectedPlacement={selectedPlacement}
            onRotateSelected={() => {
              const placement = selectedPlacement ? placementOf(selectedPlacement.id) : null
              if (!selectedPlacement || !placement) return
              const rotation = ((placement.rotation + 1) % 4) as 0 | 1 | 2 | 3
              applyWithNotice([{
                kind: 'move-asset',
                placementId: selectedPlacement.id,
                anchor: { x: placement.anchor[0], y: placement.anchor[1], z: placement.anchor[2] },
                rotation,
              }])
            }}
            onRemoveSelected={() => {
              if (selectedPlacement && applyWithNotice([{ kind: 'remove-asset', placementId: selectedPlacement.id }])) selectPlacement(null)
            }}
            onDeselect={() => selectPlacement(null)}
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
          {toolButton('asset', '资产')}
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
