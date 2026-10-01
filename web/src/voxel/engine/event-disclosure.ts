import * as THREE from 'three'
import {
  resolveEventDisclosure, type DisclosureTier, type EventDisclosureState, type WorldEvent,
} from '@possibility/voxel-contract'
import type { FrameUpdatable } from './index'
import { buildEventIconAtlas, iconCell, ICON_COLS } from './event-icons'

/**
 * S3b 事件披露(F4/F5/F8):事件图标的 Points billboard 层。
 * - 单次 draw call:attribute 携带图集格(类型×留痕态)与可见缩放,
 *   裁决交给契约包纯函数 resolveEventDisclosure,本层只做渲染与拾取
 * - tier/simNow 变化置 dirty,update 内重算(帧内缓存,不变不刷)
 * - 拾取走屏幕空间投影距离(图标是 billboard,与视觉一致)
 */

/** 图标挂点:格中心上方偏移(格) */
const ANCHOR_LIFT = 2.5
/** 拾取阈值(px) */
const PICK_RADIUS_PX = 16
/** 基础点尺寸:距离 24 格处约 48px */
const BASE_SIZE = 1152

const VERT = /* glsl */ `
  attribute float aCell;
  attribute float aScale;
  uniform float uSize;
  uniform float uTime;
  varying float vCell;
  varying float vScale;
  void main() {
    vCell = aCell;
    vScale = aScale;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float breathe = 1.0 + 0.05 * sin(uTime * 2.0 + position.x * 0.7 + position.z * 0.9);
    gl_PointSize = uSize * breathe * aScale / max(1.0, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`

const FRAG = /* glsl */ `
  uniform sampler2D uAtlas;
  varying float vCell;
  varying float vScale;
  void main() {
    if (vScale <= 0.001) discard;
    vec2 uv = vec2((vCell + gl_PointCoord.x) / float(${ICON_COLS}), gl_PointCoord.y);
    vec4 c = texture2D(uAtlas, uv);
    if (c.a < 0.05) discard;
    gl_FragColor = c;
  }
`

/** 投影器:与引擎 worldToScreen 同一约定(画布内 px;不可见返回 null) */
export type EventProjector = (at: { x: number; y: number; z: number }) => { x: number; y: number } | null

export interface EventDisclosureOptions {
  scene: THREE.Scene
  project: EventProjector
  /** 测试注入用;缺省走程序化 canvas 图集(需 DOM) */
  atlas?: THREE.Texture
}

export class EventDisclosure implements FrameUpdatable {
  private events: WorldEvent[] = []
  private simNow: string | null = null
  private tier: DisclosureTier = 'overview'
  private dirty = false
  private stateCache: EventDisclosureState[] = []

  private points: THREE.Points | null = null
  private geometry: THREE.BufferGeometry | null = null
  private material: THREE.ShaderMaterial
  private time = 0

  constructor(private readonly opts: EventDisclosureOptions) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uAtlas: { value: opts.atlas ?? buildEventIconAtlas() },
        uSize: { value: BASE_SIZE },
        uTime: { value: 0 },
      },
      transparent: true,
      depthTest: true,
    })
  }

  /** 事件集装配(loadDocument);空数组 = 空层 */
  setEvents(events: WorldEvent[]): void {
    this.disposePoints()
    this.events = events
    const positions = new Float32Array(events.length * 3)
    const cells = new Float32Array(events.length)
    const scales = new Float32Array(events.length)
    events.forEach((e, i) => {
      positions[i * 3] = e.at.x + 0.5
      positions[i * 3 + 1] = e.at.y + ANCHOR_LIFT
      positions[i * 3 + 2] = e.at.z + 0.5
      cells[i] = iconCell(e.type, false)
      scales[i] = 0
    })
    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.geometry.setAttribute('aCell', new THREE.BufferAttribute(cells, 1))
    this.geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1))
    this.points = new THREE.Points(this.geometry, this.material)
    this.points.frustumCulled = false // 顶点稀疏,包围盒计算不值当
    this.opts.scene.add(this.points)
    this.dirty = true
  }

  /** 世界绝对时间(ISO);状态即时重算标记 */
  setSimNow(iso: string): void {
    if (this.simNow === iso) return
    this.simNow = iso
    this.dirty = true
  }

  /** ZoomTier 下发(loadDocument 初始档 + 每帧) */
  setTier(tier: DisclosureTier): void {
    if (this.tier === tier) return
    this.tier = tier
    this.dirty = true
  }

  update(dt: number): void {
    this.time += dt
    this.material.uniforms.uTime.value = this.time
    if (this.dirty) {
      this.dirty = false
      this.refresh()
    }
  }

  /** F8 探针:当前各事件披露状态快照 */
  states(): EventDisclosureState[] {
    return this.stateCache
  }

  /** 屏幕空间拾取:可见图标中取投影距离 ≤ 阈值的最近者 */
  pickEvent(x: number, y: number): string | null {
    let best: string | null = null
    let bestDist = PICK_RADIUS_PX
    for (const a of this.screenAnchors(true)) {
      const d = Math.hypot(a.x - x, a.y - y)
      if (d <= bestDist) {
        bestDist = d
        best = a.eventId
      }
    }
    return best
  }

  /**
   * 可见事件的屏幕锚点(client px,供 HTML 浮层/拾取)。
   * includeIconOnly: true 时 icon 级也算(拾取用);false 只回 teaser 级(浮层用)。
   */
  screenAnchors(includeIconOnly = false): { eventId: string; x: number; y: number }[] {
    const out: { eventId: string; x: number; y: number }[] = []
    for (let i = 0; i < this.events.length; i++) {
      const state = this.stateCache[i]
      if (!state || state.level === 'none') continue
      if (!includeIconOnly && state.level !== 'teaser') continue
      const e = this.events[i]
      const p = this.opts.project({ x: e.at.x + 0.5, y: e.at.y + ANCHOR_LIFT, z: e.at.z + 0.5 })
      if (p) out.push({ eventId: e.id, x: p.x, y: p.y })
    }
    return out
  }

  private refresh(): void {
    const simNow = this.simNow ?? new Date(0).toISOString() // 无 simNow = 全部未来隐藏(防御)
    this.stateCache = this.events.map((e) => resolveEventDisclosure(e, simNow, this.tier))
    const cellAttr = this.geometry?.getAttribute('aCell') as THREE.BufferAttribute | undefined
    const scaleAttr = this.geometry?.getAttribute('aScale') as THREE.BufferAttribute | undefined
    if (!cellAttr || !scaleAttr) return
    this.events.forEach((e, i) => {
      const state = this.stateCache[i]
      cellAttr.setX(i, iconCell(e.type, state.phase === 'trace'))
      scaleAttr.setX(i, state.level === 'none' ? 0 : 1)
    })
    cellAttr.needsUpdate = true
    scaleAttr.needsUpdate = true
  }

  private disposePoints(): void {
    if (this.points) this.opts.scene.remove(this.points)
    this.geometry?.dispose()
    this.points = null
    this.geometry = null
    this.stateCache = []
  }

  dispose(): void {
    this.disposePoints()
    this.material.dispose()
    // 图集为模块级共享缓存(分屏双实例共存),不随实例释放
  }
}
