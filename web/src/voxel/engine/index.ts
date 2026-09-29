import {
  createBlockRegistry,
  type BlockRegistry, type EditResult, type SectionKey, type VoxelDocument,
} from '@possibility/voxel-contract'
import * as THREE from 'three'
import { AmbientAnimator } from './ambient'
import { buildPlaceholderAtlas, TextureAtlas } from './atlas'
import { CameraRig } from './camera'
import { findSpawnNear, WalkCameraStrategy } from './camera-walk'
import { DayNightCycle } from './day-night'
import { BuildFeedback } from './feedback'
import { LightingEngine } from './lighting'
import { DEFAULT_BAKE_ENV, Mesher, type AoParams, type BakeEnvironment } from './mesher'
import { MotionPreference } from './motion-preference'
import { loadPalette, samplePalette, type RGB, type ThemePalette } from './palette'
import { Picker } from './picker'
import { ResidentRenderer, type ResidentRenderState } from './residents'
import { VoxelRenderer, type EnvironmentState } from './renderer'
import { WeatherSystem, type WeatherState } from './weather'
import { WorldModel } from './world-model'

function rgbToHex(c: RGB): number {
  return (Math.round(Math.min(1, c[0]) * 255) << 16)
    | (Math.round(Math.min(1, c[1]) * 255) << 8)
    | Math.round(Math.min(1, c[2]) * 255)
}

export interface FrameUpdatable { update(dt: number): void }

/**
 * VoxelEngine 门面：文档进、画面出、编辑事件出。
 * 不认识"世界状态""访客"等产品概念（那是 bridge 的事）。
 */
export class VoxelEngine {
  registry: BlockRegistry | null = null
  readonly atlas = new TextureAtlas()
  readonly renderer = new VoxelRenderer(this.atlas)
  readonly cameraRig = new CameraRig()
  world: WorldModel | null = null
  lighting: LightingEngine | null = null
  mesher: Mesher | null = null
  bakeEnv: BakeEnvironment = { ...DEFAULT_BAKE_ENV, faceShade: { ...DEFAULT_BAKE_ENV.faceShade } }
  palette: ThemePalette | null = null
  readonly motion = new MotionPreference()
  dayNight: DayNightCycle | null = null
  weather: WeatherSystem | null = null
  ambient: AmbientAnimator | null = null
  residents: ResidentRenderer | null = null
  picker: Picker | null = null
  feedback: BuildFeedback | null = null

  private pendingSkyLevel = 15
  private currentTimeOfDay = 0.5
  private weatherMod = { fogBoost: 0, dim: 0 }

  private canvas: HTMLCanvasElement | null = null
  private running = false
  private raf = 0
  private lastTime = 0
  private updatables: FrameUpdatable[] = []
  private resizeObserver: ResizeObserver | null = null
  /** 每帧回调（fps 探针等） */
  onFrame: ((dt: number) => void) | null = null

  mount(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    this.renderer.mount(canvas, () => this.cameraRig.camera)
    this.cameraRig.attach(canvas)
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
  }

