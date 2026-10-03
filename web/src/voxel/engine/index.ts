import {
  createBlockRegistry, ensureAssetPlacementIds,
  type BlockRegistry, type EditResult, type EventDisclosureState, type SectionKey, type StylePackRef,
  type VoxelDocument, type WorldEvent,
} from '@possibility/voxel-contract'
import * as THREE from 'three'
import { AmbientAnimator } from './ambient'
import { buildPlaceholderAtlas, TextureAtlas } from './atlas'
import { CameraRig, type OrbitPose } from './camera'
import { findSpawnNear, WalkCameraStrategy } from './camera-walk'
import { ContinuumController, type WalkPose } from './camera-continuum'
import { DayNightCycle } from './day-night'
import { EventDisclosure } from './event-disclosure'
import { BuildFeedback } from './feedback'
import { LightingEngine } from './lighting'
import { DEFAULT_BAKE_ENV, Mesher, type AoParams, type BakeEnvironment } from './mesher'
import { MotionPreference } from './motion-preference'
import { applyStyleTweaks, loadPalette, samplePalette, type RGB, type ThemePalette } from './palette'
import { resolvePalette } from './palettes/style-presets'
import { Picker } from './picker'
import { PLAYER } from './player'
import { ResidentRenderer, type ResidentRenderState } from './residents'
import {
  isEyeUnderwater, smoothUnderwater, underwaterDepth,
  UNDERWATER_FOG_BASE, UNDERWATER_FOG_DEPTH,
} from './underwater'
import { Assets } from './assets'
import type { AssetManifest } from '@possibility/voxel-contract'
import { VoxelRenderer, type EnvironmentState } from './renderer'
import { WeatherSystem, type WeatherState } from './weather'
import { WorldModel } from './world-model'
import { Z_AFTER_LIFT, ZoomAxis } from './zoom-axis'
import { ZoomInput } from './zoom-input'
import { ZoomLod, type TierParams, type ZoomTier } from './zoom-lod'
import type { VoxelCoord } from '@possibility/voxel-contract'
import { inspectInteriorClosure, type InteriorClosureReport } from '../interior-closure'
import { resolveSpaceContext, type VoxelSpaceContext } from '../space-context'

function rgbToHex(c: RGB): number {
  return (Math.round(Math.min(1, c[0]) * 255) << 16)
    | (Math.round(Math.min(1, c[1]) * 255) << 8)
    | Math.round(Math.min(1, c[2]) * 255)
}

const lerpNum = (a: number, b: number, t: number) => a + (b - a) * t
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [
  lerpNum(a[0], b[0], t), lerpNum(a[1], b[1], t), lerpNum(a[2], b[2], t),
]

export interface FrameUpdatable { update(dt: number): void }

export interface VoxelSceneProbe {
  spaceContext: VoxelSpaceContext
  cameraMode: 'orbit' | 'walk'
  walkPosition: { x: number; y: number; z: number } | null
  worldSize: { width: number; height: number; depth: number } | null
  skyVisible: boolean
  skyExposedAtPlayer: boolean | null
  visibleObjectIds: string[]
  viewport: { width: number; height: number }
}

/**
 * VoxelEngine 门面：文档进、画面出、编辑事件出。
 * 不认识"世界状态""访客"等产品概念（那是 bridge 的事）。
 */
export class VoxelEngine {
  registry: BlockRegistry | null = null
  readonly atlas = new TextureAtlas()
  readonly renderer = new VoxelRenderer(this.atlas)
  readonly cameraRig = new CameraRig()
  readonly motion = new MotionPreference()
  readonly assets = new Assets(this.renderer.scene, this.motion)
  world: WorldModel | null = null
  lighting: LightingEngine | null = null
  mesher: Mesher | null = null
  bakeEnv: BakeEnvironment = { ...DEFAULT_BAKE_ENV, faceShade: { ...DEFAULT_BAKE_ENV.faceShade } }
  palette: ThemePalette | null = null
  /** S3b:当前风格包引用(doc.style),微调在 applyPalette 采样出口叠加 */
  private styleRef: StylePackRef | undefined
  dayNight: DayNightCycle | null = null
  weather: WeatherSystem | null = null
  ambient: AmbientAnimator | null = null
  residents: ResidentRenderer | null = null
  picker: Picker | null = null
  feedback: BuildFeedback | null = null

  private pendingSkyLevel = 15
  private currentTimeOfDay = 0.5
  private weatherMod = { fogBoost: 0, dim: 0 }
  private spaceContext: VoxelSpaceContext = resolveSpaceContext()
  private interiorReport: InteriorClosureReport | null = null
  /** 入水强度 0~1（平滑后；e2e 探针读此值） */
  private underwaterStrengthValue = 0
  private tmpDir = new THREE.Vector3()
  private tmpReflect = new THREE.Color()
  private assetManifest: AssetManifest | null = null

