/**
 * ZoomAxis(S3a F1):引擎唯一缩放状态。
 * - 刻度 z ∈ [0,1]:0 = 最远全貌,1 = 贴地第一人称
 * - orbit 段 [0, Z_ENTER] 对数映射到 distance ∈ [MAX_DISTANCE, MIN_DISTANCE]
 *   (沿用现状 wheel 指数手感;近距精细、远距粗放)
 * - walk 段 (Z_ENTER, 1] 无相机映射,仅作升空意图缓冲区:
 *   walk 带内增量 ×WALK_BAND_GAIN,拉远意图即时兑现为升空(拍板:完全单轴)
 * 纯状态机,不碰相机;渲染 LOD(zoom-lod)与 S3b 披露层级共用本刻度。
 */

export type ZoomBand = 'orbit' | 'walk'
export type ZoomCrossing = 'enter-walk' | 'exit-walk'

export const MIN_DISTANCE = 6 // 与 camera.ts OrbitCameraStrategy 对齐
export const MAX_DISTANCE = 400
export const Z_ENTER = 0.85
export const HYSTERESIS = 0.05
export const Z_EXIT = Z_ENTER - HYSTERESIS // 0.80
/** 升空后刻度落点:远离阈值形成自然滞回,再落地需明确的继续拉近动作 */
export const Z_AFTER_LIFT = Z_ENTER - 2 * HYSTERESIS // 0.75
/** walk 带增量增益:带宽仅 0.15,放大后一两次滚轮即可表达升空意图 */
export const WALK_BAND_GAIN = 4

/** 指数平滑速率(/s):手感介于即时与惯性之间(N3) */
const SMOOTH_RATE = 12
const SNAP_EPS = 1e-4

const clamp01 = (z: number) => Math.min(1, Math.max(0, z))
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export class ZoomAxis {
  private target: number
  private current: number
  private band: ZoomBand = 'orbit'
  private frozen = false

  constructor(initial = 0.5) {
    this.target = this.current = clamp01(initial)
  }

  /** 当前平滑刻度(S3b 披露/HUD/e2e 探针读此值) */
  get value(): number {
    return this.current
  }

  get isFrozen(): boolean {
    return this.frozen
  }

  /** 距离 → 刻度(对数):distance=MIN → Z_ENTER,distance=MAX → 0 */
  zoomFromDistance(d: number): number {
    const cd = clamp(d, MIN_DISTANCE, MAX_DISTANCE)
    const t = (Math.log(cd) - Math.log(MIN_DISTANCE)) / (Math.log(MAX_DISTANCE) - Math.log(MIN_DISTANCE))
    return Z_ENTER * (1 - t)
  }

  /** 刻度 → 距离(对数):超出 orbit 段的输入按 Z_ENTER 防御 */
  distanceFromZoom(z: number): number {
    const cz = clamp(z, 0, Z_ENTER)
    const t = 1 - cz / Z_ENTER // z=Z_ENTER → 0(MIN),z=0 → 1(MAX)
    return MIN_DISTANCE * Math.pow(MAX_DISTANCE / MIN_DISTANCE, t)
  }

  /** 缩放增量入口(wheel/pinch 统一):正 = 拉近。frozen 时丢弃(F2:补间期间输入忽略) */
  applyDelta(delta: number): void {
    if (this.frozen) return
    const gained = this.band === 'walk' ? delta * WALK_BAND_GAIN : delta
    this.target = clamp01(this.target + gained)
  }

  /** 直接设定目标刻度(setCameraMode 快捷直达);程序入口,不受 frozen 限制 */
  setTarget(z: number): void {
    this.target = clamp01(z)
  }

  /** 文档重载/初始构图/落地失败钳回:立即同步 current/target,带重置为 orbit */
  reset(z: number): void {
    this.target = this.current = clamp01(z)
    this.band = 'orbit'
    this.frozen = false
  }

  /** 当前所处轨道段/步行段,由引擎在交接时告知(避免双份真源) */
  setBand(band: ZoomBand): void {
    this.band = band
  }

  /** 补间期间冻结输入 */
  freeze(): void {
    this.frozen = true
  }

  /** 解冻;带 target 时同步 current/target(交接后刻度归位) */
  unfreeze(target?: number): void {
    this.frozen = false
    if (target !== undefined) this.target = this.current = clamp01(target)
  }

  /**
   * 每帧指数平滑推进;跨越触地/升空阈值时返回 crossing(每方向只触发一次,
   * 消费方须当帧处理:进入补间并 freeze,或钳回)。
   */
  update(dt: number): ZoomCrossing | null {
    if (this.frozen) return null
    const prev = this.current
    const k = 1 - Math.exp(-SMOOTH_RATE * dt)
    this.current += (this.target - this.current) * k
    if (Math.abs(this.current - this.target) < SNAP_EPS) this.current = this.target

    if (this.band === 'orbit' && prev <= Z_ENTER && this.current > Z_ENTER) return 'enter-walk'
    if (this.band === 'walk' && prev > Z_EXIT && this.current <= Z_EXIT) return 'exit-walk'
    return null
  }
}
