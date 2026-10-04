/**
 * N2D1 T32–T33：指针输入状态机与 DOM 接入。
 *
 * 纯指针状态机，不导入 PixiJS；DOM 接入层只消费宿主提供的 HTMLElement 指针事件，
 * 通过回调输出平移/缩放意图与 ViewportEvent，相机状态始终由视口持有（T34 接入）。
 *
 * 状态机（phase）与转移：
 * - idle ──pointerdown──▶ single(pending)：记录起点/起始时间，捕获指针。
 * - single(pending) ──位移 > CLICK_MOVE_THRESHOLD_PX──▶ single(dragging)：
 *   普通模式发出一次 free-pan 并按增量回调 onPan；建筑移动模式保留按下点与
 *   建筑脚点的偏移，按拖动的世界坐标差更新目标并吸附整数格。
 * - single(pending) ──pointerup──▶ idle：位移 ≤ 阈值且时长 ≤ CLICK_TIME_LIMIT_MS
 *   判为点击：普通模式做 hitPolygon 拾取并发 select（命中或 null）；移动模式
 *   点击不选中、不应用，不发任何事件。长按（超时长）不算点击。
 * - single ──第二指 pointerdown──▶ pinch：取消进行中的点击判定，停发
 *   move-target，记录双指中心与距离。
 * - pinch ──pointermove──▶ pinch：中心平移经 onPan 输出、距离比例经
 *   onZoom(factor, center) 输出；中心累计位移超阈值时补发一次 free-pan。
 *   双指手势永远不触发 move-target 或 select。
 * - pinch ──任一指 up/cancel──▶ single(dragging)：剩余指针从当前位置重新起算，
 *   重置为拖动而非点击，避免视图跳动与误触选中。
 * - single/pinch ──pointercancel 或离开宿主──▶ 清理对应指针（single 直接回 idle）。
 * - 第三指及以上一律忽略，不追踪。
 *
 * 拾取规则：屏幕点先 removeCamera 再减去各对象脚点投影点，得到以素材脚点为
 * 原点的局部坐标，对 hitPolygon 做射线法包含测试；命中多个时按绘制深度取最前
 * （绝对 sortAnchor = origin + sortAnchor，深度 = anchor.x + anchor.z 越大越靠前，
 * 等深取清单中先出现者）。
 *
 * 宿主职责（T34）：为元素设置 CSS `touch-action: none`，否则浏览器会接管触摸
 * 滚动/缩放手势；元素需自身提供布局尺寸。
 * 对应已批准 plan.md「视口与输入模块」与 task.md T32/T33。
 */

import { gridToProjected, removeCamera, screenToGrid, snapToGrid, type Camera } from './projection'
import type {
  AssetDefinition,
  GridPoint,
  PixelPoint,
  Selection,
  ViewportEvent,
} from './types'

/** 点击判定的最大位移（屏幕像素）：超过即视为拖动。 */
export const CLICK_MOVE_THRESHOLD_PX = 6
/** 点击判定的最长按压时长（毫秒）：超过视为长按，不触发选中。 */
export const CLICK_TIME_LIMIT_MS = 500
/** 双指最小距离（屏幕像素）：低于该距离不计算缩放比例，避免除零与抖动。 */
const MIN_PINCH_DISTANCE_PX = 1

/** 纯指针采样：DOM 接入层把 PointerEvent 换算为元素局部坐标后传入状态机。 */
export interface PointerSample {
  readonly pointerId: number
  readonly x: number
  readonly y: number
  readonly timeStamp: number
}

/** 可拾取对象：selection 为命中后随 select 事件输出的选择。 */
export interface PickTarget {
  readonly id: string
  readonly selection: Selection
  readonly origin: GridPoint
  readonly assetId: string
}

