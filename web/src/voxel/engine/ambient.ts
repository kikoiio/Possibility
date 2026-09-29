import * as THREE from 'three'
import type { VoxelCoord } from '@possibility/voxel-contract'
import type { MotionPreference } from './motion-preference'
import type { ShaderUniforms } from './renderer'

export type EmitterKind = 'smoke' | 'glow'

export interface EmitterHandle {
  kind: EmitterKind
  at: VoxelCoord
  dispose(): void
}

const SMOKE_MAX = 320
const SMOKE_LIFE = 4.5

/**
 * 循环环境动效：驱动植被摇摆/水面扰动的着色器时钟，
 * 管理炊烟粒子发射器与灯火闪烁（F13）。
 */
export class AmbientAnimator {
  private time = 0
  private emitters: Array<{ kind: EmitterKind; at: VoxelCoord; cooldown: number }> = []

  private smokePoints: THREE.Points
  private smokePos = new Float32Array(SMOKE_MAX * 3)
  private smokeColor = new Float32Array(SMOKE_MAX * 3)
  private smokeAge = new Float32Array(SMOKE_MAX).fill(SMOKE_LIFE + 1)
  private smokeHead = 0

  private glowPoints: THREE.Points | null = null
  private glowMaterial = new THREE.PointsMaterial({
    color: 0xffc978, size: 0.5, transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  })

  /** S3b 风格包:粒子密度倍率(默认 1),影响炊烟发射频率 */
  private particleDensity = 1

  /** 风格包预设下发(0–2);reduced-motion 路径在其下游不受影响 */
  setParticleDensity(mult: number): void {
    this.particleDensity = Math.min(2, Math.max(0, mult))
  }

  constructor(
    private scene: THREE.Scene,
    private uniforms: ShaderUniforms,
    private motion: MotionPreference,
  ) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.smokePos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(this.smokeColor, 3))
    this.smokePoints = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.35, transparent: true, opacity: 0.55, vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }))
    this.smokePoints.frustumCulled = false
    scene.add(this.smokePoints)
  }

  /** 登记持续发射器：炊烟（kind='smoke'）、灯火（kind='glow'） */
  registerEmitter(kind: EmitterKind, at: VoxelCoord): EmitterHandle {
    const emitter = { kind, at: { ...at }, cooldown: Math.random() * 0.5 }
    this.emitters.push(emitter)
    if (kind === 'glow') this.rebuildGlow()
    return {
      kind, at,
      dispose: () => {
        this.emitters = this.emitters.filter((e) => e !== emitter)
        if (kind === 'glow') this.rebuildGlow()
      },
    }
  }

  private rebuildGlow(): void {
    if (this.glowPoints) {
      this.scene.remove(this.glowPoints)
      this.glowPoints.geometry.dispose()
      this.glowPoints = null
    }
    const glows = this.emitters.filter((e) => e.kind === 'glow')
    if (glows.length === 0) return
    const pos = new Float32Array(glows.length * 3)
    glows.forEach((e, i) => pos.set([e.at.x + 0.5, e.at.y + 0.6, e.at.z + 0.5], i * 3))
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.glowPoints = new THREE.Points(geo, this.glowMaterial)
    this.glowPoints.frustumCulled = false
    this.scene.add(this.glowPoints)
  }

  private spawnSmoke(at: VoxelCoord): void {
    const i = this.smokeHead
    this.smokeHead = (this.smokeHead + 1) % SMOKE_MAX
    this.smokePos[i * 3] = at.x + 0.5 + (Math.random() - 0.5) * 0.2
    this.smokePos[i * 3 + 1] = at.y + 0.8
    this.smokePos[i * 3 + 2] = at.z + 0.5 + (Math.random() - 0.5) * 0.2
    this.smokeAge[i] = 0
  }

  update(dt: number): void {
    const timeScale = this.motion.animationTimeScale()
    this.time += dt * timeScale
    this.uniforms.uTime.value = this.time
    this.uniforms.uMotion.value = timeScale

    // 灯火闪烁：光强噪声（亮度脉动）
    this.glowMaterial.opacity = timeScale === 0 ? 0.3 : 0.3 + 0.12 * Math.sin(this.time * 5.3) * Math.sin(this.time * 2.1 + 1.3)

    // 炊烟
    const particleScale = this.motion.particleScale()
    this.smokePoints.visible = particleScale > 0
    if (particleScale > 0) {
      for (const emitter of this.emitters) {
        if (emitter.kind !== 'smoke') continue
        emitter.cooldown -= dt
        if (emitter.cooldown <= 0) {
          emitter.cooldown = (0.35 + Math.random() * 0.3) / Math.max(0.01, this.particleDensity)
          this.spawnSmoke(emitter.at)
        }
      }
      for (let i = 0; i < SMOKE_MAX; i++) {
        if (this.smokeAge[i] > SMOKE_LIFE) continue
        this.smokeAge[i] += dt
        this.smokePos[i * 3 + 1] += dt * 0.55
        this.smokePos[i * 3] += Math.sin(this.time * 0.8 + i) * dt * 0.12
        const fade = Math.max(0, 1 - this.smokeAge[i] / SMOKE_LIFE)
        const c = 0.45 * fade
        this.smokeColor[i * 3] = c
        this.smokeColor[i * 3 + 1] = c
        this.smokeColor[i * 3 + 2] = c * 1.05
        if (this.smokeAge[i] > SMOKE_LIFE) this.smokePos[i * 3 + 1] = -100
      }
      this.smokePoints.geometry.attributes.position.needsUpdate = true
      this.smokePoints.geometry.attributes.color.needsUpdate = true
    }
  }

  dispose(): void {
    this.scene.remove(this.smokePoints)
    this.smokePoints.geometry.dispose()
    ;(this.smokePoints.material as THREE.Material).dispose()
    if (this.glowPoints) {
      this.scene.remove(this.glowPoints)
      this.glowPoints.geometry.dispose()
    }
    this.glowMaterial.dispose()
    this.emitters = []
  }
}
