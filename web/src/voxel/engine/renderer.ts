import * as THREE from 'three'
import type { SectionKey } from '@possibility/voxel-contract'
import type { TextureAtlas } from './atlas'
import type { SectionGeometry } from './mesher'
import { isSoftwareGL, PostPipeline } from './post'
import type { ResolvedPalette, RGB, ShadowConfig } from './palette'
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
  /** 浅水/俯视主色（色彩中枢每帧写入） */
  uWaterShallow: { value: THREE.Color }
  /** 深水色 */
  uWaterDeep: { value: THREE.Color }
  /** 岸边白沫色 */
  uFoamColor: { value: THREE.Color }
  /** 天空反射色（每帧由 resolved.sky zenith/horizon 现算） */
  uSkyReflect: { value: THREE.Color }
}

/** 植被摇摆：按 aSway 权重在水平面微位移 */
function injectSway(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: ShaderUniforms): void {
  shader.uniforms.uTime = uniforms.uTime
  shader.uniforms.uMotion = uniforms.uMotion
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nattribute float aSway;\nuniform float uTime;\nuniform float uMotion;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n{\n  float phase = uTime * 1.6 + position.x * 0.8 + position.z * 0.6;\n  transformed.x += sin(phase) * 0.06 * aSway * uMotion;\n  transformed.z += cos(phase * 0.83) * 0.045 * aSway * uMotion;\n}`)
}

/**
 * 水面效果（S3a）：UV 扰动（沿用）+ 波纹顶点扰动 + Fresnel 天空反射 + 岸边白沫。
 * 全部乘 aWater 门控，非水流体（玻璃等）零影响；动画分量乘 uMotion 走降级约定。
 */
function injectWater(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: ShaderUniforms): void {
  shader.uniforms.uTime = uniforms.uTime
  shader.uniforms.uMotion = uniforms.uMotion
  shader.uniforms.uWaterShallow = uniforms.uWaterShallow
  shader.uniforms.uWaterDeep = uniforms.uWaterDeep
  shader.uniforms.uFoamColor = uniforms.uFoamColor
  shader.uniforms.uSkyReflect = uniforms.uSkyReflect
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
attribute float aWater;
attribute float aFoam;
uniform float uTime;
uniform float uMotion;
varying float vWater;
varying float vFoam;
varying float vWaterTop;
varying vec3 vWaterWorld;
varying vec3 vWaterViewNormal;
varying vec3 vWaterViewPos;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
vWater = aWater;
vFoam = aFoam;
vWaterTop = aWater * step(0.5, normal.y);
vWaterWorld = position;
{
  // 波纹起伏：仅水面顶面顶点，克制振幅（风格化）
  float wave = sin(uTime * 1.4 + position.x * 2.1 + position.z * 1.7);
  transformed.y += wave * 0.03 * vWaterTop * uMotion;
}`)
    .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
vWaterViewNormal = normalize(transformedNormal);`)
    .replace('#include <project_vertex>', `#include <project_vertex>
vWaterViewPos = -mvPosition.xyz;`)
    .replace('#include <uv_vertex>', `#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv += vec2(sin(uTime * 1.2 + position.x * 1.7 + position.z), cos(uTime * 0.9 + position.z * 1.3)) * 0.015 * aWater * uMotion;\n#endif`)
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform float uTime;
uniform float uMotion;
uniform vec3 uWaterShallow;
uniform vec3 uWaterDeep;
uniform vec3 uFoamColor;
uniform vec3 uSkyReflect;
varying float vWater;
varying float vFoam;
varying float vWaterTop;
varying vec3 vWaterWorld;
varying vec3 vWaterViewNormal;
varying vec3 vWaterViewPos;`)
    .replace('#include <map_fragment>', `#include <map_fragment>