/** 状态机输出与查询回调；相机/素材/模式由宿主即时提供，状态机不缓存。 */
export interface PointerInputHandlers {
  getCamera(): Camera
  getPickTargets(): readonly PickTarget[]
  getAssetDefinition(assetId: string): AssetDefinition | null
  isMoveMode(): boolean
  getMoveBuildingId(): string | null
  onEvent(event: ViewportEvent): void
  /** 屏幕像素平移增量（普通拖动或双指中心平移），由视口应用到相机。 */
  onPan(delta: PixelPoint): void
  /** 双指缩放比例与缩放中心（屏幕像素），由视口应用到相机。 */
  onZoom(factor: number, center: PixelPoint): void
}

export type PointerInputPhase = 'idle' | 'pending' | 'dragging' | 'pinch'

/** 射线法点在多边形内测试（even-odd）；顶点数不足 3 时恒为 false。 */
export function pointInPolygon(point: PixelPoint, polygon: readonly PixelPoint[]): boolean {
  if (polygon.length < 3) return false
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]
    const b = polygon[j]
    const crosses = a.y > point.y !== b.y > point.y
    if (crosses) {
      const xAtY = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      if (point.x < xAtY) inside = !inside
    }
  }
  return inside
}

/** 对象绘制深度：绝对 sortAnchor 的投影纵深（x + z），越大越靠前。 */
function pickDepth(target: PickTarget, asset: AssetDefinition): number {
  return target.origin.x + asset.sortAnchor.x + (target.origin.z + asset.sortAnchor.z)
}

/**
 * 屏幕点拾取：移除相机后相对各对象脚点投影点取局部坐标，做 hitPolygon
 * 包含测试，按绘制深度取最前者；无命中或非有限输入返回 null。
 */
export function resolvePick(
  screen: PixelPoint,
  camera: Camera,
  targets: readonly PickTarget[],
  getAssetDefinition: (assetId: string) => AssetDefinition | null,
): Selection | null {
  if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y)) return null
  const projected = removeCamera(screen, camera)
  if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null
  let best: Selection | null = null
  let bestDepth = Number.NEGATIVE_INFINITY
  for (const target of targets) {
    const asset = getAssetDefinition(target.assetId)
    if (!asset) continue
    const foot = gridToProjected(target.origin)
    const local = { x: projected.x - foot.x, y: projected.y - foot.y }
    if (!pointInPolygon(local, asset.hitPolygon)) continue
    const depth = pickDepth(target, asset)
    if (depth > bestDepth) {
      bestDepth = depth
      best = target.selection
    }
  }
  return best
}

interface TrackedPointer {
  readonly id: number
  readonly startX: number
  readonly startY: number
  readonly startTime: number
  lastX: number
  lastY: number
  maxDisplacement: number
  /** 抓取点相对建筑脚点的格坐标偏移；移动时保留建筑与指针的相对位置。 */
  moveOffset: GridPoint | null
  /** 移动模式按下点是否实际命中当前建筑；空地拖动仍用于平移地图。 */
  moveBuildingCaptured: boolean
}

type PhaseState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'single'; readonly pointer: TrackedPointer; dragging: boolean }
  | {
      readonly kind: 'pinch'
      readonly first: TrackedPointer
      readonly second: TrackedPointer
      readonly startCenter: PixelPoint
      lastCenter: PixelPoint
      lastDistance: number
      panNotified: boolean
    }

function trackPointer(
  sample: PointerSample,
  moveOffset: GridPoint | null = null,
  moveBuildingCaptured = false,
): TrackedPointer {
  return {
    id: sample.pointerId,
    startX: sample.x,
    startY: sample.y,
    startTime: sample.timeStamp,
    lastX: sample.x,
    lastY: sample.y,
    maxDisplacement: 0,
    moveOffset,
    moveBuildingCaptured,
  }
}

function updateTracked(pointer: TrackedPointer, sample: PointerSample): void {
  pointer.lastX = sample.x
  pointer.lastY = sample.y
  const displacement = Math.hypot(sample.x - pointer.startX, sample.y - pointer.startY)
  if (displacement > pointer.maxDisplacement) pointer.maxDisplacement = displacement
}

