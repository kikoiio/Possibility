import { useCallback, useEffect, useRef, useState } from 'react'
import type { SceneLifeOverlay } from '@possibility/scene-contract'
import type { EditOperation, VoxelDocument } from '@possibility/voxel-contract'
import { nearestStandable, VoxelEngine, WebGL2UnavailableError } from './engine'
import { EditController } from './bridge/edit-controller'
import { InteractionRouter } from './bridge/interaction-router'
import { OverlayDriver } from './bridge/overlay-driver'
import { PlatformGate } from './bridge/platform-gate'
import VoxelEditor from './ui/VoxelEditor'
import WalkHud from './ui/WalkHud'
import { useCanvasClick } from './ui/use-canvas-click'

export interface VoxelViewportProps {
  document: VoxelDocument
  /** 生活覆盖层（时间 / 天气 / 居民活动），变化时驱动引擎 */
  overlay?: SceneLifeOverlay | null
  /** 编辑入口（create 模式）；移动端由 PlatformGate 兜底隐藏 */
  editable?: boolean
  planEdits?: (intent: string) => Promise<EditOperation[]>
  onSave?: (doc: VoxelDocument) => void
  onEnterSpace?: (spaceId: string) => void
  onSelectPerson?: (personId: string) => void
  onSelectLocation?: (locationName: string, objectId: string) => void
}

interface LoadProgress { percent: number; label: string }

/**
 * 体素视口（T30）：替换 WorldCanvasViewport 的挂载点。
 * 引擎装配 + N4 分阶段加载进度 + 覆盖层/交互/编辑的桥接。
 */