  /** S2b:已加载的全局资产清单(编辑面板与摆放校验用);清单不可用时为 null */
  get assetsManifest(): AssetManifest | null {
    return this.assetManifest
  }

  get underwaterStrength(): number {
    return this.underwaterStrengthValue
  }

  private canvas: HTMLCanvasElement | null = null
  private running = false
  private raf = 0
  private lastTime = 0
  private updatables: FrameUpdatable[] = []
  private resizeObserver: ResizeObserver | null = null
  /** 每帧回调（fps 探针等） */
  onFrame: ((dt: number) => void) | null = null

  // ── S3a 缩放 continuum ─────────────────────────────
  /** 唯一缩放状态(0=最远全貌 → 1=贴地);LOD 与 S3b 披露共用 */
  readonly zoomAxis = new ZoomAxis()
  /** 落地/升空补间状态机(reduced-motion 直切) */
  readonly continuum = new ContinuumController(this.motion)
  /** 渲染 LOD 三档档位机(滞回) */
  readonly zoomLod = new ZoomLod()
  private readonly zoomInput = new ZoomInput()
  /** LOD 旋钮:bloom/雾缩放存字段,applyPalette 每帧换算;阴影/粒子/摇摆即时分发 */
  private tierBloomScale = 1
  private tierFogScale = 1
  /** 风格包粒子密度基准(LOD 系数在门面层相乘,子系统接口不动) */
  private baseParticleDensity = 1
  /** 落地交接:补间完成后创建 Walk 策略所需 */
  private pendingLanding: { spawn: VoxelCoord; yaw: number } | null = null
  /** 升空交接:补间终点 orbit 位姿(完成后写回策略防跳变) */
  private pendingLiftPose: OrbitPose | null = null
  /** 模式变化推送(S3a:滚轮驱动的落地/升空不经过 Viewport toggle,引擎主动通知) */
  onCameraModeChange: ((mode: 'orbit' | 'walk') => void) | null = null

  // ── S3b 事件披露 ─────────────────────────────
  /** 事件图标披露层;doc 无 events = null(零开销) */
  disclosure: EventDisclosure | null = null
  /** 文档事件快照(flyToEvent 寻址用) */
  private eventList: WorldEvent[] = []
  /** 世界绝对时间(ISO,bridge 透传);披露层未建也存,loadDocument 后回放 */
  private simNow: string | null = null
  /** 飞向事件补间的终点位姿(settled 时写回) */
  private pendingFlyPose: OrbitPose | null = null

  mount(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    this.renderer.mount(canvas, () => this.cameraRig.camera)
    this.cameraRig.attach(canvas)
    // S3a:统一缩放输入(wheel+pinch)→ ZoomAxis;成捏取消 orbit 拖拽
    this.zoomInput.onZoomDelta = (delta) => this.zoomAxis.applyDelta(delta)
    this.zoomInput.onPinchStart = () => this.cameraRig.orbitStrategy.cancelDrag()
    this.zoomInput.attach(canvas)
    this.zoomLod.onTierChange = (_tier, params) => this.applyTier(params)
    this.ambient = new AmbientAnimator(this.renderer.scene, this.renderer.shaderUniforms, this.motion)
    this.dayNight = new DayNightCycle({
      setSkyLevel: (level) => { this.pendingSkyLevel = level },
      setBakeEnv: (env) => this.setBakeEnv(env),
      setBaseEnvironment: (env) => this.setBaseEnvironment(env),
    })
    this.resizeObserver = new ResizeObserver(() => this.syncSize())
    this.resizeObserver.observe(canvas)
    this.syncSize()
  }

  private syncSize(): void {
    if (!this.canvas) return
    const { clientWidth, clientHeight } = this.canvas
    this.renderer.resize(clientWidth, clientHeight)
    this.cameraRig.setAspect(clientWidth / Math.max(1, clientHeight))
  }

  /** 加载主题方块集、图集与调色数据；placeholder 供开发期无美术资产时使用 */
  async loadAssets(theme: string, opts: { placeholder?: boolean } = {}): Promise<void> {
    this.registry = createBlockRegistry(theme)
    this.palette = loadPalette(theme)
    if (opts.placeholder) {
      const { canvas, json } = buildPlaceholderAtlas(this.registry)
      const texture = new THREE.CanvasTexture(canvas)
      this.atlas.setTexture(texture, json)
    } else {
      await this.atlas.load(theme)
    }
    this.renderer.setAtlasTexture()
    try { this.assetManifest = await this.assets.loadManifest() } catch { this.assetManifest = null }
  }