function midpoint(a: TrackedPointer, b: TrackedPointer): PixelPoint {
  return { x: (a.lastX + b.lastX) / 2, y: (a.lastY + b.lastY) / 2 }
}

function distanceBetween(a: TrackedPointer, b: TrackedPointer): number {
  return Math.hypot(a.lastX - b.lastX, a.lastY - b.lastY)
}

function isFiniteSample(sample: PointerSample): boolean {
  return Number.isFinite(sample.x) && Number.isFinite(sample.y)
}

/** 纯指针状态机：不依赖 DOM，可独立驱动与测试。 */
export class PointerInputMachine {
  private phase: PhaseState = { kind: 'idle' }

  constructor(private readonly handlers: PointerInputHandlers) {}

  getPhase(): PointerInputPhase {
    switch (this.phase.kind) {
      case 'idle':
        return 'idle'
      case 'single':
        return this.phase.dragging ? 'dragging' : 'pending'
      case 'pinch':
        return 'pinch'
    }
  }

  hasPointer(pointerId: number): boolean {
    switch (this.phase.kind) {
      case 'idle':
        return false
      case 'single':
        return this.phase.pointer.id === pointerId
      case 'pinch':
        return this.phase.first.id === pointerId || this.phase.second.id === pointerId
    }
  }

  pointerDown(sample: PointerSample): void {
    if (!isFiniteSample(sample)) return
    if (this.phase.kind === 'idle') {
      const moveBuildingId = this.handlers.getMoveBuildingId()
      const building = moveBuildingId
        ? this.handlers.getPickTargets().find(
            (target) => target.selection.kind === 'building' && target.selection.buildingId === moveBuildingId,
          )
        : null
      const camera = this.handlers.getCamera()
      const point = screenToGrid(sample, camera)
      const selection = moveBuildingId
        ? resolvePick(sample, camera, this.handlers.getPickTargets(), this.handlers.getAssetDefinition)
        : null
      const moveBuildingCaptured = Boolean(
        building && selection?.kind === 'building' && selection.buildingId === moveBuildingId,
      )
      const moveOffset = moveBuildingCaptured && building
        ? { x: building.origin.x - point.x, z: building.origin.z - point.z }
        : null
      this.phase = {
        kind: 'single',
        pointer: trackPointer(sample, moveOffset, moveBuildingCaptured),
        dragging: false,
      }
      return
    }
    if (this.phase.kind === 'single') {
      if (this.phase.pointer.id === sample.pointerId) return
      // 单指已按下后再加一指：取消进行中的点击判定，转入双指手势。
      const first = this.phase.pointer
      const second = trackPointer(sample)
      const center = midpoint(first, second)
      this.phase = {
        kind: 'pinch',
        first,
        second,
        startCenter: center,
        lastCenter: center,
        lastDistance: distanceBetween(first, second),
        panNotified: false,
      }
    }
    // pinch 阶段忽略第三指及以上。
  }

