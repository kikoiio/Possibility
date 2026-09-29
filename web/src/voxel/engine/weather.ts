import * as THREE from 'three'
import { SECTION_SIZE, type BlockRegistry, type SectionKey } from '@possibility/voxel-contract'
import type { MotionPreference } from './motion-preference'
import type { WorldModel } from './world-model'

export interface WeatherState { rain?: number; snow?: number; fog?: number }

export interface WeatherEnvSink {
  /** 天气对渲染环境的修饰：雾浓度加成、天色压暗 */
  setWeatherEnv(mod: { fogBoost: number; dim: number }): void
}

// ── 纯函数助手（单测覆盖）──────────────────────

/** 柱顶高度：从世界顶部向下第一个"可落点"（不透明实体或流体表面）的顶面 y */
export function columnTopY(world: WorldModel, registry: BlockRegistry, x: number, z: number): number {
  const { height } = world.doc.size
  for (let y = height - 1; y >= 0; y--) {
    const id = world.getBlock({ x, y, z })
    if (id === 'air') continue
    const type = registry.get(id)
    if (!type) continue
    if ((type.solid && !type.translucent) || type.category === 'fluid') return y + 1
  }
  return 0
}

/** 某格是否"朝天暴露"：正上方无遮挡（积雪判定；檐下不积雪） */
export function isSkyExposed(world: WorldModel, registry: BlockRegistry, x: number, y: number, z: number): boolean {
  const { height } = world.doc.size
  for (let yy = y + 1; yy < height; yy++) {
    const type = registry.get(world.getBlock({ x, y: yy, z }))
    if (type && type.solid && !type.translucent) return false
  }
  return true
}

export interface SnowQuad { x: number; y: number; z: number }

/** 收集世界里的可积雪顶面（accumulatesSnow 且朝天暴露），按节分组 */
export function collectSnowQuads(world: WorldModel, registry: BlockRegistry): Map<SectionKey, SnowQuad[]> {
  const out = new Map<SectionKey, SnowQuad[]>()
  const { width, height, depth } = world.doc.size
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const type = registry.get(world.getBlock({ x, y, z }))
        if (!type?.accumulatesSnow) continue
        const above = registry.get(world.getBlock({ x, y: y + 1, z }))
        if (above && above.solid) continue
        if (!isSkyExposed(world, registry, x, y, z)) continue
        const key: SectionKey = `${Math.floor(x / SECTION_SIZE)},${Math.floor(y / SECTION_SIZE)},${Math.floor(z / SECTION_SIZE)}`
        const list = out.get(key) ?? []
        list.push({ x, y: y + 1, z })
        out.set(key, list)
      }
    }
  }
  return out
}

// ── 粒子系统 ──────────────────────────────────

const RAIN_MAX = 900
const SNOW_MAX = 700
const SPLASH_MAX = 260
const RANGE_XZ = 26
const RANGE_Y = 18

/** 雨（降落线迹 + 地面溅落）、雪（飘落）、雾、暴露面积雪（F8/F9/F10） */
export class WeatherSystem {
  private target: Required<WeatherState> = { rain: 0, snow: 0, fog: 0 }
  private current: Required<WeatherState> = { rain: 0, snow: 0, fog: 0 }

  private rainLines: THREE.LineSegments
  private rainPos: Float32Array
  private snowPoints: THREE.Points
  private snowPos: Float32Array
  private snowPhase: Float32Array
  private splashPoints: THREE.Points
  private splashPos: Float32Array
  private splashLife: Float32Array
  private splashHead = 0

  private snowMeshes = new Map<SectionKey, THREE.Mesh>()
  private snowMaterial = new THREE.MeshBasicMaterial({ color: 0xf4f8ff, transparent: true, opacity: 0 })
  private accumulation = 0

  private groundCache = new Map<string, number>()
  private unsubscribeWorld: (() => void) | null = null