  loadDocument(doc: VoxelDocument, spaceId?: string): void {
    if (!this.registry) throw new Error('loadAssets must be called before loadDocument')
    // S2b:旧存档摆放无 id,加载边界幂等补齐(ops 按 id 寻址的前置)
    doc = ensureAssetPlacementIds(doc)
    this.setSpaceContext(resolveSpaceContext(doc, spaceId ?? doc.id))
    this.interiorReport = this.spaceContext.kind === 'interior'
      ? inspectInteriorClosure(doc, this.spaceContext, { registry: this.registry })
      : null
    // S3a:文档重载——补间直切回 orbit 稳定态,刻度随后按 fit 构图重置(N4)
    const prevMode = this.cameraRig.mode
    this.continuum.cancel()
    this.cameraRig.setTransition(null)
    this.pendingLanding = null
    this.pendingLiftPose = null
    this.cameraRig.setMode('orbit') // 文档重载:重置回上帝视角(S2b)
    if (prevMode !== 'orbit') this.onCameraModeChange?.('orbit')
    this.weather?.dispose()
    this.residents?.dispose()
    this.feedback?.dispose()
    this.disclosure?.dispose()
    this.disclosure = null
    this.eventList = []
    // S3b 风格包:先解析预设/微调并下发昼夜循环,后续初次烘焙即用新 bakeEnv
    this.styleRef = doc.style
    this.palette = resolvePalette(doc.theme, doc.style)
    this.dayNight?.setPalette(this.palette)
    this.dayNight?.setTimeOfDay(this.currentTimeOfDay)
    this.baseParticleDensity = this.palette.particleDensity ?? 1
    this.applyParticleDensity()
    this.world = new WorldModel(doc)
    if (this.assetManifest) this.assets.sync(doc.assetPlacements ?? [], this.assetManifest)
    this.lighting = new LightingEngine(this.world, this.registry)
    this.lighting.setSkyLightEnabled(this.spaceContext.skyLightEnabled)
    this.lighting.computeAll()
    this.mesher = new Mesher(this.world, this.registry, this.atlas, this.lighting)
    this.renderer.removeSections([...this.allSectionKeys()])
    this.renderer.updateSections(this.mesher.bakeAll(this.bakeEnv, this.aoParams))
    this.cameraRig.fitToWorld(doc.size)
    if (doc.id === 'mist-manor-exterior' && this.spaceContext.kind === 'exterior') {
      const pose = this.cameraRig.orbitStrategy.state
      this.cameraRig.orbitStrategy.setPose({
        theta: pose.theta,
        // Frame the main house and greenhouse together; the full-world fit
        // leaves the landmarks and path too small to read on desktop.
        phi: Math.min(pose.phi, 0.9),
        distance: pose.distance * 0.48,
        target: {
          x: doc.size.width * 0.65,
          y: Math.min(doc.size.height * 0.2, 5),
          z: doc.size.depth * 0.25,
        },
      })
    }
    // S3a:默认构图映射到刻度(N4:落在刻度中段偏下,不触地)
    this.zoomAxis.reset(this.zoomAxis.zoomFromDistance(this.cameraRig.state.distance))
    // 初始 LOD 档立即落定并下发(否则首个跨档前参数不生效)
    this.zoomLod.update(this.zoomAxis.value)
    this.applyTier(this.zoomLod.params)
    this.weather = new WeatherSystem(
      this.renderer.scene, this.world, this.registry, this.motion,
      { setWeatherEnv: (mod) => { this.weatherMod = mod; this.applyPalette() } },
      () => { const t = this.cameraRig.state.target; return { x: t.x, y: t.y, z: t.z } },
    )
    this.residents = new ResidentRenderer(this.renderer.scene, this.world, this.registry)
    this.picker = new Picker(this.world, this.assets)
    this.feedback = new BuildFeedback(this.renderer.scene, this.assets)
    // S3b 事件披露:图标层装配(文档事件 = dev fixture/存档语义;生产路径由 setEvents 覆盖)
    this.setEvents(doc.events ?? [])
    this.registerLightEmitters()
    this.applyParticleDensity() // 新建的 WeatherSystem 也需要 LOD 合成密度
  }

  /**
   * S4 世界模拟:运行期事件下发(生产路径唯一事件源;dev fixture 走 loadDocument 同一入口)。
   * 替换事件快照并重建披露层;空数组 = 零事件(披露层销毁,零开销)。
   */
  setEvents(events: WorldEvent[]): void {
    this.eventList = events
    this.disclosure?.dispose()
    this.disclosure = null
    if (events.length === 0) return
    this.disclosure = new EventDisclosure({
      scene: this.renderer.scene,
      // worldToScreen 入参为格坐标(内部 +0.5 取格心);披露层锚点已是世界坐标,先回退
      project: (at) => this.worldToScreen({ x: at.x - 0.5, y: at.y - 0.5, z: at.z - 0.5 }),
    })
    this.disclosure.setEvents(events)
    if (this.simNow) this.disclosure.setSimNow(this.simNow)
    this.disclosure.setTier(this.zoomLod.tier)
  }