  pointerMove(sample: PointerSample): void {
    if (!isFiniteSample(sample)) return
    const phase = this.phase
    if (phase.kind === 'single') {
      if (sample.pointerId !== phase.pointer.id) return
      const pointer = phase.pointer
      const prevX = pointer.lastX
      const prevY = pointer.lastY
      updateTracked(pointer, sample)
      if (!phase.dragging) {
        if (pointer.maxDisplacement <= CLICK_MOVE_THRESHOLD_PX) return
        phase.dragging = true
        if (!this.handlers.isMoveMode() || !pointer.moveBuildingCaptured) {
          this.handlers.onEvent({ type: 'free-pan' })
        }
      }
      if (this.handlers.isMoveMode() && pointer.moveBuildingCaptured) {
        this.emitMoveTarget({ x: sample.x, y: sample.y }, pointer.moveOffset)
      } else {
        this.handlers.onPan({ x: pointer.lastX - prevX, y: pointer.lastY - prevY })
      }
      return
    }
    if (phase.kind === 'pinch') {
      const tracked =
        sample.pointerId === phase.first.id
          ? phase.first
          : sample.pointerId === phase.second.id
            ? phase.second
            : null
      if (!tracked) return
      updateTracked(tracked, sample)
      const center = midpoint(phase.first, phase.second)
      const distance = distanceBetween(phase.first, phase.second)
      const centerDelta = {
        x: center.x - phase.lastCenter.x,
        y: center.y - phase.lastCenter.y,
      }
      if (centerDelta.x !== 0 || centerDelta.y !== 0) {
        this.handlers.onPan(centerDelta)
        if (!phase.panNotified) {
          const fromStart = Math.hypot(
            center.x - phase.startCenter.x,
            center.y - phase.startCenter.y,
          )
          if (fromStart > CLICK_MOVE_THRESHOLD_PX) {
            phase.panNotified = true
            this.handlers.onEvent({ type: 'free-pan' })
          }
        }
      }
      if (phase.lastDistance >= MIN_PINCH_DISTANCE_PX && distance >= MIN_PINCH_DISTANCE_PX) {
        const factor = distance / phase.lastDistance
        if (Number.isFinite(factor) && factor > 0 && factor !== 1) {
          this.handlers.onZoom(factor, center)
        }
      }
      phase.lastCenter = center
      phase.lastDistance = distance
    }
  }

  pointerUp(sample: PointerSample): void {
    const phase = this.phase
    if (phase.kind === 'single') {
      if (sample.pointerId !== phase.pointer.id) return
      const pointer = phase.pointer
      if (isFiniteSample(sample)) updateTracked(pointer, sample)
      if (!phase.dragging) {
        const duration = sample.timeStamp - pointer.startTime
        const isClick =
          pointer.maxDisplacement <= CLICK_MOVE_THRESHOLD_PX &&
          duration >= 0 &&
          duration <= CLICK_TIME_LIMIT_MS
        if (isClick) this.emitClick({ x: sample.x, y: sample.y })
      }
      this.phase = { kind: 'idle' }
      return
    }
    if (phase.kind === 'pinch') this.releasePinchPointer(sample.pointerId)
  }

  pointerCancel(sample: PointerSample): void {
    const phase = this.phase
    if (phase.kind === 'single') {
      if (sample.pointerId === phase.pointer.id) this.phase = { kind: 'idle' }
      return
    }
    if (phase.kind === 'pinch') this.releasePinchPointer(sample.pointerId)
  }

  /** 清理全部指针状态，不发任何事件（宿主 detach 或外部强制复位时使用）。 */
  cancelAll(): void {
    this.phase = { kind: 'idle' }
  }

  /** 双指变单指：剩余指针从当前位置重新起算，重置为拖动而非点击。 */
  private releasePinchPointer(pointerId: number): void {
    const phase = this.phase
    if (phase.kind !== 'pinch') return
    const remaining =
      pointerId === phase.first.id
        ? phase.second
        : pointerId === phase.second.id
          ? phase.first
          : null
    if (!remaining) return
    const reset: TrackedPointer = {
      id: remaining.id,
      startX: remaining.lastX,
      startY: remaining.lastY,
      startTime: remaining.startTime,
      lastX: remaining.lastX,
      lastY: remaining.lastY,
      maxDisplacement: 0,
      moveOffset: remaining.moveOffset,
      moveBuildingCaptured: remaining.moveBuildingCaptured,
    }
    this.phase = { kind: 'single', pointer: reset, dragging: true }
  }

  private emitClick(screen: PixelPoint): void {
    // 移动模式下点击不选中、不应用；应用/取消由显式按钮完成。
    if (this.handlers.isMoveMode()) return
    const selection = resolvePick(
      screen,
      this.handlers.getCamera(),
      this.handlers.getPickTargets(),
      this.handlers.getAssetDefinition,
    )
    this.handlers.onEvent({ type: 'select', selection })
  }

