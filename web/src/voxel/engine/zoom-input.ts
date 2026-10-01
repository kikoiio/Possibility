/**
 * ZoomInput(S3a F1/F5):统一缩放输入——wheel + 双指 pinch → zoomDelta。
 * - wheel 从 OrbitCameraStrategy 收编(相机策略不再自改距离)
 * - pinch 用 pointer events 双触点,不引手势库;两指成捏广播 onPinchStart
 *   (orbit 借此取消进行中的拖拽)
 * - 单指触摸不在此模块(orbit 的 pointerdown 拖拽原样保留)
 */

/** 鼠标滚轮一档的刻度步长;触控板按 |deltaY|/100 缩放 */
const WHEEL_STEP = 0.045
const WHEEL_MIN = 0.005
const WHEEL_MAX = 0.12
/** pinch:间距每 2% 变化 ≈ 0.01 刻度;单次换算钳制防跳变 */
const PINCH_PER_RATIO = 0.5
const PINCH_MAX = 0.08

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** wheel deltaY → zoomDelta(正 = 拉近)。deltaY<0(向上滚)为拉近 */
export function wheelDeltaToZoom(deltaY: number): number {
  const magnitude = clamp(Math.abs(deltaY) / 100, 0, 1) * WHEEL_STEP
  const step = clamp(Math.max(magnitude, WHEEL_MIN), WHEEL_MIN, WHEEL_MAX)
  return deltaY < 0 ? step : -step
}

/** pinch 间距比(当前/基准)→ zoomDelta。ratio>1(捏开)= 拉近 */
export function pinchRatioToZoom(ratio: number): number {
  return clamp((ratio - 1) * PINCH_PER_RATIO, -PINCH_MAX, PINCH_MAX)
}

export class ZoomInput {
  onZoomDelta: ((delta: number) => void) | null = null
  /** 双指成捏时广播(orbit 取消拖拽) */
  onPinchStart: (() => void) | null = null

  private pointers = new Map<number, { x: number; y: number }>()
  private pinchBase = 0
  private disposers: Array<() => void> = []

  attach(canvas: HTMLCanvasElement): void {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      this.onZoomDelta?.(wheelDeltaToZoom(e.deltaY))
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this.pointers.size === 2) {
        this.pinchBase = this.currentSpan()
        this.onPinchStart?.()
      }
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this.pointers.size !== 2 || this.pinchBase <= 0) return
      const span = this.currentSpan()
      if (span <= 0) return
      const delta = pinchRatioToZoom(span / this.pinchBase)
      if (delta !== 0) {
        this.pinchBase = span // 增量式:每次换算后重置基准
        this.onZoomDelta?.(delta)
      }
    }
    const onPointerEnd = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId)
      if (this.pointers.size < 2) this.pinchBase = 0
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerEnd)
    canvas.addEventListener('pointercancel', onPointerEnd)
    this.disposers = [
      () => canvas.removeEventListener('wheel', onWheel),
      () => canvas.removeEventListener('pointerdown', onPointerDown),
      () => canvas.removeEventListener('pointermove', onPointerMove),
      () => canvas.removeEventListener('pointerup', onPointerEnd),
      () => canvas.removeEventListener('pointercancel', onPointerEnd),
    ]
  }

  detach(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.pointers.clear()
    this.pinchBase = 0
  }

  private currentSpan(): number {
    const [a, b] = [...this.pointers.values()]
    if (!a || !b) return 0
    return Math.hypot(a.x - b.x, a.y - b.y)
  }
}