  constructor(
    private scene: THREE.Scene,
    private world: WorldModel,
    private registry: BlockRegistry,
    private motion: MotionPreference,
    private envSink: WeatherEnvSink,
    private getFocus: () => { x: number; y: number; z: number },
  ) {
    this.rainPos = new Float32Array(RAIN_MAX * 2 * 3)
    this.scatter(this.rainPos, true)
    const rainGeo = new THREE.BufferGeometry()
    rainGeo.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3))
    this.rainLines = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0x9fb8d8, transparent: true, opacity: 0.55 }))
    this.rainLines.frustumCulled = false
    this.rainLines.visible = false
    scene.add(this.rainLines)

    this.snowPos = new Float32Array(SNOW_MAX * 3)
    this.snowPhase = new Float32Array(SNOW_MAX)
    this.scatter(this.snowPos, false)
    for (let i = 0; i < SNOW_MAX; i++) this.snowPhase[i] = Math.random() * Math.PI * 2
    const snowGeo = new THREE.BufferGeometry()
    snowGeo.setAttribute('position', new THREE.BufferAttribute(this.snowPos, 3))
    this.snowPoints = new THREE.Points(snowGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.16, transparent: true, opacity: 0.9, sizeAttenuation: true }))
    this.snowPoints.frustumCulled = false
    this.snowPoints.visible = false
    scene.add(this.snowPoints)

    this.splashPos = new Float32Array(SPLASH_MAX * 3)
    this.splashLife = new Float32Array(SPLASH_MAX)
    const splashGeo = new THREE.BufferGeometry()
    splashGeo.setAttribute('position', new THREE.BufferAttribute(this.splashPos, 3))
    this.splashPoints = new THREE.Points(splashGeo, new THREE.PointsMaterial({ color: 0xcfe0f0, size: 0.12, transparent: true, opacity: 0.8 }))
    this.splashPoints.frustumCulled = false
    this.splashPoints.visible = false
    scene.add(this.splashPoints)

    this.rebuildSnowLayer()
    this.unsubscribeWorld = world.subscribe(() => {
      this.groundCache.clear()
      this.rebuildSnowLayer()
    })
  }

  private scatter(buffer: Float32Array, streaks: boolean): void {
    const focus = this.getFocus()
    const count = streaks ? RAIN_MAX : SNOW_MAX
    for (let i = 0; i < count; i++) {
      const base = streaks ? i * 6 : i * 3
      const x = focus.x + (Math.random() - 0.5) * RANGE_XZ * 2
      const y = focus.y + Math.random() * RANGE_Y
      const z = focus.z + (Math.random() - 0.5) * RANGE_XZ * 2
      buffer[base] = x
      buffer[base + 1] = y
      buffer[base + 2] = z
      if (streaks) {
        buffer[base + 3] = x
        buffer[base + 4] = y - 0.55
        buffer[base + 5] = z
      }
    }
  }

  setWeather(state: WeatherState): void {
    this.target = {
      rain: THREE.MathUtils.clamp(state.rain ?? 0, 0, 1),
      snow: THREE.MathUtils.clamp(state.snow ?? 0, 0, 1),
      fog: THREE.MathUtils.clamp(state.fog ?? 0, 0, 1),
    }
  }

  get state(): Required<WeatherState> {
    return { ...this.current }
  }

  private groundY(x: number, z: number): number {
    const key = `${Math.floor(x)},${Math.floor(z)}`
    let y = this.groundCache.get(key)
    if (y === undefined) {
      y = columnTopY(this.world, this.registry, Math.floor(x), Math.floor(z))
      this.groundCache.set(key, y)
    }
    return y
  }

  private spawnSplash(x: number, y: number, z: number): void {
    const i = this.splashHead
    this.splashHead = (this.splashHead + 1) % SPLASH_MAX
    this.splashPos[i * 3] = x
    this.splashPos[i * 3 + 1] = y + 0.05
    this.splashPos[i * 3 + 2] = z
    this.splashLife[i] = 0.3
  }

  /** 积雪层：暴露顶面的白色覆盖网格，随降雪渐进显隐 */
  private rebuildSnowLayer(): void {
    for (const mesh of this.snowMeshes.values()) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()
    }
    this.snowMeshes.clear()
    for (const [key, quads] of collectSnowQuads(this.world, this.registry)) {
      const positions = new Float32Array(quads.length * 4 * 3)
      const indices = new Uint32Array(quads.length * 6)
      quads.forEach((q, i) => {
        const base = i * 12
        const y = q.y + 0.03
        positions.set([q.x, y, q.z, q.x, y, q.z + 1, q.x + 1, y, q.z, q.x + 1, y, q.z + 1], base)
        indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6)
      })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setIndex(new THREE.BufferAttribute(indices, 1))
      const mesh = new THREE.Mesh(geo, this.snowMaterial)
      this.snowMeshes.set(key, mesh)
      this.scene.add(mesh)
    }
  }

  update(dt: number): void {
    const rate = dt * 1.6 // 天气过渡速度
    this.current.rain = THREE.MathUtils.clamp(this.current.rain + Math.sign(this.target.rain - this.current.rain) * rate, 0, 1)
    if (Math.abs(this.target.rain - this.current.rain) < rate) this.current.rain = this.target.rain
    this.current.snow = THREE.MathUtils.clamp(this.current.snow + Math.sign(this.target.snow - this.current.snow) * rate, 0, 1)
    if (Math.abs(this.target.snow - this.current.snow) < rate) this.current.snow = this.target.snow
    this.current.fog = THREE.MathUtils.clamp(this.current.fog + Math.sign(this.target.fog - this.current.fog) * rate, 0, 1)
    if (Math.abs(this.target.fog - this.current.fog) < rate) this.current.fog = this.target.fog

    const scale = this.motion.particleScale()
    const focus = this.getFocus()

    // 环境：雾浓度 + 雨雪压暗天色
    this.envSink.setWeatherEnv({
      fogBoost: this.current.fog * 0.75 + this.current.rain * 0.2,
      dim: this.current.rain * 0.35 + this.current.snow * 0.2 + this.current.fog * 0.15,
    })

    // 雨
    const rainActive = this.current.rain > 0.02 && scale > 0
    this.rainLines.visible = rainActive
    this.splashPoints.visible = rainActive
    if (rainActive) {
      const fall = dt * 22
      const activeDrops = Math.floor(RAIN_MAX * this.current.rain)
      for (let i = 0; i < activeDrops; i++) {
        const base = i * 6
        this.rainPos[base + 1] -= fall
        this.rainPos[base + 4] -= fall
        if (this.rainPos[base + 4] < this.groundY(this.rainPos[base], this.rainPos[base + 2])) {
          this.spawnSplash(this.rainPos[base], this.groundY(this.rainPos[base], this.rainPos[base + 2]), this.rainPos[base + 2])
          const x = focus.x + (Math.random() - 0.5) * RANGE_XZ * 2
          const z = focus.z + (Math.random() - 0.5) * RANGE_XZ * 2
          const y = focus.y + RANGE_Y * (0.7 + Math.random() * 0.3)
          this.rainPos[base] = x
          this.rainPos[base + 1] = y
          this.rainPos[base + 2] = z
          this.rainPos[base + 3] = x
          this.rainPos[base + 4] = y - 0.55
          this.rainPos[base + 5] = z
        }
      }
      // 未激活的雨滴藏到地下
      for (let i = activeDrops; i < RAIN_MAX; i++) {
        this.rainPos[i * 6 + 1] = -100
        this.rainPos[i * 6 + 4] = -100
      }
      this.rainLines.geometry.attributes.position.needsUpdate = true

      for (let i = 0; i < SPLASH_MAX; i++) {
        if (this.splashLife[i] <= 0) continue
        this.splashLife[i] -= dt
        this.splashPos[i * 3 + 1] += dt * 0.6
        if (this.splashLife[i] <= 0) this.splashPos[i * 3 + 1] = -100
      }
      this.splashPoints.geometry.attributes.position.needsUpdate = true
    }

    // 雪
    const snowActive = this.current.snow > 0.02 && scale > 0
    this.snowPoints.visible = snowActive
    if (snowActive) {
      const fall = dt * 2.2
      const active = Math.floor(SNOW_MAX * this.current.snow)
      for (let i = 0; i < active; i++) {
        const base = i * 3
        this.snowPhase[i] += dt
        this.snowPos[base] += Math.sin(this.snowPhase[i]) * dt * 0.6
        this.snowPos[base + 1] -= fall
        if (this.snowPos[base + 1] < this.groundY(this.snowPos[base], this.snowPos[base + 2])) {
          this.snowPos[base] = focus.x + (Math.random() - 0.5) * RANGE_XZ * 2
          this.snowPos[base + 2] = focus.z + (Math.random() - 0.5) * RANGE_XZ * 2
          this.snowPos[base + 1] = focus.y + RANGE_Y * (0.7 + Math.random() * 0.3)
        }
      }
      for (let i = active; i < SNOW_MAX; i++) this.snowPos[i * 3 + 1] = -100
      this.snowPoints.geometry.attributes.position.needsUpdate = true
    }

    // 积雪渐进显隐（降雪时累积，晴天后消融）
    const accumulationTarget = this.current.snow > 0.3 ? 1 : 0
    const accumRate = accumulationTarget > this.accumulation ? dt * 0.08 : dt * 0.15
    this.accumulation = THREE.MathUtils.clamp(
      this.accumulation + Math.sign(accumulationTarget - this.accumulation) * accumRate, 0, 1,
    )
    this.snowMaterial.opacity = this.accumulation * 0.95
    for (const mesh of this.snowMeshes.values()) mesh.visible = this.accumulation > 0.01
  }

  dispose(): void {
    this.unsubscribeWorld?.()
    for (const obj of [this.rainLines, this.snowPoints, this.splashPoints]) {
      this.scene.remove(obj)
      obj.geometry.dispose()
      ;(obj.material as THREE.Material).dispose()
    }
    for (const mesh of this.snowMeshes.values()) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()
    }
    this.snowMaterial.dispose()
  }
}
