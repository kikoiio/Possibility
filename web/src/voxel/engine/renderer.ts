import * as THREE from 'three'
import type { SectionKey } from '@possibility/voxel-contract'
import type { TextureAtlas } from './atlas'
import type { SectionGeometry } from './mesher'
import { PostPipeline } from './post'
import { SkyDome } from './sky'

export interface EnvironmentState {
  fogColor: THREE.ColorRepresentation
  /** 最终雾密度（已含调色数据的 fogDensityScale），0 = 无雾 */
  fogDensity: number
}

export class WebGL2UnavailableError extends Error {
  constructor() {
    super('此浏览器不支持 WebGL2，无法渲染体素世界。请使用最新版 Chrome / Edge / Safari。')
    this.name = 'WebGL2UnavailableError'
  }
}

/** 循环动效的共享 uniforms（AmbientAnimator 每帧驱动；减少动态效果时 uMotion=0） */
export interface ShaderUniforms {
  uTime: { value: number }
  uMotion: { value: number }
}

/** 植被摇摆：按 aSway 权重在水平面微位移 */
function injectSway(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: ShaderUniforms): void {
  shader.uniforms.uTime = uniforms.uTime
  shader.uniforms.uMotion = uniforms.uMotion
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nattribute float aSway;\nuniform float uTime;\nuniform float uMotion;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n{\n  float phase = uTime * 1.6 + position.x * 0.8 + position.z * 0.6;\n  transformed.x += sin(phase) * 0.06 * aSway * uMotion;\n  transformed.z += cos(phase * 0.83) * 0.045 * aSway * uMotion;\n}`)
}

/** 水面 UV 扰动：按 aWater 标记偏移贴图采样 */
function injectWater(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: ShaderUniforms): void {
  shader.uniforms.uTime = uniforms.uTime
  shader.uniforms.uMotion = uniforms.uMotion
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nattribute float aWater;\nuniform float uTime;\nuniform float uMotion;`)
    .replace('#include <uv_vertex>', `#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv += vec2(sin(uTime * 1.2 + position.x * 1.7 + position.z), cos(uTime * 0.9 + position.z * 1.3)) * 0.015 * aWater * uMotion;\n#endif`)
}

/** three.js 场景装配：节几何管理、天空穹顶、雾、后处理、不透明/透明双渲染层 */
export class VoxelRenderer {
  readonly scene = new THREE.Scene()
  private three: THREE.WebGLRenderer | null = null
  private sectionMeshes = new Map<SectionKey, { opaque: THREE.Mesh | null; translucent: THREE.Mesh | null }>()
  private opaqueMaterial: THREE.MeshBasicMaterial
  private translucentMaterial: THREE.MeshBasicMaterial
  readonly shaderUniforms: ShaderUniforms = { uTime: { value: 0 }, uMotion: { value: 1 } }
  /** 天空穹顶与后处理链（mount 后可用；由引擎门面每帧驱动） */
  sky: SkyDome | null = null
  post: PostPipeline | null = null

  constructor(private atlas: TextureAtlas) {
    this.opaqueMaterial = new THREE.MeshBasicMaterial({ vertexColors: true })
    this.opaqueMaterial.onBeforeCompile = (shader) => injectSway(shader, this.shaderUniforms)
    this.translucentMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false,
    })
    this.translucentMaterial.onBeforeCompile = (shader) => injectWater(shader, this.shaderUniforms)
    this.scene.fog = new THREE.FogExp2(0x0, 0)
  }

  /** 挂载画布；WebGL2 缺失时抛出明确错误（N9）。抗锯齿由后处理链 RT 的 MSAA 承担 */
  mount(canvas: HTMLCanvasElement, cameraProvider: () => THREE.Camera): void {
    if (!canvas.getContext('webgl2')) throw new WebGL2UnavailableError()
    this.three = new THREE.WebGLRenderer({ canvas, antialias: false })
    this.three.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.resize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height)
    this.sky = new SkyDome()
    this.scene.add(this.sky.mesh)
    this.post = new PostPipeline(this.three, this.scene, cameraProvider)
    if (this.atlas.texture) this.setAtlasTexture()
  }

  setAtlasTexture(): void {
    this.opaqueMaterial.map = this.atlas.texture
    this.translucentMaterial.map = this.atlas.texture
    this.opaqueMaterial.needsUpdate = true
    this.translucentMaterial.needsUpdate = true
  }

  resize(width: number, height: number): void {
    this.three?.setSize(width, height, false)
    this.post?.resize(width, height)
  }

  get size(): { width: number; height: number } {
    const canvas = this.three?.domElement
    return { width: canvas?.clientWidth ?? 1, height: canvas?.clientHeight ?? 1 }
  }

  private buildMesh(data: SectionGeometry['opaque'], material: THREE.Material): THREE.Mesh | null {
    if (data.faceCount === 0) return null
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2))
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3))
    geometry.setAttribute('aSway', new THREE.BufferAttribute(data.sway, 1))
    geometry.setAttribute('aWater', new THREE.BufferAttribute(data.water, 1))
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1))
    return new THREE.Mesh(geometry, material)
  }

  /** 增删换节几何：只动传入的节，其余不闪动（F4） */
  updateSections(geometries: SectionGeometry[]): void {
    for (const geo of geometries) {
      const prev = this.sectionMeshes.get(geo.key)
      if (prev) {
        for (const mesh of [prev.opaque, prev.translucent]) {
          if (mesh) {
            this.scene.remove(mesh)
            mesh.geometry.dispose()
          }
        }
      }
      const opaque = this.buildMesh(geo.opaque, this.opaqueMaterial)
      const translucent = this.buildMesh(geo.translucent, this.translucentMaterial)
      if (opaque) this.scene.add(opaque)
      if (translucent) this.scene.add(translucent)
      this.sectionMeshes.set(geo.key, { opaque, translucent })
    }
  }

  removeSections(keys: SectionKey[]): void {
    for (const key of keys) {
      const entry = this.sectionMeshes.get(key)
      if (!entry) continue
      for (const mesh of [entry.opaque, entry.translucent]) {
        if (mesh) {
          this.scene.remove(mesh)
          mesh.geometry.dispose()
        }
      }
      this.sectionMeshes.delete(key)
    }
  }

  setEnvironment(env: EnvironmentState): void {
    // 雾色兜底：穹顶未覆盖/失败时背景与雾一致，不出现断层
    this.scene.background = new THREE.Color(env.fogColor)
    const fog = this.scene.fog as THREE.FogExp2
    fog.color = new THREE.Color(env.fogColor)
    fog.density = env.fogDensity
  }

  renderFrame(dt: number, camera: THREE.Camera): void {
    if (!this.three) return
    this.sky?.follow(camera)
    if (this.post?.enabled) this.post.render(dt)
    else this.three.render(this.scene, camera)
  }

  get canvas(): HTMLCanvasElement | null {
    return this.three?.domElement ?? null
  }

  dispose(): void {
    this.removeSections([...this.sectionMeshes.keys()])
    if (this.sky) {
      this.scene.remove(this.sky.mesh)
      this.sky.dispose()
      this.sky = null
    }
    this.post?.dispose()
    this.post = null
    this.opaqueMaterial.dispose()
    this.translucentMaterial.dispose()
    this.three?.dispose()
    this.three = null
  }
}
