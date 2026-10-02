import { useCallback, useEffect, useRef, useState } from 'react'
import type { SceneLifeOverlay } from '@possibility/scene-contract'
import type { EditOperation, VoxelDocument, WorldEvent } from '@possibility/voxel-contract'
import { nearestStandable, VoxelEngine, WebGL2UnavailableError, type OrbitPose } from './engine'
import { EditController } from './bridge/edit-controller'
import { InteractionRouter } from './bridge/interaction-router'
import { OverlayDriver } from './bridge/overlay-driver'
import { PlatformGate } from './bridge/platform-gate'
import { registerEngineProbe, unregisterEngineProbe, type VoxelProbeTarget } from './probe-registry'
import VoxelEditor from './ui/VoxelEditor'
import WalkHud from './ui/WalkHud'
import EventOverlay, { useEventClickRouting } from './ui/EventOverlay'
import EventPanel from './ui/EventPanel'
import { useCanvasClick } from './ui/use-canvas-click'

export interface VoxelViewportProps {
  document: VoxelDocument
  /** 生活覆盖层（时间 / 天气 / 居民活动），变化时驱动引擎 */
  overlay?: SceneLifeOverlay | null
  /** S4 世界模拟:生产路径事件源(蒸馏投影);undefined = 文档事件驱动(dev fixture/存档) */
  events?: WorldEvent[] | null
  /** 编辑入口（create 模式）；移动端由 PlatformGate 兜底隐藏 */
  editable?: boolean
  /** AI 编辑规划（产品层接 /api/voxel/edit-plan）；视口注入内部引擎，共享 plan-edits.ts 帮助器可直接传入 */
  planEdits?: (engine: VoxelEngine, intent: string) => Promise<EditOperation[]>
  onSave?: (doc: VoxelDocument) => void
  onEnterSpace?: (spaceId: string) => void
  onSelectPerson?: (personId: string) => void
  onSelectLocation?: (locationName: string, objectId: string) => void
  /** S4 身份统一:事件面板参与者显示名(personId → name) */
  personNames?: Record<string, string>
  /** 实例标识(S1 分屏):探针注册表按此隔离;缺省 'main' 保持单视口现状 */
  instanceId?: string
  /** 主实例标记:`__voxelEngine` 别名写给谁;缺省 = instanceId === 'main' */
  probePrimary?: boolean
  /** 受控 orbit 位姿(相机联动);缺省非受控 = 现状。walk 模式下被引擎忽略 */
  cameraPose?: OrbitPose | null
  /** orbit 位姿变化回调(含初始构图);walk 模式不回调 */
  onCameraChange?: (pose: OrbitPose) => void
  /** 视角模式切换回调(分屏联动需要在 walk 时失效) */
  onCameraModeChange?: (mode: 'orbit' | 'walk') => void
}

interface LoadProgress { percent: number; label: string }

/** 位姿近似相等(回显抑制:受控写入不再触发联动回环) */
function poseNearlyEqual(a: OrbitPose, b: OrbitPose): boolean {
  const eps = 1e-3
  return Math.abs(a.theta - b.theta) < eps
    && Math.abs(a.phi - b.phi) < eps
    && Math.abs(a.distance - b.distance) < eps
    && Math.abs(a.target.x - b.target.x) < eps
    && Math.abs(a.target.y - b.target.y) < eps
    && Math.abs(a.target.z - b.target.z) < eps
}

/**
 * 体素视口（T30）：世界页唯一渲染挂载点（2D 视口已于 S2 退役）。
 * 引擎装配 + N4 分阶段加载进度 + 覆盖层/交互/编辑的桥接。
 */