if (vWater > 0.5) {
  // 在 color_fragment(烘焙光照)之前替换水色：昼夜明暗/面明暗对白沫与反射同样生效
  // Fresnel 天空反射（风格化指数 2）：平视反射多、俯视水色多
  vec3 waterView = normalize(vWaterViewPos);
  float fresnel = pow(1.0 - max(dot(waterView, normalize(vWaterViewNormal)), 0.0), 2.0);
  vec3 waterBase = mix(uWaterDeep, uWaterShallow, vWaterTop);
  vec3 waterFinal = mix(waterBase, uSkyReflect, fresnel * 0.65);
  // 贴图亮度保留为水纹细节，色相由色彩中枢接管
  float texLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = waterFinal * (0.55 + 0.9 * texLum);
  // 岸边白沫：空间斑驳 × 时间聚散（uMotion=0 时定格静态斑驳），开阔水面 vFoam=0 零影响
  float foamN = 0.5 + 0.5 * sin(vWaterWorld.x * 5.3 + vWaterWorld.z * 4.7);
  float foamT = 0.5 + 0.5 * sin(uTime * 2.0 * uMotion + vWaterWorld.x * 3.1 + vWaterWorld.z * 2.3);
  float foamAmt = smoothstep(0.45, 0.85, foamN * 0.5 + foamT * 0.5) * 0.85 * vFoam;
  diffuseColor.rgb = mix(diffuseColor.rgb, uFoamColor, foamAmt);
}`)
}

/** three.js 场景装配：节几何管理、天空穹顶、雾、直射光阴影、后处理、不透明/透明双渲染层 */
export class VoxelRenderer {
  readonly scene = new THREE.Scene()
  private three: THREE.WebGLRenderer | null = null
  private sectionMeshes = new Map<SectionKey, { opaque: THREE.Mesh | null; translucent: THREE.Mesh | null }>()
  private opaqueMaterial: THREE.MeshLambertMaterial
  private translucentMaterial: THREE.MeshLambertMaterial
  readonly shaderUniforms: ShaderUniforms = {
    uTime: { value: 0 },
    uMotion: { value: 1 },
    // 初值黑：每帧由 applyPalette 从色彩中枢写入（N3 零字面量纪律）
    uWaterShallow: { value: new THREE.Color() },
    uWaterDeep: { value: new THREE.Color() },
    uFoamColor: { value: new THREE.Color() },
    uSkyReflect: { value: new THREE.Color() },
  }
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
    this.three.shadowMap.type = THREE.PCFShadowMap // PCFSoft 已在 r186 移除;radius 柔化由 shadow.radius 承担
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
    geometry.setAttribute('aFoam', new THREE.BufferAttribute(data.foam, 1))
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

  setSkyVisible(visible: boolean): void {
    this.sky?.setVisible(visible)
  }

  get skyVisible(): boolean {
    return this.sky?.visible ?? false
  }

  /** 环境雾在外景/室内均保留；天空穹顶由空间上下文单独控制。 */
  setEnvironment(env: EnvironmentState): void {
    // 雾色兜底：穹顶未覆盖/失败时背景与雾一致，不出现断层
    this.scene.background = new THREE.Color(env.fogColor)
    const fog = this.scene.fog as THREE.FogExp2
    fog.color = new THREE.Color(env.fogColor)
    fog.density = env.fogDensity
  }

  /** 每帧写水体 uniforms（色彩中枢 → shader；skyReflect 由引擎从 resolved.sky 现算） */
  setWaterUniforms(water: ResolvedPalette['water'], skyReflect: THREE.Color): void {
    this.shaderUniforms.uWaterShallow.value.setRGB(...water.shallow)
    this.shaderUniforms.uWaterDeep.value.setRGB(...water.deep)
    this.shaderUniforms.uFoamColor.value.setRGB(...water.foam)
    this.shaderUniforms.uSkyReflect.value.copy(skyReflect)
  }

  /** 入水时切换雾色/密度（背景同步兜底，天空穹 fog:false 天然不受影响） */
  setUnderwaterFog(color: RGB, density: number): void {
    this.setEnvironment({ fogColor: new THREE.Color(...color), fogDensity: density })
  }

  private directDir: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 }

  /** 每帧直射光分发：光色/强度/方位 + 阴影配置;enabled=false 或强度≈0 → 灯灭关阴影 */
  setDirectLight(direct: ResolvedPalette['direct'], shadowCfg: ShadowConfig, ambientLift: number, ambientScale = 1): void {
    if (!this.three || !this.directLight || !this.ambientLight) return
    this.directDir = direct.dir
    const light = this.directLight
    light.color.setRGB(direct.color[0], direct.color[1], direct.color[2])
    light.intensity = direct.intensity
    // 环境光基底：阴影开启时按 ambientScale 压低，给直射光让出明暗差余量（否则阴影被削顶抹平）;
    // 阴影关闭/直射熄灭时回满 ambientLift → N1「关阴影=S1 观感」
    this.ambientLight.intensity = ambientLift * ambientScale * (shadowCfg.enabled && direct.intensity > 0.001 ? shadowCfg.ambientScale : 1)
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