  syncResidents(states: ResidentRenderState[]): void {
    this.residents?.syncResidents(states)
  }

  /** 世界坐标 → 屏幕坐标（e2e 点击定位探针） */
  worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null {
    if (!this.canvas) return null
    const v = new THREE.Vector3(at.x + 0.5, at.y + 0.5, at.z + 0.5).project(this.cameraRig.camera)
    const rect = this.canvas.getBoundingClientRect()
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height }
  }

  /** 发光方块自动登记灯火发射器（F13 灯火闪烁） */
  private registerLightEmitters(): void {
    if (!this.world || !this.registry || !this.ambient) return
    const { width, height, depth } = this.world.doc.size
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < depth; z++) {
        for (let x = 0; x < width; x++) {
          const emits = this.registry.get(this.world.getBlock({ x, y, z }))?.emitsLight ?? 0
          if (emits > 0) this.ambient.registerEmitter('glow', { x, y, z })
        }
      }
    }
  }

  setSpaceContext(context: VoxelSpaceContext): void {
    this.spaceContext = {
      kind: context.kind,
      skyVisible: context.skyVisible,
      skyLightEnabled: context.skyLightEnabled,
      fogMode: context.fogMode,
    }
    this.renderer.setSkyVisible(context.skyVisible)
    this.lighting?.setSkyLightEnabled(context.skyLightEnabled)
    this.applyPalette()
  }

  getSpaceContext(): VoxelSpaceContext {
    return { ...this.spaceContext }
  }

  inspectInterior(): InteriorClosureReport | null {
    return this.interiorReport
  }

  probeScene(): VoxelSceneProbe {
    const walkPosition = this.cameraRig.mode === 'walk' ? this.cameraRig.state.target : null
    const visibleObjectIds = this.world?.doc.objects.filter((object) => {
      const projected = new THREE.Vector3(
        object.anchor.x + 0.5,
        object.anchor.y + 0.5,
        object.anchor.z + 0.5,
      ).project(this.cameraRig.camera)
      return projected.z >= -1 && projected.z <= 1
        && projected.x >= -1 && projected.x <= 1
        && projected.y >= -1 && projected.y <= 1
    }).map((object) => object.id) ?? []
    let skyExposedAtPlayer: boolean | null = null
    if (walkPosition && this.world) {
      const x = Math.floor(walkPosition.x)
      const z = Math.floor(walkPosition.z)
      skyExposedAtPlayer = true
      for (let y = Math.floor(walkPosition.y) + 1; y < this.world.doc.size.height; y++) {
        if (this.registry && this.registry.get(this.world.getBlock({ x, y, z }))?.solid) {
          skyExposedAtPlayer = false
          break
        }
      }
    }
    return {
      spaceContext: this.getSpaceContext(),
      cameraMode: this.cameraMode,
      walkPosition: walkPosition ? { x: walkPosition.x, y: walkPosition.y, z: walkPosition.z } : null,
      worldSize: this.world ? { ...this.world.doc.size } : null,
      skyVisible: this.renderer.skyVisible,
      skyExposedAtPlayer,
      visibleObjectIds,
      viewport: this.renderer.size,
    }
  }

  setBaseEnvironment(_env: { skyColor: THREE.ColorRepresentation; fogColor: THREE.ColorRepresentation }): void {
    // 昼夜 sink 协议保留；天色/雾色现由 applyPalette 每帧从色彩中枢采样
    this.applyPalette()
  }

  /** 色彩中枢分发：每帧采样调色（天空/雾/水/后处理平滑），96 步量化仅控制重烘焙 */
  private applyPalette(dt = 1 / 60): void {
    if (!this.palette) return
    const resolved = applyStyleTweaks(
      samplePalette(this.palette, this.currentTimeOfDay, this.weatherMod),
      this.styleRef?.tweaks,
    )

    // 入水判定（S3a F5）：眼位没入下沉水面 → 强度平滑收敛；雾色/密度按强度+深度插值
    let target = 0
    let depth = 0
    if (this.world && this.registry) {
      const eye = this.cameraRig.camera.position
      target = isEyeUnderwater(this.world, this.registry, eye) ? 1 : 0
      depth = underwaterDepth(this.world, this.registry, eye)
    }
    this.underwaterStrengthValue = smoothUnderwater(this.underwaterStrengthValue, target, dt)
    const strength = this.underwaterStrength
    if (strength > 0.001) {
      this.renderer.setUnderwaterFog(
        mixRGB(resolved.fog.color, resolved.water.fog, strength),
        lerpNum(resolved.fog.density, UNDERWATER_FOG_BASE + UNDERWATER_FOG_DEPTH * depth, strength),
      )
    } else {
      // S3a LOD:雾密度按档缩放(全貌略增雾感,大气透视)
      const env: EnvironmentState = {
        // 室内隐藏天空穹顶时也要替换外景雾色背景，避免门窗和边界缺口显出紫色夜空。
        fogColor: this.spaceContext.fogMode === 'indoor' ? 0x111714 : rgbToHex(resolved.fog.color),
        fogDensity: resolved.fog.density * this.tierFogScale,
      }
      this.renderer.setEnvironment(env)
    }

    // S3a LOD:阴影贴图尺寸按档缩放(引擎层换算,renderer 接口不动)
    const lodShadow = this.zoomLod.params.shadowMapScale === 1 ? this.palette.shadow : {
      ...this.palette.shadow,
      mapSize: Math.max(256, Math.round(this.palette.shadow.mapSize * this.zoomLod.params.shadowMapScale)),
      softwareMapSize: Math.max(256, Math.round(this.palette.shadow.softwareMapSize * this.zoomLod.params.shadowMapScale)),
    }
    this.renderer.setDirectLight(
      resolved.direct,
      lodShadow,
      this.palette.ambientLift,
      this.spaceContext.kind === 'interior' ? 1.3 : 1,
    )
    this.renderer.setSkyVisible(this.spaceContext.skyVisible)
    const time = this.renderer.shaderUniforms.uTime.value
    const motion = this.motion.animationTimeScale()
    this.renderer.sky?.update(resolved.sky, resolved.fog.color, time, motion)
    // S3a LOD:bloom 强度按档缩放
    this.renderer.post?.update(
      this.tierBloomScale === 1 ? resolved.post : { ...resolved.post, bloomStrength: resolved.post.bloomStrength * this.tierBloomScale },
      { motion, time },
    )
    this.renderer.post?.setUnderwater(strength, resolved.water.fog)

    // 天空反射色：从 resolved.sky 按相机俯仰现算（平视取地平线色、俯视取天顶色），随昼夜天气自动变化
    this.cameraRig.camera.getWorldDirection(this.tmpDir)
    const pitch = Math.min(1, Math.max(0, -this.tmpDir.y))
    this.tmpReflect.setRGB(
      lerpNum(resolved.sky.horizon[0], resolved.sky.zenith[0], pitch),
      lerpNum(resolved.sky.horizon[1], resolved.sky.zenith[1], pitch),
      lerpNum(resolved.sky.horizon[2], resolved.sky.zenith[2], pitch),
    )
    this.renderer.setWaterUniforms(resolved.water, this.tmpReflect)
  }

  private get aoParams(): AoParams | undefined {
    return this.palette ? { curve: this.palette.aoCurve, strength: this.palette.aoStrength } : undefined
  }

  /**
   * 相机模式快捷直达(S3a F4):与滚轮落地/升空完全同路——推刻度到端点 +
   * 立即进入补间。签名与失败路径保持 S2b 契约(Viewport/WalkHud 零改动)。
   */
  setCameraMode(mode: 'orbit' | 'walk'): { ok: boolean; reason?: string } {
    if (mode === 'walk') {
      if (this.cameraRig.mode === 'walk' || this.continuum.state === 'landing') return { ok: true }
      if (!this.world || !this.registry) return { ok: false, reason: '世界尚未加载,无法进入第一视角' }
      const target = this.cameraRig.state.target
      const spawn = this.findWalkSpawn({
        x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z),
      })
      if (!spawn) return { ok: false, reason: '注视点附近没有可站立的位置' }
      this.zoomAxis.setTarget(1)
      this.beginLanding()
      return { ok: true }
    }
    if (this.cameraRig.mode === 'orbit' || this.continuum.state === 'lifting') return { ok: true }
    this.zoomAxis.setTarget(Z_AFTER_LIFT)
    this.beginLifting()
    return { ok: true }
  }

  get cameraMode(): 'orbit' | 'walk' {
    return this.cameraRig.mode as 'orbit' | 'walk'
  }

  /** 当前平滑 zoom 刻度 0..1(S3a F1;e2e 探针 / S3b 披露消费) */
  getZoom(): number {
    return this.zoomAxis.value
  }

  /** 当前渲染 LOD 档(S3a F6;e2e 探针 / S3b 披露层级基准) */
  getZoomTier(): ZoomTier {
    return this.zoomLod.tier
  }

  // ── S3b 事件披露(F4/F5/F6/F8) ──────────────────

  /** 飞向事件的目标刻度:close 档上沿、Z_ENTER 之下(保持 orbit 不触地) */
  private static readonly FLY_TO_ZOOM = 0.78

  /** 世界绝对时间下发(bridge OverlayDriver / e2e 探针) */
  setSimNow(iso: string): void {
    this.simNow = iso
    this.disclosure?.setSimNow(iso)
  }

  /** F8 探针:各事件当前披露状态(无披露层 = []) */
  getEventDisclosure(): EventDisclosureState[] {
    return this.disclosure?.states() ?? []
  }

  /** 事件数据寻址(侧边面板/浮层文案) */
  getEventById(id: string): WorldEvent | null {
    return this.eventList.find((e) => e.id === id) ?? null
  }

  /** 屏幕空间事件拾取(点击路由用;无命中 = null) */
  pickEventAt(x: number, y: number): string | null {
    return this.disclosure?.pickEvent(x, y) ?? null
  }

  /** F6:orbit 模式下相机平滑飞向事件并落入 close 档;walk/补间中拒绝 */
  flyToEvent(id: string): boolean {
    if (!this.disclosure || this.cameraRig.mode !== 'orbit' || this.continuum.state !== 'orbit') return false
    const event = this.eventList.find((e) => e.id === id)
    const from = this.cameraRig.getOrbitPose()
    if (!event || !from) return false
    const zoom = VoxelEngine.FLY_TO_ZOOM
    const to: OrbitPose = {
      theta: from.theta,
      phi: from.phi,
      distance: this.zoomAxis.distanceFromZoom(zoom),
      target: { x: event.at.x + 0.5, y: event.at.y + 1.5, z: event.at.z + 0.5 },
    }
    this.pendingFlyPose = to
    this.zoomAxis.freeze() // 补间期间输入忽略(与落地/升空一致)
    this.continuum.beginFlyTo(from, to)
    this.cameraRig.setTransition(this.continuum.transitionCamera)
    return true
  }

  private finishFlyTo(): void {
    const pose = this.pendingFlyPose
    this.pendingFlyPose = null
    this.cameraRig.setTransition(null)
    if (pose) this.cameraRig.setOrbitPose(pose) // 完整位姿写回,与补间终点无跳变
    this.zoomAxis.unfreeze(VoxelEngine.FLY_TO_ZOOM)
  }

  // ── S3a continuum 链路(每帧 continuumTick 驱动) ──────────────────

  private continuumTick(dt: number): void {
    const crossing = this.zoomAxis.update(dt)
    if (crossing === 'enter-walk') this.beginLanding()
    else if (crossing === 'exit-walk') this.beginLifting()

    const done = this.continuum.update(dt)
    if (done === 'landed') this.finishLanding()
    else if (done === 'lifted') this.finishLifting()
    else if (done === 'settled') this.finishFlyTo()

    this.zoomLod.update(this.zoomAxis.value)
    this.disclosure?.setTier(this.zoomLod.tier)
    // orbit 稳定态:距离由刻度驱动(对数映射)
    if (this.continuum.state === 'orbit' && this.cameraRig.mode === 'orbit') {
      this.cameraRig.orbitStrategy.setDistance(this.zoomAxis.distanceFromZoom(this.zoomAxis.value))
    }
  }

  /** 落地:orbit 注视点 → 可站立格投影 → 补间;无落点钳回阈值下停留 orbit */
  private beginLanding(): void {
    if (!this.world || !this.registry || this.continuum.state !== 'orbit') {
      if (this.continuum.state === 'orbit') this.zoomAxis.reset(Z_AFTER_LIFT)
      return
    }
    const target = this.cameraRig.state.target
    const spawn = this.findWalkSpawn({
      x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z),
    })
    const pose = this.cameraRig.getOrbitPose()
    if (!spawn || !pose) {
      this.zoomAxis.reset(Z_AFTER_LIFT)
      return
    }
    // walk 视线 yaw = orbit theta(相机位于 theta 方向望向注视点,视线同向)
    const interiorCenterYaw = this.spaceContext.kind === 'interior'
      ? Math.atan2(
        -(this.world.doc.size.width / 2 - (spawn.x + 0.5)),
        -(this.world.doc.size.depth / 2 - (spawn.z + 0.5)),
      )
      : pose.theta
    const walkPose: WalkPose = {
      eye: { x: spawn.x + 0.5, y: spawn.y + PLAYER.eye, z: spawn.z + 0.5 },
      yaw: interiorCenterYaw,
      pitch: 0,
    }
    this.pendingLanding = { spawn, yaw: interiorCenterYaw }
    this.zoomAxis.freeze() // 补间期间输入忽略(F2)
    this.continuum.beginLanding(pose, walkPose)
    this.cameraRig.setTransition(this.continuum.transitionCamera)
  }

  private findWalkSpawn(target: VoxelCoord): VoxelCoord | null {
    if (!this.world || !this.registry) return null
    if (this.spaceContext.kind === 'interior') {
      const spawn = this.interiorReport?.walkableSpawn
      return spawn ? { ...spawn } : null
    }
    return findSpawnNear(this.world, this.registry, target)
  }

  private finishLanding(): void {
    const pending = this.pendingLanding
    this.pendingLanding = null
    if (pending && this.world && this.registry) {
      const walk = new WalkCameraStrategy(this.world, this.registry, pending.spawn)
      walk.setLook(pending.yaw, 0) // 视角与补间终点一致,激活不跳变
      this.cameraRig.registerWalkStrategy(walk)
    }
    this.cameraRig.setTransition(null)
    const result = this.cameraRig.setMode('walk')
    if (!result.ok) {
      // 策略缺失(世界重载等竞态):回 orbit 稳定态,不卡中间态
      this.continuum.forceSettle('orbit')
      this.zoomAxis.reset(Z_AFTER_LIFT)
      return
    }
    this.zoomAxis.setBand('walk')
    this.zoomAxis.unfreeze(1)
    this.onCameraModeChange?.('walk')
  }

  /** 升空:玩家眼位 → orbit(注视点=玩家位置,theta=yaw,默认俯角,滞回带外距离) */
  private beginLifting(): void {
    if (this.continuum.state !== 'walk') return
    const playerPos = this.cameraRig.state.target // walk 模式 = 玩家脚底
    const look = this.cameraRig.walkLook
    const from: WalkPose = {
      eye: { x: playerPos.x, y: playerPos.y + PLAYER.eye, z: playerPos.z },
      yaw: look?.yaw ?? 0,
      pitch: look?.pitch ?? 0,
    }
    const pose: OrbitPose = {
      theta: look?.yaw ?? Math.PI * 0.25,
      phi: 0.96,
      distance: this.zoomAxis.distanceFromZoom(Z_AFTER_LIFT),
      target: { x: playerPos.x, y: playerPos.y, z: playerPos.z },
    }
    this.pendingLiftPose = pose
    this.zoomAxis.freeze()
    this.continuum.beginLifting(from, pose)
    this.cameraRig.setTransition(this.continuum.transitionCamera)
  }

  private finishLifting(): void {
    const pose = this.pendingLiftPose
    this.pendingLiftPose = null
    this.cameraRig.setTransition(null)
    this.cameraRig.setMode('orbit') // 既有交接:注视点跟随玩家位置
    if (pose) this.cameraRig.setOrbitPose(pose) // 完整位姿写回,与补间终点无跳变
    this.zoomAxis.setBand('orbit')
    this.zoomAxis.unfreeze(Z_AFTER_LIFT)
    this.onCameraModeChange?.('orbit')
  }

  /** LOD 跨档分发:阴影/雾/bloom 走 applyPalette 每帧换算,粒子/摇摆即时下发 */
  private applyTier(params: TierParams): void {
    this.tierBloomScale = params.bloomScale
    this.tierFogScale = params.fogScale
    this.assets.setSwayScale(params.swayScale)
    this.applyParticleDensity()
  }

  /** 粒子密度合成:风格包基准 × LOD 系数(单一合成点,避免两处真源) */
  private applyParticleDensity(): void {
    const density = this.baseParticleDensity * this.zoomLod.params.particleDensity
    this.weather?.setParticleDensity(density)
    this.ambient?.setParticleDensity(density)
  }

  /** orbit 位姿读出(S1 分屏相机联动);walk 模式返回 null */
  getOrbitPose(): OrbitPose | null {
    return this.cameraRig.getOrbitPose()
  }

  /** 受控位姿写入(S1 分屏相机联动);walk 模式忽略 */
  setOrbitPose(pose: OrbitPose): void {
    this.cameraRig.setOrbitPose(pose)
    // S3a:距离与刻度同一真源——受控写入同步刻度,避免下帧被刻度回写(F8)
    if (this.continuum.state === 'orbit' && this.cameraRig.mode === 'orbit') {
      this.zoomAxis.reset(this.zoomAxis.zoomFromDistance(pose.distance))
    }
  }

  setTimeOfDay(t: number): void {
    this.currentTimeOfDay = ((t % 1) + 1) % 1
    this.dayNight?.setTimeOfDay(t)
  }

  /** S3b 风格包切换(F9/F10):换预设 → 昼夜源更换并重发(全量重烘一次) → 派生层即时生效 */
  setStyle(style: StylePackRef): void {
    const theme = this.world?.doc.theme ?? 'mist-manor'
    this.styleRef = style
    this.palette = resolvePalette(theme, style)
    this.baseParticleDensity = this.palette.particleDensity ?? 1
    this.applyParticleDensity() // 风格包基准 × LOD 系数,门面层合成
    this.dayNight?.setPalette(this.palette)
    this.dayNight?.setTimeOfDay(this.currentTimeOfDay)
    this.applyPalette()
  }

  /** 当前风格包引用(e2e 探针) */
  getStyle(): StylePackRef | undefined {
    return this.styleRef
  }

  setWeather(state: WeatherState): void {
    this.weather?.setWeather(state)
  }

  private allSectionKeys(): SectionKey[] {
    return this.world ? Object.keys(this.world.doc.sections) : []
  }

  /** 最近一次编辑的分段耗时（T36 实测探针） */
  lastEditTrace: { lighting: number; bake: number; upload: number; sections: number } | null = null

  /** 应用编辑结果：局部重算光照 + 局部重烘焙（F4） */
  applyEditResult(result: EditResult): void {
    if (!this.world || !this.lighting || !this.mesher) return
    this.world.applyResult(result)
    if (this.assetManifest) this.assets.sync(result.document.assetPlacements ?? [], this.assetManifest)
    const t0 = performance.now()
    const rebake = new Set<SectionKey>()
    for (const key of result.changedSections) {
      for (const affected of this.lighting.computeSection(key).affectedSections) rebake.add(affected)
    }
    const t1 = performance.now()
    const baked = [...rebake].map((key) => this.mesher!.bakeSection(key, this.bakeEnv, this.aoParams))
    const t2 = performance.now()
    this.renderer.updateSections(baked)
    const t3 = performance.now()
    this.lastEditTrace = { lighting: t1 - t0, bake: t2 - t1, upload: t3 - t2, sections: rebake.size }
  }

  /** 烘焙环境（昼夜方向/色温）变化 → 全量重烘焙 */
  setBakeEnv(env: BakeEnvironment): void {
    this.bakeEnv = env
    this.rebakeAll()
  }

  rebakeAll(): void {
    if (!this.mesher || !this.lighting) return
    this.lighting.setSkyLightEnabled(this.spaceContext.skyLightEnabled)
    this.lighting.setSkyLevel(this.pendingSkyLevel) // 内部已 computeAll
    this.renderer.updateSections(this.mesher.bakeAll(this.bakeEnv, this.aoParams))
  }

  addUpdatable(u: FrameUpdatable): () => void {
    this.updatables.push(u)
    return () => { this.updatables = this.updatables.filter((x) => x !== u) }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()
    const tick = (now: number) => {
      if (!this.running) return
      const dt = Math.min(0.1, (now - this.lastTime) / 1000)
      this.lastTime = now
      this.continuumTick(dt) // S3a:刻度推进 → 落地/升空补间 → LOD 档位 → orbit 距离
      this.cameraRig.update(dt)
      this.updatablesTick(dt)
      this.assets.update(dt)
      for (const u of this.updatables) u.update(dt)
      this.applyPalette(dt) // 天空/雾/水/后处理/直射光每帧平滑；重烘焙仍由 96 步量化控制
      this.onFrame?.(dt)
      const camState = this.cameraRig.state
      this.renderer.renderFrame(dt, this.cameraRig.camera, { target: camState.target, distance: camState.distance })
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  private updatablesTick(dt: number): void {
    this.ambient?.update(dt)
    this.weather?.update(dt)
    this.residents?.update(dt)
    this.feedback?.update(dt)
    this.disclosure?.update(dt)
  }

  stop(): void {
    this.running = false
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf)
  }

  dispose(): void {
    this.stop()
    this.resizeObserver?.disconnect()
    this.zoomInput.detach()
    this.cameraRig.detach()
    this.weather?.dispose()
    this.ambient?.dispose()
    this.residents?.dispose()
    this.feedback?.dispose()
    this.motion.dispose()
    this.assets.dispose()
    this.renderer.dispose()
    this.canvas = null
  }
}

export * from './ambient'
export * from './assets'
export * from './atlas'
export * from './camera'
export * from './camera-continuum'
export * from './camera-walk'
export * from './day-night'
export * from './event-disclosure'
export * from './event-icons'
export * from './lighting'
export * from './mesher'
export * from './palette'
export * from './sky'
export * from './post'
export * from './underwater'
export * from './feedback'
export * from './motion-preference'
export * from './pathfinding'
export * from './picker'
export * from './residents'
export * from './renderer'
export * from './weather'
export * from './world-model'
export * from './zoom-axis'
export * from './zoom-input'
export * from './zoom-lod'
