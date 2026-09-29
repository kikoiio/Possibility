import {
  createBlockRegistry,
  type BlockRegistry, type EditResult, type SectionKey, type VoxelDocument,
} from '@possibility/voxel-contract'
import * as THREE from 'three'
import { AmbientAnimator } from './ambient'
import { buildPlaceholderAtlas, TextureAtlas } from './atlas'
import { CameraRig } from './camera'
import { DayNightCycle } from './day-night'
import { BuildFeedback } from './feedback'
import { LightingEngine } from './lighting'
import { DEFAULT_BAKE_ENV, Mesher, type BakeEnvironment } from './mesher'
import { MotionPreference } from './motion-preference'
import { Picker } from './picker'
import { ResidentRenderer, type ResidentRenderState } from './residents'
import { VoxelRenderer, type EnvironmentState } from './renderer'
import { WeatherSystem, type WeatherState } from './weather'
import { WorldModel } from './world-model'

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
  readonly motion = new MotionPreference()
  dayNight: DayNightCycle | null = null
  weather: WeatherSystem | null = null
  ambient: AmbientAnimator | null = null
  residents: ResidentRenderer | null = null
  picker: Picker | null = null
  feedback: BuildFeedback | null = null

  private pendingSkyLevel = 15
  private baseEnv = { skyColor: 0x9ec8e8 as THREE.ColorRepresentation, fogColor: 0x9ec8e8 as THREE.ColorRepresentation }
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
    this.renderer.mount(canvas)
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

  /** 加载主题方块集与图集；placeholder 供开发期无美术资产时使用 */
  async loadAssets(theme: string, opts: { placeholder?: boolean } = {}): Promise<void> {
    this.registry = createBlockRegistry(theme)
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
    this.weather?.dispose()
    this.residents?.dispose()
    this.feedback?.dispose()
    this.world = new WorldModel(doc)
    this.lighting = new LightingEngine(this.world, this.registry)
    this.lighting.computeAll()
    this.mesher = new Mesher(this.world, this.registry, this.atlas, this.lighting)
    this.renderer.removeSections([...this.allSectionKeys()])
    this.renderer.updateSections(this.mesher.bakeAll(this.bakeEnv))
    this.cameraRig.fitToWorld(doc.size)
    this.weather = new WeatherSystem(
      this.renderer.scene, this.world, this.registry, this.motion,
      { setWeatherEnv: (mod) => { this.weatherMod = mod; this.composeEnvironment() } },
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

  setBaseEnvironment(env: { skyColor: THREE.ColorRepresentation; fogColor: THREE.ColorRepresentation }): void {
    this.baseEnv = env
    this.composeEnvironment()
  }

  /** 基础环境（昼夜）× 天气修饰（雾加成 / 压暗）合成最终渲染环境 */
  private composeEnvironment(): void {
    const sky = new THREE.Color(this.baseEnv.skyColor).multiplyScalar(1 - this.weatherMod.dim)
    const fog = new THREE.Color(this.baseEnv.fogColor).lerp(new THREE.Color(0x8a939e), this.weatherMod.dim)
    const env: EnvironmentState = { skyColor: sky, fogColor: fog, fogDensity: this.weatherMod.fogBoost }
    this.renderer.setEnvironment(env)
  }

  setTimeOfDay(t: number): void {
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
    const baked = [...rebake].map((key) => this.mesher!.bakeSection(key, this.bakeEnv))
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
    this.renderer.updateSections(this.mesher.bakeAll(this.bakeEnv))
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
      this.onFrame?.(dt)
      this.renderer.renderFrame(dt, this.cameraRig.camera)
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
export * from './day-night'
export * from './lighting'
export * from './mesher'
export * from './feedback'
export * from './motion-preference'
export * from './pathfinding'
export * from './picker'
export * from './residents'
export * from './renderer'
export * from './weather'
export * from './world-model'