  loadDocument(doc: VoxelDocument): void {
    if (!this.registry) throw new Error('loadAssets must be called before loadDocument')
    this.cameraRig.setMode('orbit') // 文档重载:重置回上帝视角(S2b)
    this.weather?.dispose()
    this.residents?.dispose()
    this.feedback?.dispose()
    this.world = new WorldModel(doc)
    this.lighting = new LightingEngine(this.world, this.registry)
    this.lighting.computeAll()
    this.mesher = new Mesher(this.world, this.registry, this.atlas, this.lighting)
    this.renderer.removeSections([...this.allSectionKeys()])
    this.renderer.updateSections(this.mesher.bakeAll(this.bakeEnv, this.aoParams))
    this.cameraRig.fitToWorld(doc.size)
    this.weather = new WeatherSystem(
      this.renderer.scene, this.world, this.registry, this.motion,
      { setWeatherEnv: (mod) => { this.weatherMod = mod; this.applyPalette() } },
      () => { const t = this.cameraRig.state.target; return { x: t.x, y: t.y, z: t.z } },
    )
    this.residents = new ResidentRenderer(this.renderer.scene, this.world, this.registry)
    this.picker = new Picker(this.world)
    this.feedback = new BuildFeedback(this.renderer.scene)
    this.registerLightEmitters()
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

  setBaseEnvironment(_env: { skyColor: THREE.ColorRepresentation; fogColor: THREE.ColorRepresentation }): void {
    // 昼夜 sink 协议保留；天色/雾色现由 applyPalette 每帧从色彩中枢采样
    this.applyPalette()
  }

  /** 色彩中枢分发：每帧采样调色（天空/雾/后处理平滑），96 步量化仅控制重烘焙 */
  private applyPalette(): void {
    if (!this.palette) return
    const resolved = samplePalette(this.palette, this.currentTimeOfDay, this.weatherMod)
    const env: EnvironmentState = { fogColor: rgbToHex(resolved.fog.color), fogDensity: resolved.fog.density }
    this.renderer.setEnvironment(env)
    this.renderer.setDirectLight(resolved.direct, this.palette.shadow, this.palette.ambientLift)
    const time = this.renderer.shaderUniforms.uTime.value
    const motion = this.motion.animationTimeScale()
    this.renderer.sky?.update(resolved.sky, resolved.fog.color, time, motion)
    this.renderer.post?.update(resolved.post, { motion, time })
  }

  private get aoParams(): AoParams | undefined {
    return this.palette ? { curve: this.palette.aoCurve, strength: this.palette.aoStrength } : undefined
  }

  /**
   * 双视角切换(S2b F1):orbit 上帝视角 ⇄ walk 第一视角。
   * walk:orbit 注视点投影落点搜索,找不到可站立位置则不切换。
   */
  setCameraMode(mode: 'orbit' | 'walk'): { ok: boolean; reason?: string } {
    if (mode === 'walk') {
      if (!this.world || !this.registry) return { ok: false, reason: '世界尚未加载,无法进入第一视角' }
      const target = this.cameraRig.state.target
      const spawn = findSpawnNear(this.world, this.registry, {
        x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z),
      })
      if (!spawn) return { ok: false, reason: '注视点附近没有可站立的位置' }
      this.cameraRig.registerWalkStrategy(new WalkCameraStrategy(this.world, this.registry, spawn))
    }
    return this.cameraRig.setMode(mode)
  }

  get cameraMode(): 'orbit' | 'walk' {
    return this.cameraRig.mode as 'orbit' | 'walk'
  }

  setTimeOfDay(t: number): void {
    this.currentTimeOfDay = ((t % 1) + 1) % 1
    this.dayNight?.setTimeOfDay(t)
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
      this.cameraRig.update(dt)
      this.updatablesTick(dt)
      for (const u of this.updatables) u.update(dt)
      this.applyPalette() // 天空/雾/后处理/直射光每帧平滑；重烘焙仍由 96 步量化控制
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
  }

  stop(): void {
    this.running = false
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf)
  }

  dispose(): void {
    this.stop()
    this.resizeObserver?.disconnect()
    this.cameraRig.detach()
    this.weather?.dispose()
    this.ambient?.dispose()
    this.residents?.dispose()
    this.feedback?.dispose()
    this.motion.dispose()
    this.renderer.dispose()
    this.canvas = null
  }
}

export * from './ambient'
export * from './atlas'
export * from './camera'
export * from './camera-walk'
export * from './day-night'
export * from './lighting'
export * from './mesher'
export * from './palette'
export * from './sky'
export * from './post'
export * from './feedback'
export * from './motion-preference'
export * from './pathfinding'
export * from './picker'
export * from './residents'
export * from './renderer'
export * from './weather'
export * from './world-model'