export default function VoxelViewport({
  document: doc, overlay, events, editable = false, planEdits, onSave,
  onEnterSpace, onSelectPerson, onSelectLocation, personNames,
  instanceId = 'main', probePrimary, cameraPose, onCameraChange, onCameraModeChange,
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
  const onCameraChangeRef = useRef(onCameraChange)
  onCameraChangeRef.current = onCameraChange
  const onCameraModeChangeRef = useRef(onCameraModeChange)
  onCameraModeChangeRef.current = onCameraModeChange
  const [controller, setController] = useState<EditController | null>(null)
  const [progress, setProgress] = useState<LoadProgress | null>({ percent: 5, label: '正在准备渲染环境…' })
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gate] = useState(() => new PlatformGate())
  // S2b 双视角:orbit 上帝(建造)⇄ walk 第一视角(游览验收)
  const [cameraMode, setCameraMode] = useState<'orbit' | 'walk'>('orbit')
  const [modeNotice, setModeNotice] = useState<string | null>(null)
  const primary = probePrimary ?? instanceId === 'main'

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const engine = new VoxelEngine()
    engineRef.current = engine
    // S3a:滚轮/pinch 驱动的落地/升空不经过 toggle——引擎补间完成后主动推送,
    // 同步 HUD 与点击门控(编辑仅 orbit);toggle 的乐观 setState 与此幂等
    engine.onCameraModeChange = (mode) => {
      setCameraMode(mode)
      onCameraModeChangeRef.current?.(mode)
    }
    const probes = window as unknown as VoxelProbeTarget
    registerEngineProbe(probes, instanceId, engine, primary)
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
            // S1 起地点可绑定资产摆放(GLB 建筑):物体查不到时取摆放锚点
            const placement = !object && binding
              ? (doc.assetPlacements ?? []).find((p) => p.id === binding.objectId) : null
            const anchor = object?.anchor ?? (placement ? { x: placement.anchor[0], y: placement.anchor[1], z: placement.anchor[2] } : null)
            if (!anchor || !engine.world || !engine.registry) return null
            return nearestStandable(engine.world, engine.registry, { x: anchor.x, y: anchor.y + 1, z: anchor.z })
          },
          spawnFallback: { x: Math.floor(doc.size.width / 2), y: 1, z: Math.floor(doc.size.depth / 2) },
          // S4 环境漫步:可站立校正 + reduced-motion 降级(日程驱动移动优先,见 OverlayDriver)
          resolveStandable: (coord) => (engine.world && engine.registry
            ? nearestStandable(engine.world, engine.registry, coord) : null),
          reducedMotion: () => engine.motion.isReduced(),
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
      unregisterEngineProbe(probes, instanceId, engine)
    }
    // editable/onSave/gate 装配一次；doc 变化时整体重挂载
  }, [doc, editable, gate, onSave, instanceId, primary])

  // 生活覆盖层 → 引擎（时间 / 天气 / 居民）
  useEffect(() => {
    if (ready && overlay) driverRef.current?.apply(overlay)
  }, [ready, overlay])

  // S4 世界模拟:生产路径事件下发(bootstrap/SSE 刷新 → 无 reload 更新披露层)
  // 快照刷新频繁(每拍),事件集未变时跳过披露层重建;文档重载(引擎重建)后强制重放
  const lastEventsKeyRef = useRef<string | null>(null)
  useEffect(() => { lastEventsKeyRef.current = null }, [doc])
  useEffect(() => {
    if (!ready || !events) return
    const key = events.map(e => `${e.id}:${e.timeWindow.end}:${e.label}`).join('|')
    if (key === lastEventsKeyRef.current) return
    lastEventsKeyRef.current = key
    engineRef.current?.setEvents(events)
  }, [ready, events])

  // 受控相机(S1 分屏联动):外部 pose 变化 → 写入引擎(回显由近似相等抑制)
  useEffect(() => {
    if (!ready || !cameraPose) return
    const engine = engineRef.current
    if (!engine) return
    const current = engine.getOrbitPose()
    if (!current || !poseNearlyEqual(current, cameraPose)) engine.setOrbitPose(cameraPose)
  }, [ready, cameraPose])

  // 相机变化上报:每帧读位姿,变化才回调;walk 模式(getOrbitPose null)不回调
  useEffect(() => {
    const engine = engineRef.current
    if (!ready || !engine) return
    let last: OrbitPose | null = null
    return engine.addUpdatable({
      update: () => {
        const pose = engine.getOrbitPose()
        if (!pose) { last = null; return }
        if (!last || !poseNearlyEqual(last, pose)) {
          last = pose
          onCameraChangeRef.current?.(pose)
        }
      },
    })
  }, [ready])

  // 只读(无编辑器)时的观察点击:S3b 事件路由优先,未命中走既有观察链
  const eventRouting = useEventClickRouting(engineRef.current)
  const handleObserveClick = useCallback((x: number, y: number) => {
    if (eventRouting.routeAt(x, y)) return
    interactRef.current(x, y)
  }, [eventRouting.routeAt])
  // S2:只有编辑器 UI 真正渲染(controller + planEdits)时才让位编辑;owner 无编辑器时观察点击必须可用
  useCanvasClick(engineRef.current, ready && !(controller && planEdits) && cameraMode === 'orbit', handleObserveClick)
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
      onCameraModeChangeRef.current?.(next)
    } else {
      setModeNotice(result.reason ?? '当前无法切换视角')
    }
  }, [cameraMode])
  useEffect(() => {
    // 'V' 键全局监听仅主实例挂载(S1 实例化):分屏实例经 WalkHud 按钮切换,不抢键盘
    if (!gate.showFirstPerson || instanceId !== 'main') return
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyV' || e.repeat) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      toggleCameraMode()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [gate, toggleCameraMode, instanceId])
  // 切换失败提示短暂展示
  useEffect(() => {
    if (!modeNotice) return
    const timer = setTimeout(() => setModeNotice(null), 3000)
    return () => clearTimeout(timer)
  }, [modeNotice])

  return (
    <div className="relative h-full min-h-[430px] w-full overflow-hidden rounded-2xl bg-zinc-950" data-testid="voxel-viewport" data-voxel-instance={instanceId}>
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
      {ready && <EventOverlay engine={engineRef.current} onSelect={eventRouting.routeById} />}
      {ready && (
        <EventPanel
          event={eventRouting.panelEventId ? engineRef.current?.getEventById(eventRouting.panelEventId) ?? null : null}
          phase={eventRouting.panelPhase === 'active' ? 'active' : 'trace'}
          onClose={() => eventRouting.setPanelEventId(null)}
          personNames={personNames}
          onSelectPerson={onSelectPerson ? (personId) => callbacksRef.current.onSelectPerson?.(personId) : undefined}
        />
      )}
      {ready && controller && planEdits && cameraMode === 'orbit' && (
        <VoxelEditor
          engine={engineRef.current!}
          controller={controller}
          planEdits={(intent) => planEdits(engineRef.current!, intent)}
          interact={(x, y) => interactRef.current(x, y)}
          editing={gate.showEditing}
        />
      )}
    </div>
  )
}
