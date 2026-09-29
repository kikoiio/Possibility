import * as THREE from 'three'
import type { SectionKey } from '@possibility/voxel-contract'
import type { TextureAtlas } from './atlas'
import type { SectionGeometry } from './mesher'
import { isSoftwareGL, PostPipeline } from './post'
import type { ResolvedPalette, ShadowConfig } from './palette'
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

/** three.js 场景装配：节几何管理、天空穹顶、雾、直射光阴影、后处理、不透明/透明双渲染层 */
export class VoxelRenderer {
  readonly scene = new THREE.Scene()
  private three: THREE.WebGLRenderer | null = null
  private sectionMeshes = new Map<SectionKey, { opaque: THREE.Mesh | null; translucent: THREE.Mesh | null }>()
  private opaqueMaterial: THREE.MeshLambertMaterial
  private translucentMaterial: THREE.MeshLambertMaterial
  readonly shaderUniforms: ShaderUniforms = { uTime: { value: 0 }, uMotion: { value: 1 } }
  /** 天空穹顶与后处理链（mount 后可用；由引擎门面每帧驱动） */
  sky: SkyDome | null = null
  post: PostPipeline | null = null
  /** 直射光（太阳/月亮,投影）+ 环境光基底（标定「无直射=S1 观感」） */
  private directLight: THREE.DirectionalLight | null = null
  private ambientLight: THREE.AmbientLight | null = null

  constructor(private atlas: TextureAtlas) {
    this.opaqueMaterial = new THREE.MeshLambertMaterial({ vertexColors: true })
    this.opaqueMaterial.onBeforeCompile = (shader) => injectSway(shader, this.shaderUniforms)
    this.translucentMaterial = new THREE.MeshLambertMaterial({
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
    this.three.shadowMap.enabled = true
    this.three.shadowMap.type = THREE.PCFSoftShadowMap
    this.resize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height)
    this.sky = new SkyDome()
    this.scene.add(this.sky.mesh)
    this.post = new PostPipeline(this.three, this.scene, cameraProvider)
    this.ambientLight = new THREE.AmbientLight(0xffffff, 3.0)
    this.directLight = new THREE.DirectionalLight(0xffffff, 0)
    this.directLight.castShadow = true
    this.scene.add(this.ambientLight, this.directLight, this.directLight.target)
    if (isSoftwareGL(this.three)) this.softwareGL = true
    if (this.atlas.texture) this.setAtlasTexture()
  }

  private softwareGL = false

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
    const mesh = new THREE.Mesh(geometry, material)
    // 不透明层投影+接收;透明层(水)只接收不投影
    mesh.castShadow = material !== this.translucentMaterial
    mesh.receiveShadow = true
    return mesh
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

  private directDir: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 }

  /** 每帧直射光分发：光色/强度/方位 + 阴影配置;enabled=false 或强度≈0 → 灯灭关阴影 */
  setDirectLight(direct: ResolvedPalette['direct'], shadowCfg: ShadowConfig, ambientLift: number): void {
    if (!this.three || !this.directLight || !this.ambientLight) return
    this.directDir = direct.dir
    this.ambientLight.intensity = ambientLift
    const light = this.directLight
    light.color.setRGB(direct.color[0], direct.color[1], direct.color[2])
    light.intensity = direct.intensity
    if (this.three.shadowMap.enabled !== shadowCfg.enabled) {
      this.three.shadowMap.enabled = shadowCfg.enabled
      // 运行时切换阴影管线需要重编译材质
      this.opaqueMaterial.needsUpdate = true
      this.translucentMaterial.needsUpdate = true
    }
    light.castShadow = shadowCfg.enabled && direct.intensity > 0.001
    const mapSize = this.softwareGL ? shadowCfg.softwareMapSize : shadowCfg.mapSize
    if (light.shadow.mapSize.x !== mapSize) {
      light.shadow.mapSize.set(mapSize, mapSize)
      light.shadow.map?.dispose()
      light.shadow.map = null
    }
    light.shadow.bias = shadowCfg.bias
    light.shadow.normalBias = shadowCfg.normalBias
    light.shadow.radius = shadowCfg.radius
  }

  /** 阴影正交相机跟随注视点,边长随缩放距离伸缩(单级,spec 明确不做 CSM) */
  private updateShadowCamera(focus: { target: { x: number; y: number; z: number }; distance: number }): void {
    const light = this.directLight
    if (!light || !light.castShadow) return
    const dir = this.directDir
    const extent = Math.min(120, Math.max(40, focus.distance))
    light.position.set(
      focus.target.x + dir.x * 100,
      focus.target.y + dir.y * 100,
      focus.target.z + dir.z * 100,
    )
    light.target.position.set(focus.target.x, focus.target.y, focus.target.z)
    const cam = light.shadow.camera
    cam.left = -extent; cam.right = extent; cam.top = extent; cam.bottom = -extent
    cam.near = 1; cam.far = 400
    cam.updateProjectionMatrix()
  }

  renderFrame(dt: number, camera: THREE.Camera, focus?: { target: { x: number; y: number; z: number }; distance: number }): void {
    if (!this.three) return
    this.sky?.follow(camera)
    if (focus) this.updateShadowCamera(focus)
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
    this.directLight?.shadow.map?.dispose()
    this.directLight = null
    this.ambientLight = null
    this.post?.dispose()
    this.post = null
    this.opaqueMaterial.dispose()
    this.translucentMaterial.dispose()
    this.three?.dispose()
    this.three = null
  }
}