  private emitMoveTarget(screen: PixelPoint, moveOffset: GridPoint | null): void {
    const buildingId = this.handlers.getMoveBuildingId()
    if (!buildingId || !moveOffset) return
    const point = screenToGrid(screen, this.handlers.getCamera())
    const target = snapToGrid({ x: point.x + moveOffset.x, z: point.z + moveOffset.z })
    // 非有限输入被吸附拒绝时不发 move-target。
    if (!target) return
    this.handlers.onEvent({ type: 'move-target', buildingId, target })
  }
}

export interface PointerInputOptions extends PointerInputHandlers {
  /** 宿主元素：监听其指针事件，坐标换算为元素局部屏幕像素。 */
  readonly element: HTMLElement
}

export interface PointerInputController {
  attach(): void
  detach(): void
}

/**
 * DOM 接入层（T32/T33 交付、T34 由视口调用）：把 PointerEvent 换算为元素局部
 * 坐标驱动纯状态机，管理指针捕获与完整注销。宿主需为元素设置
 * `touch-action: none`，否则浏览器接管触摸手势。
 */
export function createPointerInput(options: PointerInputOptions): PointerInputController {
  const { element, ...handlers } = options
  const machine = new PointerInputMachine(handlers)
  let attached = false

  const toSample = (event: PointerEvent): PointerSample => {
    const rect = element.getBoundingClientRect()
    return {
      pointerId: event.pointerId,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      timeStamp: event.timeStamp,
    }
  }

  const capture = (pointerId: number): void => {
    try {
      element.setPointerCapture(pointerId)
    } catch {
      // 合成事件或宿主不支持捕获时忽略，状态机仍可工作。
    }
  }

  const release = (pointerId: number): void => {
    try {
      if (typeof element.hasPointerCapture !== 'function' || element.hasPointerCapture(pointerId)) {
        element.releasePointerCapture(pointerId)
      }
    } catch {
      // 指针已失效时忽略。
    }
  }

  const onDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    capture(event.pointerId)
    machine.pointerDown(toSample(event))
  }

  const onMove = (event: PointerEvent): void => {
    if (!machine.hasPointer(event.pointerId)) return
    machine.pointerMove(toSample(event))
  }

  const onUp = (event: PointerEvent): void => {
    if (!machine.hasPointer(event.pointerId)) return
    machine.pointerUp(toSample(event))
    release(event.pointerId)
  }

  const onCancel = (event: PointerEvent): void => {
    if (!machine.hasPointer(event.pointerId)) return
    machine.pointerCancel(toSample(event))
    release(event.pointerId)
  }

  const onLeave = (event: PointerEvent): void => {
    if (!machine.hasPointer(event.pointerId)) return
    // 移到子元素不算离开宿主；离开宿主（含离开窗口）按取消处理，不粘连。
    const related = event.relatedTarget
    if (related instanceof Node && element.contains(related)) return
    machine.pointerCancel(toSample(event))
    release(event.pointerId)
  }

  return {
    attach(): void {
      if (attached) return
      attached = true
      element.addEventListener('pointerdown', onDown)
      element.addEventListener('pointermove', onMove)
      element.addEventListener('pointerup', onUp)
      element.addEventListener('pointercancel', onCancel)
      element.addEventListener('pointerleave', onLeave)
      element.addEventListener('pointerout', onLeave)
    },
    detach(): void {
      if (!attached) return
      attached = false
      element.removeEventListener('pointerdown', onDown)
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerup', onUp)
      element.removeEventListener('pointercancel', onCancel)
      element.removeEventListener('pointerleave', onLeave)
      element.removeEventListener('pointerout', onLeave)
      machine.cancelAll()
    },
  }
}