export default function VoxelViewport({
  document: doc, overlay, editable = false, planEdits, onSave,
  onEnterSpace, onSelectPerson, onSelectLocation,
}: VoxelViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<VoxelEngine | null>(null)
  const driverRef = useRef<OverlayDriver | null>(null)
  const interactRef = useRef<(x: number, y: number) => boolean>(() => false)
  const callbacksRef = useRef({ onEnterSpace, onSelectPerson, onSelectLocation })
  callbacksRef.current = { onEnterSpace, onSelectPerson, onSelectLocation }
  // StrictMode 双挂载下第二个驱动也要拿到当前 overlay（ready 已 true，变更 effect 不会再触发）
  const overlayRef = useRef(overlay)
  overlayRef.current = overlay
  const [controller, setController] = useState<EditController | null>(null)
  const [progress, setProgress] = useState<LoadProgress | null>({ percent: 5, label: '正在准备渲染环境…' })
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gate] = useState(() => new PlatformGate())
  // S2b 双视角:orbit 上帝(建造)⇄ walk 第一视角(游览验收)
  const [cameraMode, setCameraMode] = useState<'orbit' | 'walk'>('orbit')
  const [modeNotice, setModeNotice] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const engine = new VoxelEngine()
    engineRef.current = engine
    ;(window as unknown as { __voxelEngine?: VoxelEngine }).__voxelEngine = engine
    let cancelled = false
    void (async () => {
      try {
        engine.mount(canvas)
        // N4：分阶段进度反馈；让出一帧使进度先渲染，再做同步烘焙
        setProgress({ percent: 15, label: '正在加载纹理图集…' })
        try {
          await engine.loadAssets(doc.theme)
        } catch {
          await engine.loadAssets(doc.theme, { placeholder: true })
        }
        if (cancelled) return
        setProgress({ percent: 60, label: '正在搭建世界、烘焙光照…' })
        await new Promise((resolve) => requestAnimationFrame(resolve))
        engine.loadDocument(doc)
        if (cancelled) return
        engine.start()

        driverRef.current = new OverlayDriver({
          engine,
          resolveLocation: (name) => {
            const binding = doc.locations.find((l) => l.name === name)
            const object = binding ? doc.objects.find((o) => o.id === binding.objectId) : null
            if (!object || !engine.world || !engine.registry) return null
            return nearestStandable(engine.world, engine.registry, { x: object.anchor.x, y: object.anchor.y + 1, z: object.anchor.z })
          },
          spawnFallback: { x: Math.floor(doc.size.width / 2), y: 1, z: Math.floor(doc.size.depth / 2) },
        })

        const router = new InteractionRouter(engine, {
          onPerson: (personId) => callbacksRef.current.onSelectPerson?.(personId),
          onLocation: (objectId, locationName) => callbacksRef.current.onSelectLocation?.(locationName, objectId),
          onEnterSpace: (spaceId) => callbacksRef.current.onEnterSpace?.(spaceId),
        })
        interactRef.current = (x, y) => router.handleClick(x, y)
        if (overlayRef.current) driverRef.current.apply(overlayRef.current)

        if (editable && gate.showEditing && onSave) {
          setController(new EditController({ engine, canEdit: gate.canEdit, save: onSave }))
        }
        setReady(true)
        setProgress(null)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof WebGL2UnavailableError ? err.message : `体素世界加载失败：${String(err)}`)
        }
      }
    })()
    return () => {
      cancelled = true
      driverRef.current = null
      interactRef.current = () => false
      engine.dispose()
      engineRef.current = null
      delete (window as unknown as { __voxelEngine?: VoxelEngine }).__voxelEngine
    }
    // editable/onSave/gate 装配一次；doc 变化时整体重挂载
  }, [doc, editable, gate, onSave])

  // 生活覆盖层 → 引擎（时间 / 天气 / 居民）
  useEffect(() => {
    if (ready && overlay) driverRef.current?.apply(overlay)
  }, [ready, overlay])

  // 只读(无编辑器)时的观察点击
  const handleObserveClick = useCallback((x: number, y: number) => { interactRef.current(x, y) }, [])
  useCanvasClick(engineRef.current, ready && !controller && cameraMode === 'orbit', handleObserveClick)
  // 第一视角:点击 = 屏幕中心(准星)射线(F4,只读选中;编辑入口不渲染)
  const handleWalkClick = useCallback(() => {
    const canvas = engineRef.current?.renderer.canvas
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    interactRef.current(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }, [])
  useCanvasClick(engineRef.current, ready && cameraMode === 'walk', handleWalkClick)

  // 模式切换:按钮 / V 键(F1);失败(落点搜索不到)给出提示不切换
  const toggleCameraMode = useCallback(() => {
    const engine = engineRef.current
    if (!engine) return
    const next = cameraMode === 'orbit' ? 'walk' : 'orbit'
    const result = engine.setCameraMode(next)
    if (result.ok) {
      setCameraMode(next)
      setModeNotice(null)
    } else {
      setModeNotice(result.reason ?? '当前无法切换视角')
    }
  }, [cameraMode])
  useEffect(() => {
    if (!gate.showFirstPerson) return
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyV' || e.repeat) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      toggleCameraMode()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [gate, toggleCameraMode])
  // 切换失败提示短暂展示
  useEffect(() => {
    if (!modeNotice) return
    const timer = setTimeout(() => setModeNotice(null), 3000)
    return () => clearTimeout(timer)
  }, [modeNotice])

  return (
    <div className="relative h-full min-h-[430px] w-full overflow-hidden rounded-2xl bg-zinc-950" data-testid="voxel-viewport">
      {/* absolute 撑满 relative 容器：h-full 在仅靠 min-height 撑高的容器里会塌成 0，引擎按画布自身尺寸渲染 */}
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" data-testid="voxel-viewport-canvas" />
      {progress && !error && (
        <div className="absolute inset-0 grid place-items-center bg-zinc-950/70 text-sm text-zinc-200" data-testid="voxel-viewport-loading">
          <div className="flex w-60 flex-col items-center gap-3">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-700">
              <div className="h-full rounded-full bg-sky-500 transition-all duration-300" style={{ width: `${progress.percent}%` }} data-testid="voxel-viewport-progress-bar" />
            </div>
            <p data-testid="voxel-viewport-progress">{progress.label}</p>
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 grid place-items-center p-8 text-center text-sm text-zinc-200" data-testid="voxel-viewport-error">
          {error}
        </div>
      )}
      {ready && gate.showFirstPerson && (
        <WalkHud mode={cameraMode} onToggle={toggleCameraMode} notice={modeNotice} />
      )}
      {ready && controller && planEdits && cameraMode === 'orbit' && (
        <VoxelEditor
          engine={engineRef.current!}
          controller={controller}
          planEdits={planEdits}
          interact={(x, y) => interactRef.current(x, y)}
          editing={gate.showEditing}
        />
      )}
    </div>
  )
}
